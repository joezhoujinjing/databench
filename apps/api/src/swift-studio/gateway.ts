import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiEnv } from '../context.js'
import {
  findSwiftStudioRoute,
  SWIFT_STUDIO_RUNTIME_PREFIX,
  type SwiftStudioGatewayConfig,
} from './config.js'

const REQUEST_BODY_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT'])
const STREAMING_ROUTE_CLASSIFICATIONS = new Set([
  'file-or-download',
  'queue',
  'upload',
  'websocket-or-stream',
])
const HTML_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'location',
])

class RequestCapacity {
  private active = 0

  constructor(private readonly maximum: number) {}

  acquire(): (() => void) | undefined {
    if (this.active >= this.maximum) return undefined
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
    }
  }
}

export interface RegisterSwiftStudioGatewayOptions {
  readonly config: SwiftStudioGatewayConfig
  readonly fetch?: typeof fetch
}

export function registerSwiftStudioGateway(
  app: OpenAPIHono<ApiEnv>,
  options: RegisterSwiftStudioGatewayOptions,
): void {
  if (!options.config.enabled) return
  if (
    options.config.internalBaseUrl === undefined ||
    options.config.providerBaseUrl === undefined
  ) {
    throw new TypeError('Enabled Swift Studio gateway requires Gradio and Provider origins')
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const requestCapacity = new RequestCapacity(options.config.maxConcurrentRequests)
  const handler = (context: Context<ApiEnv>) =>
    proxySwiftStudio(context, options.config, fetchImplementation, requestCapacity)
  app.all(options.config.proxyPrefix, handler)
  app.all(`${options.config.proxyPrefix}/*`, handler)
  app.get(`${SWIFT_STUDIO_RUNTIME_PREFIX}/health`, (context) =>
    proxyProviderJson(context, '/health', options.config, fetchImplementation),
  )
  app.get(`${SWIFT_STUDIO_RUNTIME_PREFIX}/runtime`, (context) =>
    proxyProviderJson(context, '/runtime', options.config, fetchImplementation),
  )
}

async function proxySwiftStudio(
  context: Context<ApiEnv>,
  config: SwiftStudioGatewayConfig,
  fetchImplementation: typeof fetch,
  requestCapacity: RequestCapacity,
): Promise<Response> {
  const requestUrl = new URL(context.req.url)
  const upstreamPath = stripProxyPrefix(requestUrl.pathname, config.proxyPrefix)
  if (upstreamPath === null) return gatewayError(context, 404, 'not_found', 'Route not found')
  const route = findSwiftStudioRoute(config.routes, context.req.method, upstreamPath)
  if (route === undefined) {
    return gatewayError(
      context,
      404,
      'swift_studio_route_rejected',
      'Swift Studio route is outside the locked Gradio manifest',
    )
  }
  if (context.req.method === 'WEBSOCKET') {
    return gatewayError(
      context,
      426,
      'upgrade_required',
      'Swift Studio WebSocket requires an HTTP Upgrade request',
    )
  }
  const contentLength = parseContentLength(context.req.header('content-length'))
  if (contentLength !== undefined && contentLength > config.requestMaxBytes) {
    return gatewayError(
      context,
      413,
      'request_too_large',
      'Swift Studio request exceeds its configured byte boundary',
    )
  }
  const hasBody = context.req.raw.body !== null
  if (hasBody && !REQUEST_BODY_METHODS.has(context.req.method)) {
    return gatewayError(
      context,
      400,
      'unexpected_request_body',
      'Swift Studio route does not accept a request body',
    )
  }

  const target = new URL(config.internalBaseUrl as string)
  target.pathname = upstreamPath
  target.search = requestUrl.search
  const headers = requestHeaders(context)
  const timeout = STREAMING_ROUTE_CLASSIFICATIONS.has(route.classification)
    ? config.streamTimeoutMs
    : config.timeoutMs
  const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(timeout)])
  const body =
    hasBody && context.req.raw.body !== null
      ? boundedStream(context.req.raw.body, config.requestMaxBytes)
      : undefined
  const releaseCapacity = requestCapacity.acquire()
  if (releaseCapacity === undefined) {
    return gatewayError(
      context,
      429,
      'swift_studio_capacity_exceeded',
      'Swift Studio gateway request capacity is exhausted',
    )
  }
  let upstream: Response
  try {
    upstream = await fetchImplementation(target, {
      method: context.req.method,
      headers,
      redirect: 'manual',
      signal,
      ...(body === undefined ? {} : { body, duplex: 'half' }),
    } as RequestInit & { duplex?: 'half' })
  } catch (error) {
    releaseCapacity()
    const tooLarge = error instanceof StreamLimitError
    return gatewayError(
      context,
      tooLarge ? 413 : 503,
      tooLarge ? 'request_too_large' : 'swift_studio_unavailable',
      tooLarge
        ? 'Swift Studio request exceeds its configured byte boundary'
        : 'Swift Studio is unavailable',
    )
  }
  const responseLength = parseContentLength(upstream.headers.get('content-length') ?? undefined)
  if (responseLength !== undefined && responseLength > config.responseMaxBytes) {
    void upstream.body?.cancel().catch(() => undefined)
    releaseCapacity()
    return gatewayError(
      context,
      502,
      'swift_studio_response_too_large',
      'Swift Studio response exceeds its configured byte boundary',
    )
  }
  const responseHeaders = new Headers()
  for (const [name, value] of upstream.headers) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.append(name, value)
  }
  const location = responseHeaders.get('location')
  if (location !== null) {
    responseHeaders.set(
      'location',
      rewriteLocation(location, config.internalBaseUrl as string, config.proxyPrefix),
    )
  }
  responseHeaders.delete('content-encoding')
  responseHeaders.set('x-content-type-options', 'nosniff')
  responseHeaders.set('referrer-policy', 'same-origin')
  const mediaType = responseHeaders.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  let rewrittenHtml: Uint8Array | undefined
  if (mediaType === 'text/html') {
    responseHeaders.set('content-security-policy', "frame-ancestors 'self'")
    responseHeaders.set('x-frame-options', 'SAMEORIGIN')
    responseHeaders.set('cache-control', 'private, no-store')
    if (upstreamPath === '/' && context.req.method !== 'HEAD') {
      const bytes = await readBounded(
        upstream,
        Math.min(config.responseMaxBytes, HTML_DOCUMENT_MAX_BYTES),
      )
      if (bytes === null) {
        releaseCapacity()
        return gatewayError(
          context,
          502,
          'swift_studio_response_invalid',
          'Swift Studio document exceeded its compatibility boundary',
        )
      }
      try {
        rewrittenHtml = rewriteRootDocument(bytes)
      } catch {
        releaseCapacity()
        return gatewayError(
          context,
          502,
          'swift_studio_response_invalid',
          'Swift Studio document could not be decoded',
        )
      }
      responseHeaders.set('content-length', String(rewrittenHtml.byteLength))
    }
  }
  const responseBody =
    context.req.method === 'HEAD' || upstream.body === null
      ? null
      : rewrittenHtml === undefined
        ? boundedStream(upstream.body, config.responseMaxBytes)
        : exactArrayBuffer(rewrittenHtml)
  return releaseWithResponse(
    new Response(responseBody, {
      status: upstream.status,
      headers: responseHeaders,
    }),
    releaseCapacity,
  )
}

