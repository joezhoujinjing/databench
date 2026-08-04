import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createGzip } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { ModelCredentialSnapshotV1 } from '../src/model-credentials/index.js'
import {
  isApprovedModelEndpointRemoteAddressV1,
  loadModelEndpointPolicyV1,
  ModelEndpointPolicyError,
  ModelEndpointPolicyV1Runtime,
  ModelEndpointTransportError,
  PinnedModelEndpointTransportV1,
  parseModelEndpointPolicyV1,
} from '../src/model-endpoint-policy/index.js'

interface FixtureCase {
  readonly id: string
  readonly scope: 'private_network' | 'public_network'
  readonly release_profile: 'offline' | 'connected'
  readonly url: string
  readonly dns_answers?: readonly string[]
  readonly dns_answers_by_call?: readonly (readonly string[])[]
  readonly expected: string
  readonly expected_code?: string
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../docs/models/fixtures/model-endpoint-policy-v1.cases.json', import.meta.url),
    'utf8',
  ),
) as { readonly policy: unknown; readonly required_cases: readonly FixtureCase[] }

const servers: Server[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe('model-endpoint-policy-v1', () => {
  test.each(
    fixture.required_cases.filter(
      (item) =>
        item.id !== 'redirect' &&
        (item.expected === 'allow' ||
          item.expected === 'deny' ||
          item.expected === 'ignore-proxy' ||
          item.expected === 'registered-unavailable'),
    ),
  )('$id has the registered TypeScript decision', async (item) => {
    const runtime = new ModelEndpointPolicyV1Runtime(fixture.policy, {
      releaseProfile: item.release_profile,
      resolver: async () => item.dns_answers ?? [],
    })
    if (item.expected === 'allow' || item.expected === 'ignore-proxy') {
      const authorized = await runtime.authorize(item.url, item.scope)
      expect(authorized.addresses).toEqual(item.dns_answers)
      expect(authorized.policyGeneration).toBe(7)
      return
    }
    await expect(runtime.authorize(item.url, item.scope)).rejects.toMatchObject({
      code: item.expected_code,
    })
  })

  test('revalidates every connection and rejects the rebinding snapshot', async () => {
    const item = fixture.required_cases.find(
      (candidate) => candidate.id === 'dns-rebinding-second-resolution',
    )
    expect(item).toBeDefined()
    let call = 0
    const runtime = new ModelEndpointPolicyV1Runtime(fixture.policy, {
      releaseProfile: 'offline',
      resolver: async () => item?.dns_answers_by_call?.[call++] ?? [],
    })
    await expect(runtime.authorize(item?.url ?? '', 'private_network')).resolves.toMatchObject({
      addresses: ['10.10.0.15'],
    })
    await expect(runtime.authorize(item?.url ?? '', 'private_network')).rejects.toMatchObject({
      code: 'model_endpoint_address_rejected',
    })
  })

  test('strict parser rejects extra fields, duplicate rule values, and mapped addresses', () => {
    expect(() => parseModelEndpointPolicyV1({ ...fixture.policy, extra: true })).toThrow()
    const policy = structuredClone(fixture.policy) as {
      private_network: Array<{ cidrs: string[]; ports: number[] }>
    }
    policy.private_network[0]?.ports.push(8000)
    expect(() => parseModelEndpointPolicyV1(policy)).toThrow()
    const mapped = structuredClone(fixture.policy) as {
      private_network: Array<{ cidrs: string[] }>
    }
    mapped.private_network[0]?.cidrs.splice(0, 1, '::ffff:10.10.0.0/120')
    expect(() => parseModelEndpointPolicyV1(mapped)).toThrow()
  })

  test('policy file loading rejects a symlink before parsing', () => {
    const root = mkdtempSync(join(tmpdir(), 'databench-model-endpoint-policy-'))
    const target = join(root, 'policy.json')
    const link = join(root, 'policy-link.json')
    writeFileSync(target, `${JSON.stringify(fixture.policy)}\n`)
    symlinkSync(target, link)
    expect(() => loadModelEndpointPolicyV1(link)).toThrow('unavailable')
  })
})

describe('pinned Model endpoint transport', () => {
  test('connects to the approved IP, preserves Host, ignores proxies, and parses bounded JSON', async () => {
    let observedHost = ''
    const server = await listen((request, response) => {
      observedHost = request.headers.host ?? ''
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"data":[{"id":"support-model"}]}')
    })
    process.env.HTTP_PROXY = 'http://127.0.0.1:1'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
    try {
      const { transport, port } = localTransport(server)
      await expect(
        transport.discoverModels(`http://localhost:${port}/v1`, {
          scope: 'private_network',
        }),
      ).resolves.toEqual(['support-model'])
      expect(observedHost).toBe(`localhost:${port}`)
    } finally {
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
    }
  })

  test('pins HTTPS to the approved IP while preserving Host, SNI, CA, and hostname verification', async () => {
    const certificates = createTestCertificates()
    const observedHosts: string[] = []
    const observedServerNames: string[] = []
    const server = createHttpsServer(
      {
        cert: readFileSync(certificates.serverCertificate),
        key: readFileSync(certificates.serverKey),
      },
      (request, response) => {
        observedHosts.push(request.headers.host ?? '')
        observedServerNames.push(request.socket.servername ?? '')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"data":[{"id":"tls-model"}]}')
      },
    )
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('port missing')
      const childSource = `
        const module = await import(process.env.DATABENCH_TEST_TRANSPORT_MODULE_URL)
        const port = Number(process.env.DATABENCH_TEST_TLS_PORT)
        const policyFor = (hostname) => ({
          profile: 'model-endpoint-policy-v1',
          generation: 1,
          private_network: [{
            hostname,
            cidrs: ['127.0.0.0/8'],
            schemes: ['https'],
            ports: [port],
          }],
          public_network: [],
        })
        const transportFor = (hostname) => new module.PinnedModelEndpointTransportV1({
          policy: new module.ModelEndpointPolicyV1Runtime(policyFor(hostname), {
            releaseProfile: 'offline',
            resolver: async () => ['127.0.0.1'],
          }),
          timeouts: { connectMs: 1000, headersMs: 1000, bodyMs: 1000, totalMs: 2000 },
        })
        const models = await transportFor('model.internal').discoverModels(
          'https://model.internal:' + port + '/v1',
          { scope: 'private_network' },
        )
        if (models.length !== 1 || models[0] !== 'tls-model') process.exit(2)
        try {
          await transportFor('wrong.internal').discoverModels(
            'https://wrong.internal:' + port + '/v1',
            { scope: 'private_network' },
          )
          process.exit(3)
        } catch (error) {
          if (error?.code !== 'model_endpoint_network_error') process.exit(4)
        }
      `
      await execFileAsync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', childSource],
        {
          cwd: new URL('..', import.meta.url),
          env: {
            ...process.env,
            DATABENCH_TEST_TLS_PORT: String(address.port),
            DATABENCH_TEST_TRANSPORT_MODULE_URL: new URL(
              '../src/model-endpoint-policy/index.ts',
              import.meta.url,
            ).href,
            NODE_EXTRA_CA_CERTS: certificates.caCertificate,
          },
        },
      )
      expect(observedHosts).toContain(`model.internal:${address.port}`)
      expect(observedServerNames).toContain('model.internal')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('rejects redirects without forwarding Authorization', async () => {
    let destinationRequests = 0
    let destinationAuthorization: string | undefined
    let sourceAuthorization: string | undefined
    const destination = await listen((_request, response) => {
      destinationRequests += 1
      destinationAuthorization = _request.headers.authorization
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"data":[]}')
    })
    const destinationAddress = destination.address()
    if (destinationAddress === null || typeof destinationAddress === 'string')
      throw new Error('port missing')
    const source = await listen((request, response) => {
      sourceAuthorization = request.headers.authorization
      response.writeHead(302, { location: `http://localhost:${destinationAddress.port}/v1/models` })
      response.end()
    })
    const { transport, port } = localTransport(source)
    await expect(
      transport.discoverModels(`http://localhost:${port}/v1`, {
        scope: 'private_network',
        credential: new ModelCredentialSnapshotV1('deployment-a', 1, 'target-origin-secret'),
      }),
    ).rejects.toMatchObject({ code: 'model_endpoint_redirect_rejected' })
    expect(sourceAuthorization).toBe('Bearer target-origin-secret')
    expect(destinationRequests).toBe(0)
    expect(destinationAuthorization).toBeUndefined()
  })

  test('clears the header deadline before reading a valid slower body', async () => {
    const server = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.flushHeaders()
      setTimeout(() => response.end('{"data":[{"id":"slow-valid-model"}]}'), 180)
    })
    const { transport, port } = localTransport(server, {
      connectMs: 100,
      headersMs: 100,
      bodyMs: 300,
      totalMs: 500,
    })
    await expect(
      transport.discoverModels(`http://localhost:${port}/v1`, { scope: 'private_network' }),
    ).resolves.toEqual(['slow-valid-model'])
  })

  test.each([
    [
      'compression bomb',
      (response: import('node:http').ServerResponse) => {
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        })
        const gzip = createGzip()
        gzip.pipe(response)
        gzip.end(JSON.stringify({ data: [], padding: 'x'.repeat(300 * 1024) }))
      },
    ],
    [
      'media type drift',
      (response: import('node:http').ServerResponse) => {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('{"data":[]}')
      },
    ],
    [
      'deep JSON',
      (response: import('node:http').ServerResponse) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [], nested: deepObject(20) }))
      },
    ],
    [
      'slow headers',
      (response: import('node:http').ServerResponse) => {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"data":[]}')
        }, 250)
      },
    ],
    [
      'slow body',
      (response: import('node:http').ServerResponse) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.flushHeaders()
        response.write('{"data":[')
        setTimeout(() => response.end(']}'), 250)
      },
    ],
    [
      'oversized headers',
      (response: import('node:http').ServerResponse) => {
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-oversized': 'x'.repeat(40 * 1024),
        })
        response.end('{"data":[]}')
      },
    ],
  ] as const)('fails closed on %s', async (_name, respond) => {
    const server = await listen((_request, response) => respond(response))
    const { transport, port } = localTransport(server, {
      connectMs: 100,
      headersMs: 100,
      bodyMs: 100,
      totalMs: 500,
    })
    await expect(
      transport.discoverModels(`http://localhost:${port}/v1`, {
        scope: 'private_network',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelEndpointTransportError || error instanceof ModelEndpointPolicyError,
    )
  })

  test('socket remote-address verification rejects unapproved and accepts canonical mapped peers', () => {
    expect(isApprovedModelEndpointRemoteAddressV1('127.0.0.1', new Set(['127.0.0.1']))).toBe(true)
    expect(isApprovedModelEndpointRemoteAddressV1('::ffff:127.0.0.1', new Set(['127.0.0.1']))).toBe(
      true,
    )
    expect(isApprovedModelEndpointRemoteAddressV1('127.0.0.2', new Set(['127.0.0.1']))).toBe(false)
    expect(isApprovedModelEndpointRemoteAddressV1(undefined, new Set(['127.0.0.1']))).toBe(false)
  })
})

