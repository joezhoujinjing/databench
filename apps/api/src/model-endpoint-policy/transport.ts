import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import type {
  V2ModelDeploymentHealthClient,
  V2ModelDeploymentHealthRequest,
} from '@databench/workspace'
import ipaddr from 'ipaddr.js'
import type { Dispatcher } from 'undici'
import { buildConnector, Client } from 'undici'
import type { ModelCredentialSnapshotV1 } from '../model-credentials/registry.js'
import {
  type AuthorizedModelEndpointV1,
  ModelEndpointPolicyError,
  type ModelEndpointPolicyV1Runtime,
} from './policy.js'

const MAX_HEADER_BYTES = 32 * 1024
const MAX_COMPRESSED_BYTES = 128 * 1024
const MAX_DECOMPRESSED_BYTES = 256 * 1024
const MAX_JSON_NODES = 10_000
const MAX_JSON_DEPTH = 16
const MAX_MODELS = 1_000

export interface ModelEndpointTransportTimeoutsV1 {
  readonly connectMs: number
  readonly headersMs: number
  readonly bodyMs: number
  readonly totalMs: number
}

export interface ModelEndpointTransportV1Options {
  readonly policy: ModelEndpointPolicyV1Runtime
  readonly timeouts?: Partial<ModelEndpointTransportTimeoutsV1>
}

const DEFAULT_TIMEOUTS: Readonly<ModelEndpointTransportTimeoutsV1> = Object.freeze({
  connectMs: 2_000,
  headersMs: 3_000,
  bodyMs: 3_000,
  totalMs: 5_000,
})

export class ModelEndpointTransportError extends Error {
  readonly code: string

  constructor(code: string, message = 'Model endpoint transport rejected the response') {
    super(message)
    this.name = 'ModelEndpointTransportError'
    this.code = code
  }
}

export class PinnedModelEndpointTransportV1 {
  readonly #policy: ModelEndpointPolicyV1Runtime
  readonly #timeouts: Readonly<ModelEndpointTransportTimeoutsV1>

  constructor(options: ModelEndpointTransportV1Options) {
    this.#policy = options.policy
    this.#timeouts = Object.freeze({
      connectMs: positiveTimeout(options.timeouts?.connectMs ?? DEFAULT_TIMEOUTS.connectMs),
      headersMs: positiveTimeout(options.timeouts?.headersMs ?? DEFAULT_TIMEOUTS.headersMs),
      bodyMs: positiveTimeout(options.timeouts?.bodyMs ?? DEFAULT_TIMEOUTS.bodyMs),
      totalMs: positiveTimeout(options.timeouts?.totalMs ?? DEFAULT_TIMEOUTS.totalMs),
    })
    if (
      this.#timeouts.totalMs < this.#timeouts.connectMs ||
      this.#timeouts.totalMs < this.#timeouts.headersMs ||
      this.#timeouts.totalMs < this.#timeouts.bodyMs
    ) {
      throw new TypeError('Model endpoint total timeout must cover every phase timeout')
    }
  }

  async discoverModels(
    endpointBaseUrl: string,
    options: {
      readonly scope: 'private_network' | 'public_network'
      readonly credential?: ModelCredentialSnapshotV1
      readonly signal?: AbortSignal
    },
  ): Promise<readonly string[]> {
    const modelsUrl = modelsDiscoveryUrl(endpointBaseUrl)
    const authorized = await this.#policy.authorize(modelsUrl.href, options.scope)
    const timeoutSignal = AbortSignal.timeout(this.#timeouts.totalMs)
    const signal =
      options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal])
    const client = createPinnedClient(authorized, this.#timeouts)
    let failed = true
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'accept-encoding': 'gzip, deflate, br',
      }
      if (options.credential !== undefined) {
        headers.authorization = options.credential.authorizationHeader()
      }
      const response = await requestThroughHeaderDeadline(
        client,
        {
          method: 'GET',
          path: `${authorized.url.pathname}${authorized.url.search}`,
          headers,
        },
        signal,
        this.#timeouts.headersMs,
      )
      assertResponseHeaders(response.headers)
      if (
        response.statusCode < 200 ||
        response.statusCode >= 300 ||
        response.headers.location !== undefined
      ) {
        await response.body.dump()
        throw new ModelEndpointTransportError(
          response.statusCode >= 300 && response.statusCode < 400
            ? 'model_endpoint_redirect_rejected'
            : 'model_endpoint_http_error',
        )
      }
      assertJsonMediaType(response.headers['content-type'])
      const compressed = await readBoundedBody(
        response.body,
        MAX_COMPRESSED_BYTES,
        signal,
        this.#timeouts.bodyMs,
      )
      const decoded = decodeResponseBody(
        compressed,
        headerValue(response.headers['content-encoding']),
      )
      const value = parseBoundedJson(decoded)
      const models = parseOpenAiModelIds(value)
      failed = false
      return models
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (timeoutSignal.aborted) {
        throw new ModelEndpointTransportError('model_endpoint_timeout')
      }
      if (
        error instanceof ModelEndpointTransportError ||
        error instanceof ModelEndpointPolicyError
      ) {
        throw error
      }
      throw new ModelEndpointTransportError('model_endpoint_network_error')
    } finally {
      if (failed) {
        await client.destroy().catch(() => undefined)
      } else {
        await client.close().catch(() => client.destroy())
      }
    }
  }
}