function rewriteRootDocument(bytes: Uint8Array): Uint8Array {
  const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return new TextEncoder().encode(html.replace(/<link\s+rel=["']manifest["'][^>]*>/iu, ''))
}

async function proxyProviderJson(
  context: Context<ApiEnv>,
  path: '/health' | '/runtime',
  config: SwiftStudioGatewayConfig,
  fetchImplementation: typeof fetch,
): Promise<Response> {
  const target = new URL(path, config.providerBaseUrl)
  let upstream: Response
  try {
    upstream = await fetchImplementation(target, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.any([
        context.req.raw.signal,
        AbortSignal.timeout(Math.min(config.timeoutMs, 10_000)),
      ]),
    })
  } catch {
    return gatewayError(
      context,
      503,
      'swift_studio_unavailable',
      'Swift Studio Provider is unavailable',
    )
  }
  const mediaType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    void upstream.body?.cancel().catch(() => undefined)
    return gatewayError(
      context,
      502,
      'swift_studio_response_invalid',
      'Swift Studio Provider returned an invalid response',
    )
  }
  const bytes = await readBounded(upstream, 1024 * 1024)
  if (bytes === null) {
    return gatewayError(
      context,
      502,
      'swift_studio_response_invalid',
      'Swift Studio Provider response exceeded its boundary',
    )
  }
  return new Response(exactArrayBuffer(bytes), {
    status: upstream.status,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
    },
  })
}

