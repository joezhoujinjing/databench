import { describe, expect, test, vi } from 'vitest'
import {
  commitModelRegistrationV2,
  findModelSummaryV2,
  inspectModelRegistrationV2,
  listModelEvaluationDeploymentCandidatesV2,
  listModelsV2,
  type ModelRegistrationRequestV2,
  restoreModelV2,
} from './registry.js'

const modelId = '123e4567-e89b-42d3-a456-426614174010'
const artifactId = '123e4567-e89b-42d3-a456-426614174012'
const request: ModelRegistrationRequestV2 = {
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
      expect(url.searchParams.get('source_mutability')).toBe('immutable')
      expect(url.searchParams.get('verification_level')).toBe('content_verified')
      expect(url.searchParams.get('task_family')).toBe('chat')
      expect(url.searchParams.get('artifact_kind')).toBe('lora_adapter')
      expect(url.searchParams.get('artifact_id')).toBe(artifactId)
      expect(url.searchParams.get('alias')).toBe('candidate')
      expect(url.searchParams.get('deployment_lifecycle')).toBe('active')
      expect(url.searchParams.get('deployment_health')).toBe('healthy')
      expect(url.searchParams.get('tag')).toBe('support')
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
        sourceMutability: 'immutable',
        verificationLevel: 'content_verified',
        taskFamily: 'chat',
        artifactKind: 'lora_adapter',
        artifactId,
        alias: 'candidate',
        deploymentLifecycle: 'active',
        deploymentHealth: 'healthy',
        tag: 'support',
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
    await inspectModelRegistrationV2({ ...common, request })
    await commitModelRegistrationV2({
      ...common,
      request: { expected_registration_digest: 'a'.repeat(64), request },
    })
    expect(paths).toEqual([
      '/v2/model-registrations:inspect',
      `/v2/models/${modelId}/versions:register`,
    ])
    expect(bodies).toEqual([request, { expected_registration_digest: 'a'.repeat(64), request }])
  })

  test('sends the server-owned workload profile and output budget to the selector route', async () => {
    const fetchMock = vi.fn(async (incoming: Request) => {
      const url = new URL(incoming.url)
      expect(url.pathname).toBe(`/v2/model-versions/${modelId}/evaluation-deployments`)
      expect(url.searchParams.get('workload_profile')).toBe('evalscope_chat_completions_v1')
      expect(url.searchParams.get('max_output_tokens')).toBe('512')
      expect(url.searchParams.get('limit')).toBe('100')
      return Response.json({
        workload_profile: 'evalscope_chat_completions_v1',
        required_interface: 'chat_completions',
        min_context_limit: 4_608,
        items: [],
        next_cursor: null,
      })
    })

    await expect(
      listModelEvaluationDeploymentCandidatesV2({
        base: 'https://api.example.test',
        fetch: fetchMock,
        maxOutputTokens: 512,
        token: '',
        versionId: modelId,
      }),
    ).resolves.toMatchObject({ min_context_limit: 4_608 })
  })

  test('restores an archived Model through the generated metadata CAS route', async () => {
    const fetchMock = vi.fn(async (incoming: Request) => {
      expect(new URL(incoming.url).pathname).toBe(`/v2/models/${modelId}:restore`)
      expect(incoming.headers.get('authorization')).toBe('Bearer scoped-token')
      expect(await incoming.json()).toEqual({ expected_metadata_revision: 3 })
      return Response.json({ id: modelId, metadata_revision: 4, archived_at: null })
    })
    await expect(
      restoreModelV2({
        base: 'https://api.example.test',
        expectedMetadataRevision: 3,
        fetch: fetchMock,
        modelId,
        token: 'scoped-token',
      }),
    ).resolves.toMatchObject({ id: modelId, metadata_revision: 4, archived_at: null })
  })

  test('finds the exact Model summary beyond the first 100 search matches', async () => {
    const cursors: Array<string | null> = []
    const fetchMock = vi.fn(async (incoming: Request) => {
      const cursor = new URL(incoming.url).searchParams.get('cursor')
      cursors.push(cursor)
      return Response.json(
        cursor === null
          ? {
              items: [{ model: { id: '123e4567-e89b-42d3-a456-426614174099' } }],
              next_cursor: 'page-2',
            }
          : { items: [{ model: { id: modelId, key: 'support-model' } }], next_cursor: null },
      )
    })

    await expect(
      findModelSummaryV2({
        base: 'https://api.example.test',
        fetch: fetchMock,
        modelId,
        modelKey: 'support-model',
        token: '',
      }),
    ).resolves.toMatchObject({ model: { id: modelId } })
    expect(cursors).toEqual([null, 'page-2'])
  })
})
