import { describe, expect, test, vi } from 'vitest'
import {
  createModelArtifactImportV2,
  downloadModelArtifactV2,
  getModelArtifactImportV2,
  getModelArtifactV2,
  listModelArtifactsV2,
  listSwiftStudioOutputsV2,
  type ModelArtifactV2,
  modelArtifactDownloadUrlV2,
} from './artifacts.js'

const sessionId = '11111111-1111-4111-8111-111111111111'
const importId = '22222222-2222-4222-8222-222222222222'
const artifactId = '33333333-3333-4333-8333-333333333333'

describe('Model Artifact API client', () => {
  test('lists opaque Studio outputs through the generated route', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(`/v2/swift-studio-sessions/${sessionId}/outputs`)
      expect(request.headers.get('authorization')).toBe('Bearer scoped-token')
      return Response.json({ items: [] })
    })

    await expect(
      listSwiftStudioOutputsV2({
        base: 'https://api.example.test',
        fetch: fetchMock,
        sessionId,
        token: 'scoped-token',
      }),
    ).resolves.toEqual({ items: [] })
  })

  test('creates an import without exposing a provider path', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/v2/model-artifact-imports')
      expect(await request.json()).toEqual({
        artifact_kind: 'lora_adapter',
        base_model: { reference: 'Qwen/Qwen3-0.6B', revision: null },
        display_name: 'checkpoint-5',
        output_handle: 'out_opaque-handle',
        studio_session_id: sessionId,
      })
      return Response.json({ id: importId }, { status: 201 })
    })

    await expect(
      createModelArtifactImportV2({
        base: 'https://api.example.test',
        fetch: fetchMock,
        request: {
          artifact_kind: 'lora_adapter',
          base_model: { reference: 'Qwen/Qwen3-0.6B', revision: null },
          display_name: 'checkpoint-5',
          output_handle: 'out_opaque-handle',
          studio_session_id: sessionId,
        },
        token: '',
      }),
    ).resolves.toEqual({ id: importId })
  })

  test('gets import and Artifact metadata and lists only LoRA Artifacts', async () => {
    const paths: string[] = []
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url)
      paths.push(`${url.pathname}${url.search}`)
      return Response.json({ id: url.pathname.endsWith(importId) ? importId : artifactId })
    })
    const common = { base: 'https://api.example.test', fetch: fetchMock, token: '' }

    await getModelArtifactImportV2({ ...common, importId })
    await getModelArtifactV2({ ...common, artifactId })
    await listModelArtifactsV2({ ...common, cursor: null, limit: 20 })

    expect(paths).toEqual([
      `/v2/model-artifact-imports/${importId}`,
      `/v2/model-artifacts/${artifactId}`,
      '/v2/model-artifacts?artifact_kind=lora_adapter&limit=20&registration_status=all',
    ])
  })

  test('builds a scoped download route without inventing a second endpoint', () => {
    expect(modelArtifactDownloadUrlV2('/api', artifactId)).toBe(
      `/api/v2/model-artifacts/${artifactId}:download`,
    )
  })

  test('streams an Artifact download with the configured Bearer credential', async () => {
    const writes: Uint8Array[] = []
    const writable = {
      abort: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      write: vi.fn(async (value: Uint8Array) => {
        writes.push(value)
      }),
    }
    const artifact = {
      id: artifactId,
      archive_size_bytes: 3,
      display_name: 'checkpoint-5',
    } as ModelArtifactV2
    const result = await downloadModelArtifactV2({
      artifact,
      base: 'https://api.example.test',
      fetch: async (request) => {
        expect(new URL(request.url).pathname).toBe(`/v2/model-artifacts/${artifactId}:download`)
        expect(request.headers.get('authorization')).toBe('Bearer scoped-token')
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Length': '3', 'Content-Type': 'application/zstd' },
        })
      },
      target: {
        handle: { createWritable: vi.fn(async () => writable) },
        kind: 'file-system',
      },
      token: 'scoped-token',
    })

    expect(result).toEqual({ bytes: 3 })
    expect(writes).toHaveLength(1)
    expect(writable.close).toHaveBeenCalledOnce()
    expect(writable.abort).not.toHaveBeenCalled()
  })
})
