import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  type SwiftStudioGatewayConfig,
  swiftStudioGatewayConfigFromEnv,
} from '../src/swift-studio/config.js'
import { attachSwiftStudioUpgradeProxy } from '../src/swift-studio/upgrade.js'
import { createTestApp } from './test-app.js'

const ROUTES_MANIFEST = fileURLToPath(
  new URL('../../../third_party/ms-swift/gradio-routes.json', import.meta.url),
)
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function config(overrides: Partial<SwiftStudioGatewayConfig> = {}): SwiftStudioGatewayConfig {
  return {
    ...swiftStudioGatewayConfigFromEnv({
      DATABENCH_SWIFT_STUDIO_ENABLED: 'true',
      DATABENCH_SWIFT_STUDIO_DATABENCH_BASE_URL: 'http://api:8000',
      DATABENCH_SWIFT_STUDIO_INTERNAL_BASE_URL: 'http://swift-studio:7860',
      DATABENCH_SWIFT_STUDIO_PROVIDER_BASE_URL: 'http://swift-studio:7861',
      DATABENCH_SWIFT_STUDIO_ROUTES_MANIFEST: ROUTES_MANIFEST,
    }),
    ...overrides,
  }
}

describe('Swift Studio gateway configuration', () => {
  test('is disabled by default and requires private, exact enabled inputs', () => {
    expect(swiftStudioGatewayConfigFromEnv({})).toMatchObject({
      enabled: false,
      imageDigest: '57f2448c3e06985d1989465703f8e4883aee71da40b79be3bdfb70e6dda1f74d',
      proxyPrefix: '/swift-studio',
      routes: [],
    })
    expect(() =>
      swiftStudioGatewayConfigFromEnv({ DATABENCH_SWIFT_STUDIO_ENABLED: 'true' }),
    ).toThrow()
    expect(() =>
      swiftStudioGatewayConfigFromEnv({
        DATABENCH_SWIFT_STUDIO_ENABLED: 'true',
        DATABENCH_SWIFT_STUDIO_DATABENCH_BASE_URL: 'http://api:8000',
        DATABENCH_SWIFT_STUDIO_INTERNAL_BASE_URL: 'https://public.example',
        DATABENCH_SWIFT_STUDIO_PROVIDER_BASE_URL: 'http://swift-studio:7861',
        DATABENCH_SWIFT_STUDIO_ROUTES_MANIFEST: ROUTES_MANIFEST,
      }),
    ).toThrow('private HTTP origin')
    expect(config()).toMatchObject({
      enabled: true,
      imageDigest: '57f2448c3e06985d1989465703f8e4883aee71da40b79be3bdfb70e6dda1f74d',
      internalBaseUrl: 'http://swift-studio:7860',
      maxConcurrentRequests: 64,
      maxWebSocketConnections: 32,
      providerBaseUrl: 'http://swift-studio:7861',
    })
  })

  test('accepts only a raw 64-hex release image digest', () => {
    const imageDigest = 'a'.repeat(64)
    expect(
      swiftStudioGatewayConfigFromEnv({
        DATABENCH_SWIFT_STUDIO_IMAGE_DIGEST: imageDigest,
      }),
    ).toMatchObject({ enabled: false, imageDigest })
    expect(() =>
      swiftStudioGatewayConfigFromEnv({
        DATABENCH_SWIFT_STUDIO_IMAGE_DIGEST: `sha256:${imageDigest}`,
      }),
    ).toThrow()
    expect(() =>
      swiftStudioGatewayConfigFromEnv({
        DATABENCH_SWIFT_STUDIO_IMAGE_DIGEST: 'A'.repeat(64),
      }),
    ).toThrow()
  })

  test('rejects a drifted route manifest before starting the API', () => {
    const directory = mkdtempSync(join(tmpdir(), 'databench-swift-routes-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'routes.json')
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        upstream_commit: 'f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d',
        gradio_version: '5.50.0',
        root_path: '/swift-studio',
        route_count: 76,
        routes_sha256: '2d9b3b0ca69acf53980140fbc9eeec6280239c018be3c431181309de53225635',
        routes: [],
      }),
    )
    expect(() =>
      swiftStudioGatewayConfigFromEnv({
        DATABENCH_SWIFT_STUDIO_ENABLED: 'true',
        DATABENCH_SWIFT_STUDIO_DATABENCH_BASE_URL: 'http://api:8000',
        DATABENCH_SWIFT_STUDIO_INTERNAL_BASE_URL: 'http://swift-studio:7860',
        DATABENCH_SWIFT_STUDIO_PROVIDER_BASE_URL: 'http://swift-studio:7861',
        DATABENCH_SWIFT_STUDIO_ROUTES_MANIFEST: path,
      }),
    ).toThrow('count does not match')
  })
})

