import { describe, expect, test, vi } from 'vitest'
import {
  type ArtifactRegistrationRequestV2,
  commitArtifactRegistrationV2,
  inspectArtifactRegistrationV2,
  listModelsV2,
} from './registry.js'

const modelId = '123e4567-e89b-42d3-a456-426614174010'
const artifactId = '123e4567-e89b-42d3-a456-426614174012'
const request: ArtifactRegistrationRequestV2 = {
  target: { kind: 'existing_model', model_id: modelId },
  version_label: 'r2',
  source: { kind: 'databench_artifact', artifact_id: artifactId },
}

describe('Model Registry generated API client', () => {
  test('binds stable list filters to the generated route', async () => {
    const fetchMock = vi.fn(async (incoming: Request) => {
      const url = new URL(incoming.url)
      expect(url.pathname).toBe('/v2/models')
      expect(url.searchParams.get('archive')).toBe('all')
      expect(url.searchParams.get('source_kind')).toBe('databench_artifact')
      expect(url.searchParams.get('search')).toBe('support')
      expect(incoming.headers.get('authorization')).toBe('Bearer scoped-token')
      return Response.json({ items: [], next_cursor: null })
    })
    await expect(
      listModelsV2({
        archive: 'all',
        base: 'https://api.example.test',
        cursor: null,
        fetch: fetchMock,
        limit: 20,
        search: 'support',
        sourceKind: 'databench_artifact',
        token: 'scoped-token',
      }),
    ).resolves.toEqual({ items: [], next_cursor: null })
  })

  test('keeps Inspect and existing-Model Commit on their distinct generated routes', async () => {
    const paths: string[] = []
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (incoming: Request) => {
      paths.push(new URL(incoming.url).pathname)
      bodies.push(await incoming.json())
      return Response.json(
        paths.length === 1 ? { registration_digest: 'a'.repeat(64) } : { model_id: modelId },
        { status: paths.length === 1 ? 200 : 201 },
      )
    })
    const common = { base: 'https://api.example.test', fetch: fetchMock, token: '' }
    await inspectArtifactRegistrationV2({ ...common, request })
    await commitArtifactRegistrationV2({
      ...common,
      request: { expected_registration_digest: 'a'.repeat(64), request },
    })
    expect(paths).toEqual([
      '/v2/model-registrations:inspect',
      `/v2/models/${modelId}/versions:register`,
    ])
    expect(bodies).toEqual([request, { expected_registration_digest: 'a'.repeat(64), request }])
  })
})
