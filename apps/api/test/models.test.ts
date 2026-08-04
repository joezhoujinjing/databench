import { describe, expect, test, vi } from 'vitest'
import type { ApiV2Workspace } from '../src/context.js'
import { createTestApp } from './test-app.js'

const MODEL_ID = '123e4567-e89b-42d3-a456-426614174010'
const VERSION_ID = '123e4567-e89b-42d3-a456-426614174011'
const ARTIFACT_ID = '123e4567-e89b-42d3-a456-426614174012'
const DEPLOYMENT_ID = '123e4567-e89b-42d3-a456-426614174013'
const OPERATOR_TOKEN = 'operator-token-that-is-at-least-32-bytes'
const NOW = '2026-08-04T12:00:00.000Z'

const createRegistration = {
  target: {
    kind: 'create_model' as const,
    key: 'support-model',
    display_name: 'Support Model',
    description: 'Customer support adapter',
    task_family: 'chat',
    tags: ['support'],
  },
  version_label: 'r1',
  alias: { alias: 'candidate' as const, expected_version_id: null },
  source: { kind: 'databench_artifact' as const, artifact_id: ARTIFACT_ID },
}

const registrationPlan = {
  plan_profile: 'model-registration-plan-artifact-v1' as const,
  normalized_request: createRegistration,
  model_id: MODEL_ID,
  model_create_digest: '1'.repeat(64),
  source_fingerprint: '2'.repeat(64),
  version_create_digest: '3'.repeat(64),
  classification: {
    source_mutability: 'immutable' as const,
    verification_level: 'content_verified' as const,
    evidence_digest: null,
  },
  warnings: [],
  registration_digest: '4'.repeat(64),
}

const model = {
  id: MODEL_ID,
  key: 'support-model',
  display_name: 'Support Model',
  description: 'Customer support adapter',
  task_family: 'chat',
  tags: ['support'],
  metadata_revision: 0,
  archived_at: null,
  created_at: NOW,
  updated_at: NOW,
}

const version = {
  id: VERSION_ID,
  model_id: MODEL_ID,
  version_label: 'r1',
  source_kind: 'databench_artifact' as const,
  source_fingerprint: '2'.repeat(64),
  base_model: { reference: 'Qwen/Qwen3-0.6B', revision: null },
  base_model_binding_status: 'declared' as const,
  classification: registrationPlan.classification,
  source: {
    kind: 'databench_artifact' as const,
    artifact_id: ARTIFACT_ID,
    artifact_kind: 'lora_adapter' as const,
    artifact_format: 'swift-lora-adapter-v1' as const,
    archive_digest: '5'.repeat(64),
    manifest_digest: '6'.repeat(64),
  },
  created_at: NOW,
}

const alias = {
  alias: 'candidate' as const,
  version_id: VERSION_ID,
  created_at: NOW,
  updated_at: NOW,
}

function workspace(): ApiV2Workspace {
  return {
    inspectModelRegistration: vi.fn(async () => registrationPlan),
    commitModelRegistration: vi.fn(async () => ({
      registration_digest: registrationPlan.registration_digest,
      model_id: MODEL_ID,
      model_version_id: VERSION_ID,
      source_fingerprint: registrationPlan.source_fingerprint,
      alias: 'candidate',
      replayed: false,
    })),
    listModels: vi.fn(async () => ({
      items: [
        {
          model,
          candidate: {
            version_id: VERSION_ID,
            version_label: 'r1',
            source_kind: 'databench_artifact',
            source_mutability: 'immutable',
            verification_level: 'content_verified',
            base_model_reference: 'Qwen/Qwen3-0.6B',
          },
          version_count: 1,
          adopted_deployment_count: 1,
          healthy_adopted_deployment_count: 1,
        },
      ],
      next_cursor: null,
    })),
    getModel: vi.fn(async () => model),
    updateModel: vi.fn(async () => ({ ...model, metadata_revision: 1 })),
    archiveModel: vi.fn(async () => ({ ...model, metadata_revision: 1, archived_at: NOW })),
    listModelVersions: vi.fn(async () => ({ items: [version], next_cursor: null })),
    getModelVersion: vi.fn(async () => version),
    listModelAliases: vi.fn(async () => ({ items: [alias] })),
    moveCandidateModelAlias: vi.fn(async () => alias),
    adoptModelDeployment: vi.fn(async () => ({
      adoption_profile: 'model-deployment-adoption-v1',
      adoption_digest: '7'.repeat(64),
      model_id: MODEL_ID,
      model_version_id: VERSION_ID,
      deployment_id: DEPLOYMENT_ID,
      deployment_digest: '8'.repeat(64),
      artifact_id: ARTIFACT_ID,
      adopted_at: NOW,
      replayed: false,
    })),
  } as unknown as ApiV2Workspace
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, init)
}