describe('Swift Studio HTTP streaming gateway', () => {
  test('is absent while disabled and rejects routes outside the locked Gradio manifest', async () => {
    const disabled = createTestApp()
    expect((await disabled.fetch(request('/swift-studio/'))).status).toBe(404)
    expect((await disabled.fetch(request('/swift-studio-runtime/runtime'))).status).toBe(404)

    const fetchMock = vi.fn(async () => Response.json({ should_not_run: true }))
    const enabled = createTestApp({
      swiftStudio: config(),
      swiftStudioFetch: fetchMock as typeof fetch,
    })
    const rejected = await enabled.fetch(request('/swift-studio/not-an-upstream-route'))
    expect(rejected.status).toBe(404)
    expect(await rejected.json()).toMatchObject({
      error: { code: 'swift_studio_route_rejected' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('streams document, static, Queue/SSE, upload, and download classes without buffering', async () => {
    const seen: Array<{
      authorization: string | null
      body: string
      cookie: string | null
      forwardedHost: string | null
      forwardedProto: string | null
      method: string
      path: string
    }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : input)
      const upstreamRequest = new Request(target, init)
      seen.push({
        authorization: upstreamRequest.headers.get('authorization'),
        body: init?.body === undefined ? '' : await upstreamRequest.text(),
        cookie: upstreamRequest.headers.get('cookie'),
        forwardedHost: upstreamRequest.headers.get('x-forwarded-host'),
        forwardedProto: upstreamRequest.headers.get('x-forwarded-proto'),
        method: upstreamRequest.method,
        path: `${target.pathname}${target.search}`,
      })
      if (target.pathname === '/') {
        return new Response(
          '<!doctype html><link rel="manifest" href="/manifest.json"><title>Swift</title>',
          {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'set-cookie': 'gradio-session=must-not-escape',
            },
          },
        )
      }
      if (target.pathname === '/gradio_api/queue/data') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: first\n\n'))
              controller.enqueue(new TextEncoder().encode('data: second\n\n'))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(`proxied:${target.pathname}`, {
        headers: { 'content-type': 'text/plain' },
      })
    })
    const app = createTestApp({
      swiftStudio: config(),
      swiftStudioFetch: fetchMock as typeof fetch,
    })

    const root = await app.fetch(
      request('/swift-studio/', {
        headers: {
          cookie: 'databench-session=must-not-leak',
          'x-forwarded-host': 'training.example.test',
          'x-forwarded-proto': 'https',
        },
      }),
    )
    expect(root.status).toBe(200)
    expect(root.headers.get('content-security-policy')).toBe("frame-ancestors 'self'")
    expect(root.headers.get('set-cookie')).toBeNull()
    const rootHtml = await root.text()
    expect(rootHtml).toContain('<title>Swift</title>')
    expect(rootHtml).not.toContain('rel="manifest"')
    expect(await (await app.fetch(request('/swift-studio/assets/index.js'))).text()).toBe(
      'proxied:/assets/index.js',
    )
    expect(
      await (
        await app.fetch(
          request('/swift-studio/gradio_api/queue/join', {
            body: '{"session_hash":"abc"}',
            headers: {
              authorization: 'Bearer databench-secret',
              cookie: 'databench-session=must-not-leak',
              'content-type': 'application/json',
            },
            method: 'POST',
          }),
        )
      ).text(),
    ).toBe('proxied:/gradio_api/queue/join')
    expect(
      await (
        await app.fetch(request('/swift-studio/gradio_api/queue/data?session_hash=abc'))
      ).text(),
    ).toBe('data: first\n\ndata: second\n\n')
    expect(
      await (
        await app.fetch(
          request('/swift-studio/gradio_api/upload', {
            body: 'multipart-body',
            headers: { 'content-type': 'multipart/form-data; boundary=test' },
            method: 'POST',
          }),
        )
      ).text(),
    ).toBe('proxied:/gradio_api/upload')
    expect(
      await (
        await app.fetch(request('/swift-studio/gradio_api/file=checkpoint/adapter.json'))
      ).text(),
    ).toBe('proxied:/gradio_api/file=checkpoint/adapter.json')

    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /',
      'GET /assets/index.js',
      'POST /gradio_api/queue/join',
      'GET /gradio_api/queue/data?session_hash=abc',
      'POST /gradio_api/upload',
      'GET /gradio_api/file=checkpoint/adapter.json',
    ])
    expect(seen[2]).toMatchObject({ authorization: null, body: '{"session_hash":"abc"}' })
    expect(seen[2]?.cookie).toBeNull()
    expect(seen[0]).toMatchObject({
      cookie: null,
      forwardedHost: 'training.example.test',
      forwardedProto: 'https',
    })
    expect(seen[4]).toMatchObject({ body: 'multipart-body' })
  })

  test('holds an explicit capacity permit until the proxied response closes', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull() {},
          }),
          { headers: { 'content-type': 'application/javascript' } },
        ),
    )
    const app = createTestApp({
      swiftStudio: config({ maxConcurrentRequests: 1 }),
      swiftStudioFetch: fetchMock as typeof fetch,
    })

    const first = await app.fetch(request('/swift-studio/assets/index.js'))
    expect(first.status).toBe(200)
    const rejected = await app.fetch(request('/swift-studio/assets/index.js'))
    expect(rejected.status).toBe(429)
    expect(await rejected.json()).toMatchObject({
      error: { code: 'swift_studio_capacity_exceeded' },
    })

    await first.body?.cancel()
    const afterRelease = await app.fetch(request('/swift-studio/assets/index.js'))
    expect(afterRelease.status).toBe(200)
    await afterRelease.body?.cancel()
  })

  test('uses the long stream timeout for upload and download route classes', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      await delayWithSignal(30, init?.signal)
      return new Response('streamed', { headers: { 'content-type': 'text/plain' } })
    })
    const app = createTestApp({
      swiftStudio: config({ streamTimeoutMs: 500, timeoutMs: 5 }),
      swiftStudioFetch: fetchMock as typeof fetch,
    })

    const upload = await app.fetch(
      request('/swift-studio/gradio_api/upload', { body: 'data', method: 'POST' }),
    )
    expect(await upload.text()).toBe('streamed')
    const download = await app.fetch(
      request('/swift-studio/gradio_api/file=checkpoint/adapter.json'),
    )
    expect(await download.text()).toBe('streamed')
    expect((await app.fetch(request('/swift-studio/config'))).status).toBe(503)
  })

  test('enforces streaming byte boundaries and rewrites same-upstream redirects', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === '/config') {
        return new Response('12345', { headers: { 'content-length': '5' } })
      }
      return new Response(null, {
        status: 307,
        headers: { location: 'http://swift-studio:7860/config?from=root' },
      })
    })
    const app = createTestApp({
      swiftStudio: config({ requestMaxBytes: 4, responseMaxBytes: 4 }),
      swiftStudioFetch: fetchMock as typeof fetch,
    })
    const tooLargeRequest = await app.fetch(
      request('/swift-studio/gradio_api/upload', {
        body: '12345',
        headers: { 'content-length': '5' },
        method: 'POST',
      }),
    )
    expect(tooLargeRequest.status).toBe(413)
    const tooLargeResponse = await app.fetch(request('/swift-studio/config'))
    expect(tooLargeResponse.status).toBe(502)
    const redirect = await app.fetch(request('/swift-studio/'))
    expect(redirect.status).toBe(307)
    expect(redirect.headers.get('location')).toBe('/swift-studio/config?from=root')
  })

  test('proxies bounded Provider health/runtime JSON on a separate prefix', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const target = new URL(input instanceof Request ? input.url : input)
      expect(target.origin).toBe('http://swift-studio:7861')
      return Response.json({ path: target.pathname, ready: target.pathname === '/runtime' })
    })
    const app = createTestApp({
      swiftStudio: config(),
      swiftStudioFetch: fetchMock as typeof fetch,
    })
    expect(await (await app.fetch(request('/swift-studio-runtime/health'))).json()).toEqual({
      path: '/health',
      ready: false,
    })
    expect(await (await app.fetch(request('/swift-studio-runtime/runtime'))).json()).toEqual({
      path: '/runtime',
      ready: true,
    })
  })
})