async function requestThroughHeaderDeadline(
  client: Client,
  request: Omit<Dispatcher.RequestOptions, 'origin'>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Dispatcher.ResponseData> {
  const headerDeadline = new AbortController()
  const timer = setTimeout(
    () => headerDeadline.abort(new ModelEndpointTransportError('model_endpoint_timeout')),
    timeoutMs,
  )
  try {
    return await client.request({
      ...request,
      signal: AbortSignal.any([signal, headerDeadline.signal]),
    })
  } catch (error) {
    if (headerDeadline.signal.aborted && !signal.aborted) {
      throw new ModelEndpointTransportError('model_endpoint_timeout')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function createPinnedModelDeploymentHealthClientV2(
  transport: PinnedModelEndpointTransportV1,
): V2ModelDeploymentHealthClient {
  return Object.freeze({
    async observe(
      request: Readonly<V2ModelDeploymentHealthRequest>,
      context: { readonly signal?: AbortSignal } = {},
    ) {
      try {
        const models = await transport.discoverModels(request.endpointBaseUrl, {
          scope: 'private_network',
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        return models.includes(request.servedModelName)
          ? Object.freeze({ status: 'healthy' as const, error: null })
          : Object.freeze({ status: 'unhealthy' as const, error: 'served_model_missing' })
      } catch (error) {
        if (context.signal?.aborted) throw error
        return Object.freeze({
          status: 'unhealthy' as const,
          error: healthErrorCode(error),
        })
      }
    },
  })
}

function createPinnedClient(
  endpoint: Readonly<AuthorizedModelEndpointV1>,
  timeouts: Readonly<ModelEndpointTransportTimeoutsV1>,
): Client {
  const approved = new Set(endpoint.addresses)
  const address = endpoint.addresses[0]
  if (address === undefined) throw new ModelEndpointTransportError('model_endpoint_dns_rejected')
  const baseConnector = buildConnector({ timeout: timeouts.connectMs })
  const connect: NonNullable<ConstructorParameters<typeof Client>[1]>['connect'] = (
    options,
    callback,
  ) => {
    baseConnector(
      {
        ...options,
        hostname: address,
        host: address,
        servername: endpoint.hostname,
      },
      (error, socket) => {
        if (error !== null || socket === null) {
          callback(error, null)
          return
        }
        const remote = socket.remoteAddress
        if (!isApprovedModelEndpointRemoteAddressV1(remote, approved)) {
          socket.destroy()
          callback(new Error('Model endpoint socket connected to an unapproved address'), null)
          return
        }
        callback(null, socket)
      },
    )
  }
  const origin = `${endpoint.url.protocol}//${endpoint.url.host}`
  return new Client(origin, {
    connect,
    headersTimeout: timeouts.headersMs,
    bodyTimeout: timeouts.bodyMs,
    maxHeaderSize: MAX_HEADER_BYTES,
    maxResponseSize: MAX_COMPRESSED_BYTES,
    pipelining: 1,
  })
}

function modelsDiscoveryUrl(endpointBaseUrl: string): URL {
  let url: URL
  try {
    url = new URL(endpointBaseUrl)
  } catch {
    throw new ModelEndpointPolicyError('model_endpoint_url_rejected')
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models`
  return url
}

function assertResponseHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): void {
  let total = 0
  for (const [name, rawValue] of Object.entries(headers)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    for (const value of values) {
      if (
        value === undefined ||
        value.includes('\r') ||
        value.includes('\n') ||
        value.includes('\0')
      ) {
        throw new ModelEndpointTransportError('model_endpoint_invalid_response')
      }
      total += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
    }
  }
  if (total > MAX_HEADER_BYTES) {
    throw new ModelEndpointTransportError('model_endpoint_invalid_response')
  }
}

function assertJsonMediaType(value: string | string[] | undefined): void {
  const contentType = headerValue(value).split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new ModelEndpointTransportError('model_endpoint_invalid_response')
  }
}

async function readBoundedBody(
  body: Dispatcher.ResponseData['body'],
  maxBytes: number,
  signal: AbortSignal,
  bodyTimeoutMs: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  const iterator = body[Symbol.asyncIterator]()
  while (true) {
    signal.throwIfAborted()
    const result = await raceBodyChunk(iterator.next(), bodyTimeoutMs)
    if (result.done) break
    const chunk = result.value
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += bytes.byteLength
    if (total > maxBytes) {
      throw new ModelEndpointTransportError('model_endpoint_invalid_response')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}

async function raceBodyChunk<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ModelEndpointTransportError('model_endpoint_timeout')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function decodeResponseBody(input: Uint8Array, encoding: string): Uint8Array {
  try {
    const options = { maxOutputLength: MAX_DECOMPRESSED_BYTES }
    const output =
      encoding === '' || encoding === 'identity'
        ? input
        : encoding === 'gzip'
          ? gunzipSync(input, options)
          : encoding === 'deflate'
            ? inflateSync(input, options)
            : encoding === 'br'
              ? brotliDecompressSync(input, options)
              : null
    if (output === null || output.byteLength > MAX_DECOMPRESSED_BYTES) {
      throw new Error('unsupported or oversized response encoding')
    }
    return output
  } catch {
    throw new ModelEndpointTransportError('model_endpoint_invalid_response')
  }
}

function parseBoundedJson(bytes: Uint8Array): unknown {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ModelEndpointTransportError('model_endpoint_invalid_response')
  }
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    nodes += 1
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new ModelEndpointTransportError('model_endpoint_invalid_response')
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 })
    } else if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
  return value
}

function parseOpenAiModelIds(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelEndpointTransportError('model_endpoint_invalid_response')
  }
  const data = (value as { readonly data?: unknown }).data
  if (!Array.isArray(data) || data.length > MAX_MODELS) {
    throw new ModelEndpointTransportError('model_endpoint_invalid_response')
  }
  const ids: string[] = []
  for (const item of data) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ModelEndpointTransportError('model_endpoint_invalid_response')
    }
    const id = (item as { readonly id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id) > 512) {
      throw new ModelEndpointTransportError('model_endpoint_invalid_response')
    }
    if (!ids.includes(id)) ids.push(id)
  }
  return Object.freeze(ids)
}

function canonicalSocketAddress(value: string): string {
  try {
    const parsed = ipaddr.parse(value)
    return parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
      ? parsed.toIPv4Address().toString()
      : parsed instanceof ipaddr.IPv6
        ? parsed.toRFC5952String()
        : parsed.toString()
  } catch {
    return ''
  }
}

export function isApprovedModelEndpointRemoteAddressV1(
  remoteAddress: string | undefined,
  approvedAddresses: ReadonlySet<string>,
): boolean {
  return remoteAddress !== undefined && approvedAddresses.has(canonicalSocketAddress(remoteAddress))
}

function headerValue(value: string | string[] | undefined): string {
  if (value === undefined) return ''
  return Array.isArray(value) ? value.join(',') : value
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new TypeError('Model endpoint timeout must be a positive safe integer at most 60000')
  }
  return value
}

function healthErrorCode(error: unknown): string {
  if (error instanceof ModelEndpointTransportError) {
    if (error.code === 'model_endpoint_timeout') return 'timeout'
    if (
      error.code === 'model_endpoint_http_error' ||
      error.code === 'model_endpoint_redirect_rejected'
    ) {
      return 'http_error'
    }
    if (error.code === 'model_endpoint_network_error') return 'network_error'
    return 'invalid_response'
  }
  return error instanceof ModelEndpointPolicyError ? 'network_error' : 'network_error'
}
