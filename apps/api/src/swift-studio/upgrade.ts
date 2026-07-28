import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { connect, type Socket } from 'node:net'
import { findSwiftStudioRoute, type SwiftStudioGatewayConfig } from './config.js'
import { stripProxyPrefix } from './gateway.js'

const MAX_REQUEST_TARGET_BYTES = 8192
const MAX_UPSTREAM_HANDSHAKE_BYTES = 64 * 1024
const FORWARDED_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'content-length',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-prefix',
  'x-forwarded-proto',
])

export interface SwiftStudioUpgradeProxy {
  close(): void
}

export function attachSwiftStudioUpgradeProxy(
  server: HttpServer,
  config: SwiftStudioGatewayConfig,
): SwiftStudioUpgradeProxy {
  if (!config.enabled) return { close() {} }
  if (config.internalBaseUrl === undefined) {
    throw new TypeError('Enabled Swift Studio WebSocket proxy requires a Gradio origin')
  }

  const activeSockets = new Set<Socket>()
  const activeClients = new Set<Socket>()
  const onUpgrade = (request: IncomingMessage, client: Socket, head: Buffer): void => {
    proxyUpgrade(request, client, head, config, activeSockets, activeClients)
  }
  server.on('upgrade', onUpgrade)

  let closed = false
  return {
    close() {
      if (closed) return
      closed = true
      server.off('upgrade', onUpgrade)
      for (const socket of activeSockets) socket.destroy()
      activeSockets.clear()
      activeClients.clear()
    },
  }
}

function proxyUpgrade(
  request: IncomingMessage,
  client: Socket,
  head: Buffer,
  config: SwiftStudioGatewayConfig,
  activeSockets: Set<Socket>,
  activeClients: Set<Socket>,
): void {
  const requestTarget = request.url
  if (
    requestTarget === undefined ||
    Buffer.byteLength(requestTarget, 'utf8') > MAX_REQUEST_TARGET_BYTES
  ) {
    rejectUpgrade(client, 414, 'URI Too Long')
    return
  }

  let publicUrl: URL
  try {
    publicUrl = new URL(requestTarget, 'http://databench.invalid')
  } catch {
    rejectUpgrade(client, 400, 'Bad Request')
    return
  }
  const upstreamPath = stripProxyPrefix(publicUrl.pathname, config.proxyPrefix)
  if (upstreamPath === null) {
    rejectUpgrade(client, 404, 'Not Found')
    return
  }
  if (
    request.method !== 'GET' ||
    request.headers.upgrade?.toLowerCase() !== 'websocket' ||
    findSwiftStudioRoute(config.routes, 'WEBSOCKET', upstreamPath) === undefined
  ) {
    rejectUpgrade(client, 404, 'Not Found')
    return
  }
  if (activeClients.size >= config.maxWebSocketConnections) {
    rejectUpgrade(client, 429, 'Too Many Requests')
    return
  }

  const target = new URL(config.internalBaseUrl as string)
  const upstream = connect({
    host: target.hostname,
    port: Number(target.port || '80'),
  })
  activeSockets.add(client)
  activeSockets.add(upstream)
  activeClients.add(client)
  let handshakeComplete = false
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined
  const clearHandshakeTimer = (): void => {
    if (handshakeTimer !== undefined) clearTimeout(handshakeTimer)
    handshakeTimer = undefined
  }
  const removeSockets = (): void => {
    clearHandshakeTimer()
    activeSockets.delete(client)
    activeSockets.delete(upstream)
    activeClients.delete(client)
  }
  client.once('close', () => {
    removeSockets()
    upstream.destroy()
  })
  upstream.once('close', () => {
    removeSockets()
    client.destroy()
  })
  upstream.once('error', () => {
    if (!handshakeComplete) {
      rejectUpgrade(client, 503, 'Service Unavailable')
    } else {
      client.destroy()
    }
  })
  client.once('error', () => upstream.destroy())

  handshakeTimer = setTimeout(
    () => {
      rejectUpgrade(client, 504, 'Gateway Timeout')
      upstream.destroy()
    },
    Math.min(config.timeoutMs, 30_000),
  )
  upstream.once('connect', () => {
    upstream.setTimeout(config.streamTimeoutMs, () => upstream.destroy())
    upstream.write(
      serializeUpgradeRequest(
        request,
        `${upstreamPath}${publicUrl.search}`,
        target,
        config.proxyPrefix,
      ),
    )
    if (head.byteLength > 0) upstream.write(head)
    client.pipe(upstream)
    forwardUpgradeResponse(
      upstream,
      client,
      () => {
        handshakeComplete = true
        clearHandshakeTimer()
      },
      () => {
        clearHandshakeTimer()
        rejectUpgrade(client, 502, 'Bad Gateway')
        upstream.destroy()
      },
    )
  })
}

