import { describe, expect, test, vi } from 'vitest'
import { HttpSwiftStudioProvider } from '../src/v2/swift-studio-provider.js'

const PROVIDER_SESSION_ID = `sws_${'a'.repeat(43)}`
const DATASET_VERSION = 'b'.repeat(64)
const EXPORT_DIGEST = 'c'.repeat(64)

function currentSessionBody() {
  return {
    provider_session_id: PROVIDER_SESSION_ID,
    status: 'ready',
    dataset_version: DATASET_VERSION,
    converter: 'ms-swift',
    converter_version: '1.0.0',
    export_digest: EXPORT_DIGEST,
    export_size_bytes: 123,
    output_count: 2,
    provider_generation: 'spg_provider_test',
    replayed: false,
  } as const
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('HttpSwiftStudioProvider current Session reconciliation', () => {
  test('reads the strict current Session contract with GET and no request body', async () => {
    const providerFetch = vi.fn<typeof fetch>(async () => jsonResponse(currentSessionBody()))
    const provider = new HttpSwiftStudioProvider({
      baseUrl: 'http://swift-provider:7861',
      credential: 'provider-test-credential',
      fetch: providerFetch,
    })

    await expect(provider.getCurrentSession()).resolves.toEqual({
      providerSessionId: PROVIDER_SESSION_ID,
      status: 'ready',
      datasetVersion: DATASET_VERSION,
      converter: 'ms-swift',
      converterVersion: '1.0.0',
      exportDigest: EXPORT_DIGEST,
      exportSizeBytes: 123,
      outputCount: 2,
      providerGeneration: 'spg_provider_test',
      replayed: false,
    })
    const [url, init] = providerFetch.mock.calls[0] ?? []
    expect(url?.toString()).toBe('http://swift-provider:7861/sessions/current')
    expect(init).toMatchObject({
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer provider-test-credential',
      },
    })
    expect(init).not.toHaveProperty('body')
  })

  test('maps an exact Provider 404 to no active Session', async () => {
    const provider = new HttpSwiftStudioProvider({
      baseUrl: 'http://swift-provider:7861',
      fetch: vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            error: {
              code: 'active_session_not_found',
              message: 'No active Studio Session exists',
            },
          },
          404,
        ),
      ),
    })

    await expect(provider.getCurrentSession()).resolves.toBeNull()
  })

  test('rejects a foreign 404 instead of treating it as no active Session', async () => {
    const provider = new HttpSwiftStudioProvider({
      baseUrl: 'http://swift-provider:7861',
      fetch: vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            error: {
              code: 'route_not_found',
              message: 'The requested Provider route does not exist',
            },
          },
          404,
        ),
      ),
    })

    await expect(provider.getCurrentSession()).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      detail: { dependency: 'swift_studio_provider', reason: 'contract_mismatch' },
    })
  })

  test('fails closed when the Provider returns a foreign or invalid contract', async () => {
    const provider = new HttpSwiftStudioProvider({
      baseUrl: 'http://swift-provider:7861',
      fetch: vi.fn<typeof fetch>(async () =>
        jsonResponse({ ...currentSessionBody(), absolute_output_path: '/foreign/output' }),
      ),
    })

    await expect(provider.getCurrentSession()).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      code: 'service_unavailable',
      detail: {
        dependency: 'swift_studio_provider',
        reason: 'contract_mismatch',
      },
    })
  })
})
