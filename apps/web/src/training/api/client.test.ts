import { describe, expect, test, vi } from 'vitest'
import { getSwiftStudioRuntime, SwiftStudioRuntimeContractError } from './client.js'

const RUNTIME = {
  ready: true,
  service: 'swift-studio-provider',
  service_version: '0.1.0',
  ms_swift_version: '4.4.2',
  ms_swift_commit: 'f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d',
  gradio_version: '5.50.0',
  torch_version: '2.8.0',
  cuda_version: '12.8',
  gpu_available: true,
  root_path: '/swift-studio',
  capability_manifest_id: 'swift-runtime-capabilities@1',
  capability_manifest_phase: 'S1-in-progress',
  capability_manifest_sha256: '01d259849837484b8ed00c013ed53d45548a525384317b856edebee02d5956b4',
  surfaces: [
    'llm_train',
    'llm_rlhf',
    'llm_grpo',
    'llm_infer',
    'llm_export',
    'llm_eval',
    'llm_sample',
  ],
  capabilities: ['native-full-gradio', 'runtime-health'],
}

describe('Swift Studio runtime client', () => {
  test('uses the selected backend scope and validates the complete locked runtime', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/swift-studio-runtime/runtime')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer scoped-token')
      return Response.json(RUNTIME)
    })
    await expect(
      getSwiftStudioRuntime({
        base: '/api',
        token: 'scoped-token',
        fetch: fetchMock,
      }),
    ).resolves.toEqual(RUNTIME)
  })

  test('fails closed when a native surface or capability drifts', async () => {
    const missingSurface = {
      ...RUNTIME,
      surfaces: RUNTIME.surfaces.slice(0, -1),
    }
    const fetchMock = vi.fn(async () => Response.json(missingSurface))
    await expect(
      getSwiftStudioRuntime({
        base: '',
        token: '',
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(SwiftStudioRuntimeContractError)
  })

  test('fails closed when the capability manifest digest drifts', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ...RUNTIME,
        capability_manifest_sha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    )
    await expect(
      getSwiftStudioRuntime({
        base: '',
        token: '',
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(SwiftStudioRuntimeContractError)
  })

  test('accepts the exact starting contract without claiming native surfaces', async () => {
    const starting = {
      ...RUNTIME,
      ready: false,
      surfaces: [],
      capabilities: ['runtime-health'],
    }
    const fetchMock = vi.fn(async () => Response.json(starting))
    await expect(getSwiftStudioRuntime({ base: '', token: '', fetch: fetchMock })).resolves.toEqual(
      starting,
    )
  })
})