describe('Swift Studio WebSocket upgrade gateway', () => {
  test('tunnels the locked stream route, strips Databench authorization, and closes cleanly', async () => {
    const upstream = createServer()
    let upstreamAuthorization: string | undefined
    let upstreamCookie: string | undefined
    let upstreamForwardedHost: string | undefined
    let upstreamForwardedProto: string | undefined
    let upstreamTarget: string | undefined
    let closeUpstreamSocket = (): void => {}
    upstream.on('upgrade', (incoming, socket) => {
      closeUpstreamSocket = () => socket.destroy()
      upstreamAuthorization = incoming.headers.authorization
      upstreamCookie = incoming.headers.cookie
      upstreamForwardedHost = incoming.headers['x-forwarded-host']
      upstreamForwardedProto = incoming.headers['x-forwarded-proto']
      upstreamTarget = incoming.url
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Set-Cookie: swift-session=must-not-reach-the-browser; HttpOnly',
          '',
          '',
        ].join('\r\n'),
      )
      socket.on('data', (chunk) => socket.write(chunk))
    })
    const upstreamPort = await listen(upstream)
    const gateway = createServer()
    const proxy = attachSwiftStudioUpgradeProxy(
      gateway,
      config({ internalBaseUrl: `http://127.0.0.1:${upstreamPort}` }),
    )
    const gatewayPort = await listen(gateway)
    const client = connect(gatewayPort, '127.0.0.1')
    try {
      client.write(
        [
          'GET /swift-studio/gradio_api/stream/event-1?mode=test HTTP/1.1',
          `Host: 127.0.0.1:${gatewayPort}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGVzdC1rZXk=',
          'Sec-WebSocket-Version: 13',
          'Authorization: Bearer databench-secret',
          'Cookie: databench-session=must-not-leak',
          'X-Forwarded-Host: training.example.test',
          'X-Forwarded-Proto: https',
          '',
          '',
        ].join('\r\n'),
      )
      const handshake = await readUntil(client, '\r\n\r\n')
      expect(handshake).toContain('101 Switching Protocols')
      expect(handshake.toLowerCase()).not.toContain('set-cookie')
      client.write('ping')
      expect(await readUntil(client, 'ping')).toContain('ping')
      expect(upstreamTarget).toBe('/gradio_api/stream/event-1?mode=test')
      expect(upstreamAuthorization).toBeUndefined()
      expect(upstreamCookie).toBeUndefined()
      expect(upstreamForwardedHost).toBe('training.example.test')
      expect(upstreamForwardedProto).toBe('https')
    } finally {
      proxy.close()
      client.destroy()
      closeUpstreamSocket()
      await close(gateway)
      await close(upstream)
    }
  })

  test('rejects WebSocket upgrades beyond the configured connection capacity', async () => {
    const upstreamSockets = new Set<import('node:net').Socket>()
    const upstream = createServer()
    upstream.on('upgrade', (_incoming, socket) => {
      upstreamSockets.add(socket)
      socket.once('close', () => upstreamSockets.delete(socket))
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      )
    })
    const upstreamPort = await listen(upstream)
    const gateway = createServer()
    const proxy = attachSwiftStudioUpgradeProxy(
      gateway,
      config({
        internalBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        maxWebSocketConnections: 1,
      }),
    )
    const gatewayPort = await listen(gateway)
    const first = connect(gatewayPort, '127.0.0.1')
    const second = connect(gatewayPort, '127.0.0.1')
    const requestLines = [
      'GET /swift-studio/gradio_api/stream/event-1 HTTP/1.1',
      `Host: 127.0.0.1:${gatewayPort}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      '',
      '',
    ].join('\r\n')
    try {
      first.write(requestLines)
      expect(await readUntil(first, '\r\n\r\n')).toContain('101 Switching Protocols')
      second.write(requestLines)
      expect(await readUntil(second, '\r\n\r\n')).toContain('429 Too Many Requests')
    } finally {
      proxy.close()
      first.destroy()
      second.destroy()
      for (const socket of upstreamSockets) socket.destroy()
      await close(gateway)
      await close(upstream)
    }
  })
})

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://databench.test${path}`, init)
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Server has no TCP address')
  return address.port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function readUntil(socket: ReturnType<typeof connect>, marker: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let received = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${marker}`))
    }, 5000)
    const onData = (chunk: Buffer) => {
      received += chunk.toString('utf8')
      if (!received.includes(marker)) return
      cleanup()
      resolve(received)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('data', onData)
      socket.off('error', onError)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

async function delayWithSignal(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    const onAbort = () => {
      cleanup()
      reject(signal?.reason ?? new Error('aborted'))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