function forwardUpgradeResponse(
  upstream: Socket,
  client: Socket,
  onComplete: () => void,
  onFailure: () => void,
): void {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  const onData = (chunk: Buffer): void => {
    buffered = buffered.byteLength === 0 ? chunk : Buffer.concat([buffered, chunk])
    if (buffered.byteLength > MAX_UPSTREAM_HANDSHAKE_BYTES) {
      upstream.off('data', onData)
      onFailure()
      return
    }
    const boundary = buffered.indexOf('\r\n\r\n')
    if (boundary === -1) return
    upstream.off('data', onData)
    let sanitizedHeaders: Buffer
    try {
      sanitizedHeaders = stripSetCookieHeaders(buffered.subarray(0, boundary + 4))
    } catch {
      onFailure()
      return
    }
    client.write(sanitizedHeaders)
    const remainder = buffered.subarray(boundary + 4)
    if (remainder.byteLength > 0) client.write(remainder)
    onComplete()
    upstream.pipe(client)
  }
  upstream.on('data', onData)
}

function stripSetCookieHeaders(headers: Buffer): Buffer {
  const text = headers.toString('latin1')
  if (!text.endsWith('\r\n\r\n')) throw new TypeError('Incomplete upstream handshake')
  const lines = text.slice(0, -4).split('\r\n')
  const statusLine = lines.shift()
  if (statusLine === undefined || !/^HTTP\/1\.[01] [1-5][0-9]{2}(?: |$)/u.test(statusLine)) {
    throw new TypeError('Invalid upstream handshake status')
  }
  const forwarded = [statusLine]
  let strippedPreviousHeader = false
  for (const line of lines) {
    if (/^[ \t]/u.test(line)) {
      if (!strippedPreviousHeader) forwarded.push(line)
      continue
    }
    const separator = line.indexOf(':')
    if (separator <= 0) throw new TypeError('Invalid upstream handshake header')
    strippedPreviousHeader = line.slice(0, separator).trim().toLowerCase() === 'set-cookie'
    if (!strippedPreviousHeader) forwarded.push(line)
  }
  return Buffer.from([...forwarded, '', ''].join('\r\n'), 'latin1')
}

function serializeUpgradeRequest(
  request: IncomingMessage,
  requestTarget: string,
  target: URL,
  proxyPrefix: string,
): string {
  const lines = [`GET ${requestTarget} HTTP/1.1`, `Host: ${target.host}`]
  for (const [name, rawValue] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase()
    if (
      FORWARDED_HEADER_NAMES.has(normalized) ||
      normalized === 'connection' ||
      normalized === 'upgrade' ||
      rawValue === undefined
    ) {
      continue
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    for (const value of values) lines.push(`${name}: ${sanitizeHeaderValue(value)}`)
  }
  const forwardedHost =
    validSingleHeader(request.headers['x-forwarded-host']) ?? request.headers.host ?? ''
  const forwardedProto = validForwardedProto(request.headers['x-forwarded-proto']) ?? 'http'
  lines.push('Connection: Upgrade')
  lines.push('Upgrade: websocket')
  lines.push(`X-Forwarded-Host: ${sanitizeHeaderValue(forwardedHost)}`)
  lines.push(`X-Forwarded-Prefix: ${proxyPrefix}`)
  lines.push(`X-Forwarded-Proto: ${forwardedProto}`)
  lines.push('', '')
  return lines.join('\r\n')
}

function validForwardedProto(value: string | string[] | undefined): 'http' | 'https' | undefined {
  const single = validSingleHeader(value)
  return single === 'http' || single === 'https' ? single : undefined
}

function validSingleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value.includes(',') || /[\r\n]/u.test(value)) return undefined
  return value
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/gu, '')
}

function rejectUpgrade(socket: Socket, status: number, reason: string): void {
  if (socket.destroyed) return
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