async function listen(handler: Parameters<typeof createServer>[0]): Promise<Server> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return server
}

function localTransport(
  server: Server,
  timeouts: { connectMs: number; headersMs: number; bodyMs: number; totalMs: number } = {
    connectMs: 500,
    headersMs: 500,
    bodyMs: 500,
    totalMs: 1_000,
  },
) {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('port missing')
  const policy = {
    profile: 'model-endpoint-policy-v1',
    generation: 1,
    private_network: [
      {
        hostname: 'localhost',
        cidrs: ['127.0.0.0/8'],
        schemes: ['http'],
        ports: [address.port],
      },
    ],
    public_network: [],
  }
  return {
    port: address.port,
    transport: new PinnedModelEndpointTransportV1({
      policy: new ModelEndpointPolicyV1Runtime(policy, {
        releaseProfile: 'offline',
        resolver: async () => ['127.0.0.1'],
      }),
      timeouts,
    }),
  }
}

function deepObject(depth: number): unknown {
  let value: unknown = 'leaf'
  for (let index = 0; index < depth; index += 1) value = { value }
  return value
}

function createTestCertificates() {
  const root = mkdtempSync(join(tmpdir(), 'databench-model-endpoint-tls-'))
  const caKey = join(root, 'ca.key')
  const caCertificate = join(root, 'ca.crt')
  const serverKey = join(root, 'server.key')
  const serverRequest = join(root, 'server.csr')
  const serverCertificate = join(root, 'server.crt')
  const extensions = join(root, 'server.ext')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=Databench Model Endpoint Test CA',
      '-keyout',
      caKey,
      '-out',
      caCertificate,
    ],
    { stdio: 'ignore' },
  )
  execFileSync(
    'openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      '/CN=model.internal',
      '-keyout',
      serverKey,
      '-out',
      serverRequest,
    ],
    { stdio: 'ignore' },
  )
  writeFileSync(
    extensions,
    'subjectAltName=DNS:model.internal\nextendedKeyUsage=serverAuth\n',
    'utf8',
  )
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      serverRequest,
      '-CA',
      caCertificate,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-days',
      '2',
      '-extfile',
      extensions,
      '-out',
      serverCertificate,
    ],
    { stdio: 'ignore' },
  )
  return { caCertificate, serverCertificate, serverKey }
}