function requestHeaders(context: Context<ApiEnv>): Headers {
  const headers = new Headers()
  for (const [name, value] of context.req.raw.headers) {
    const normalized = name.toLowerCase()
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      normalized === 'authorization' ||
      normalized === 'cookie' ||
      normalized === 'content-length' ||
      normalized === 'host'
    ) {
      continue
    }
    headers.append(name, value)
  }
  const requestUrl = new URL(context.req.url)
  headers.set('accept-encoding', 'identity')
  headers.set(
    'x-forwarded-host',
    validForwardedHost(context.req.raw.headers.get('x-forwarded-host')) ?? requestUrl.host,
  )
  headers.set('x-forwarded-prefix', '/swift-studio')
  headers.set(
    'x-forwarded-proto',
    validForwardedProto(context.req.raw.headers.get('x-forwarded-proto')) ??
      requestUrl.protocol.replace(':', ''),
  )
  return headers
}

function validForwardedProto(value: string | null | undefined): 'http' | 'https' | undefined {
  return value === 'http' || value === 'https' ? value : undefined
}

function validForwardedHost(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value.includes(',') || /[\r\n]/u.test(value)) {
    return undefined
  }
  try {
    const parsed = new URL(`http://${value}`)
    return parsed.username === '' && parsed.password === '' && parsed.host === value
      ? value
      : undefined
  } catch {
    return undefined
  }
}

export function stripProxyPrefix(pathname: string, prefix: string): string | null {
  if (pathname === prefix || pathname === `${prefix}/`) return '/'
  if (!pathname.startsWith(`${prefix}/`)) return null
  return pathname.slice(prefix.length)
}

function rewriteLocation(location: string, internalBaseUrl: string, prefix: string): string {
  let parsed: URL
  try {
    parsed = new URL(location, internalBaseUrl)
  } catch {
    return prefix
  }
  if (parsed.origin !== new URL(internalBaseUrl).origin) return prefix
  const pathname = parsed.pathname.startsWith(`${prefix}/`)
    ? parsed.pathname
    : parsed.pathname === prefix
      ? prefix
      : `${prefix}${parsed.pathname.startsWith('/') ? '' : '/'}${parsed.pathname}`
  return `${pathname}${parsed.search}${parsed.hash}`
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

class StreamLimitError extends Error {}

function boundedStream(
  source: ReadableStream<Uint8Array>,
  maximumBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (!Number.isSafeInteger(total) || total > maximumBytes) {
          controller.error(new StreamLimitError('stream exceeds configured byte boundary'))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

function releaseWithResponse(response: Response, release: () => void): Response {
  if (response.body === null) {
    release()
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        release()
      }
    },
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        release()
        controller.error(error)
      }
    },
  })
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

function gatewayError(
  context: Context<ApiEnv>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  return context.json({ error: { code, message } }, status)
}
