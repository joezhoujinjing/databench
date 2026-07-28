import { describe, expect, test, vi } from 'vitest'
import { createOpenApiDocument } from '../src/app.js'
import type { ApiV2Workspace } from '../src/context.js'
import { createTestApp } from './test-app.js'

const DEPLOYMENT_ID = '123e4567-e89b-42d3-a456-426614174099'
const ARTIFACT_ID = '223e4567-e89b-42d3-a456-426614174000'
const OPERATOR_TOKEN = 'operator-token-that-is-at-least-32-bytes'
const SERVICE_TOKEN = 'service-token-that-is-distinct-and-long-enough'

function publicDeployment(status: 'active' | 'disabled' = 'active') {
  return {
    id: DEPLOYMENT_ID,
    artifact_id: ARTIFACT_ID,
    display_name: 'support-lora endpoint',
    provider: 'openai_compatible' as const,
    registration_mode: 'operator_attested' as const,
    served_model_name: 'support-lora-v1',
    auth_mode: 'none' as const,
    status,
    health_status: 'healthy' as const,
    health_checked_at: '2026-07-28T00:00:00.000Z',
    health_error_code: null,
    created_at: '2026-07-28T00:00:00.000Z',
    disabled_at: status === 'disabled' ? '2026-07-28T00:00:02.000Z' : null,
    updated_at: status === 'disabled' ? '2026-07-28T00:00:02.000Z' : '2026-07-28T00:00:00.000Z',
  }
}

function resolvedDeployment() {
  return {
    id: DEPLOYMENT_ID,
    artifact_id: ARTIFACT_ID,
    create_digest: 'd'.repeat(64),
    provider: 'openai_compatible' as const,
    registration_mode: 'operator_attested' as const,
    served_model_name: 'support-lora-v1',
    endpoint_base_url: 'http://model-service:8000/v1',
    auth_mode: 'none' as const,
    base_model_reference: 'Qwen/Qwen3-0.6B',
    base_model_revision: '0123456789abcdef',
  }
}

function workspace(): ApiV2Workspace {
  return {
    createModelDeployment: vi.fn(async () => publicDeployment()),
    listModelDeployments: vi.fn(async () => ({ items: [publicDeployment()], next_cursor: null })),
    getModelDeployment: vi.fn(async () => publicDeployment()),
    disableModelDeployment: vi.fn(async () => publicDeployment('disabled')),
    checkModelDeployment: vi.fn(async () => publicDeployment()),
    resolveModelDeployment: vi.fn(async () => resolvedDeployment()),
  } as unknown as ApiV2Workspace
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, init)
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe('Model Deployment HTTP contract', () => {
  test('requires the operator role for create, health check, and disable', async () => {
    const fake = workspace()
    const app = createTestApp({
      v2Workspace: fake,
      modelDeploymentOperatorToken: OPERATOR_TOKEN,
      modelDeploymentServiceCredential: SERVICE_TOKEN,
    })
    const createBody = {
      artifact_id: ARTIFACT_ID,
      display_name: 'support-lora endpoint',
      provider: 'openai_compatible',
      served_model_name: 'support-lora-v1',
      endpoint_base_url: 'http://model-service:8000/v1',
      auth_mode: 'none',
    }
    for (const token of [undefined, 'wrong-token-that-is-at-least-32-bytes', SERVICE_TOKEN]) {
      const response = await app.fetch(
        request('/v2/model-deployments', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token === undefined ? {} : bearer(token)),
          },
          body: JSON.stringify(createBody),
        }),
      )
      expect(response.status).toBe(401)
    }

    const created = await app.fetch(
      request('/v2/model-deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearer(OPERATOR_TOKEN) },
        body: JSON.stringify(createBody),
      }),
    )
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual(publicDeployment())

    for (const suffix of ['check', 'disable'] as const) {
      const response = await app.fetch(
        request(`/v2/model-deployments/${DEPLOYMENT_ID}:${suffix}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...bearer(OPERATOR_TOKEN) },
          body: '{}',
        }),
      )
      expect(response.status).toBe(200)
    }
    expect(fake.createModelDeployment).toHaveBeenCalledWith(
      createBody,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(fake.checkModelDeployment).toHaveBeenCalledWith(
      DEPLOYMENT_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(fake.disableModelDeployment).toHaveBeenCalledWith(
      DEPLOYMENT_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  test('reserves endpoint resolution for the service role and keeps it private', async () => {
    const fake = workspace()
    const app = createTestApp({
      v2Workspace: fake,
      modelDeploymentOperatorToken: OPERATOR_TOKEN,
      modelDeploymentServiceCredential: SERVICE_TOKEN,
    })
    for (const token of [undefined, OPERATOR_TOKEN]) {
      const response = await app.fetch(
        request(`/internal/v1/model-deployments/${DEPLOYMENT_ID}:resolve`, {
          headers: token === undefined ? {} : bearer(token),
        }),
      )
      expect(response.status).toBe(401)
    }
    const resolved = await app.fetch(
      request(`/internal/v1/model-deployments/${DEPLOYMENT_ID}:resolve`, {
        headers: bearer(SERVICE_TOKEN),
      }),
    )
    expect(resolved.status).toBe(200)
    expect(resolved.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await resolved.json()).toEqual(resolvedDeployment())
    expect(JSON.stringify(createOpenApiDocument())).not.toContain('/internal/v1/model-deployments')
  })

  test('public list and show projections never expose endpoint or immutable create digest', async () => {
    const app = createTestApp({ v2Workspace: workspace() })
    for (const path of [
      '/v2/model-deployments?limit=20',
      `/v2/model-deployments/${DEPLOYMENT_ID}`,
    ]) {
      const response = await app.fetch(request(path))
      expect(response.status).toBe(200)
      const text = JSON.stringify(await response.json())
      expect(text).not.toContain('endpoint_base_url')
      expect(text).not.toContain('create_digest')
      expect(text).not.toContain('model-service')
    }
  })

  test('fails closed when role credentials are unset and rejects query smuggling', async () => {
    const app = createTestApp({ v2Workspace: workspace() })
    const create = await app.fetch(
      request('/v2/model-deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    )
    expect(create.status).toBe(503)
    const resolve = await app.fetch(
      request(`/internal/v1/model-deployments/${DEPLOYMENT_ID}:resolve`),
    )
    expect(resolve.status).toBe(503)

    const configured = createTestApp({
      v2Workspace: workspace(),
      modelDeploymentOperatorToken: OPERATOR_TOKEN,
    })
    const smuggled = await configured.fetch(
      request(`/v2/model-deployments/${DEPLOYMENT_ID}:check?endpoint=http://evil.test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearer(OPERATOR_TOKEN) },
        body: '{}',
      }),
    )
    expect(smuggled.status).toBe(422)
  })
})