function write(body: unknown, token = OPERATOR_TOKEN): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }
}

describe('Model Registry HTTP contract', () => {
  test('exposes Artifact-only inspect and separate create-Model/register-Version commits', async () => {
    const fake = workspace()
    const app = createTestApp({
      v2Workspace: fake,
      modelDeploymentOperatorToken: OPERATOR_TOKEN,
    })
    const inspected = await app.fetch(
      request('/v2/model-registrations:inspect', write(createRegistration)),
    )
    expect(inspected.status).toBe(200)
    expect(await inspected.json()).toEqual(registrationPlan)

    const commit = {
      request: createRegistration,
      expected_registration_digest: registrationPlan.registration_digest,
    }
    const created = await app.fetch(request('/v2/models:register', write(commit)))
    expect(created.status).toBe(201)

    const existingRegistration = {
      ...createRegistration,
      target: { kind: 'existing_model' as const, model_id: MODEL_ID },
      version_label: 'r2',
    }
    const registered = await app.fetch(
      request(
        `/v2/models/${MODEL_ID}/versions:register`,
        write({
          request: existingRegistration,
          expected_registration_digest: registrationPlan.registration_digest,
        }),
      ),
    )
    expect(registered.status).toBe(201)
    expect(fake.commitModelRegistration).toHaveBeenCalledTimes(2)

    const wrongRoute = await app.fetch(
      request(
        `/v2/models/${MODEL_ID}/versions:register`,
        write({ request: createRegistration, expected_registration_digest: '4'.repeat(64) }),
      ),
    )
    expect(wrongRoute.status).toBe(422)

    const repositoryAttempt = await app.fetch(
      request(
        '/v2/model-registrations:inspect',
        write({
          ...createRegistration,
          source: {
            kind: 'repository_reference',
            provider: 'modelscope',
            repository_id: 'Qwen/Qwen3-0.6B',
            revision: 'main',
            revision_kind: 'tag',
            base_model: null,
          },
        }),
      ),
    )
    expect(repositoryAttempt.status).toBe(422)
    expect(fake.inspectModelRegistration).toHaveBeenCalledTimes(1)
  })

  test('serves stable Model, Version, and Alias read routes', async () => {
    const app = createTestApp({ v2Workspace: workspace() })
    for (const path of [
      '/v2/models?archive=active&limit=20',
      `/v2/models/${MODEL_ID}`,
      `/v2/models/${MODEL_ID}/versions?limit=20`,
      `/v2/model-versions/${VERSION_ID}`,
      `/v2/models/${MODEL_ID}/aliases`,
    ]) {
      const response = await app.fetch(request(path))
      expect(response.status, path).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    }
  })

  test('protects metadata, archive, Alias, and adoption actions with the operator role', async () => {
    const fake = workspace()
    const app = createTestApp({
      v2Workspace: fake,
      modelDeploymentOperatorToken: OPERATOR_TOKEN,
    })
    const actions: Array<[string, unknown]> = [
      [
        `/v2/models/${MODEL_ID}:update`,
        {
          expected_metadata_revision: 0,
          display_name: model.display_name,
          description: model.description,
          task_family: model.task_family,
          tags: model.tags,
        },
      ],
      [`/v2/models/${MODEL_ID}:archive`, { expected_metadata_revision: 0 }],
      [
        `/v2/models/${MODEL_ID}/aliases/candidate:move`,
        { expected_version_id: null, new_version_id: VERSION_ID },
      ],
      [
        `/v2/model-versions/${VERSION_ID}/deployments/${DEPLOYMENT_ID}:adopt`,
        {
          expected_artifact_id: ARTIFACT_ID,
          expected_deployment_digest: '8'.repeat(64),
        },
      ],
    ]
    for (const [path, body] of actions) {
      const denied = await app.fetch(request(path, write(body, 'wrong-token-but-long-enough')))
      expect(denied.status, path).toBe(401)
      const allowed = await app.fetch(request(path, write(body)))
      expect(allowed.status, path).toBe(200)
    }
    expect(fake.updateModel).toHaveBeenCalledOnce()
    expect(fake.archiveModel).toHaveBeenCalledOnce()
    expect(fake.moveCandidateModelAlias).toHaveBeenCalledOnce()
    expect(fake.adoptModelDeployment).toHaveBeenCalledOnce()
  })
})
