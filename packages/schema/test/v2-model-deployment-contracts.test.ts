import { describe, expect, test } from 'vitest'
import {
  CreateModelDeploymentRequestV2Schema,
  ModelDeploymentV2Schema,
  normalizeModelDeploymentEndpointBaseUrlV2,
  ResolvedModelDeploymentV2Schema,
} from '../src/index.js'

const DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111'
const ARTIFACT_ID = '22222222-2222-4222-8222-222222222222'

function publicDeployment() {
  return {
    id: DEPLOYMENT_ID,
    artifact_id: ARTIFACT_ID,
    display_name: 'customer-service-lora',
    provider: 'openai_compatible',
    registration_mode: 'operator_attested',
    served_model_name: 'customer-service-lora-v1',
    auth_mode: 'none',
    status: 'active',
    health_status: 'unknown',
    health_checked_at: null,
    health_error_code: null,
    created_at: '2026-07-29T00:00:00.000Z',
    disabled_at: null,
    updated_at: '2026-07-29T00:00:00.000Z',
  }
}

describe('V2 Model Deployment contracts', () => {
  test('accepts only the operator-attested OpenAI-compatible registration shape', () => {
    const request = {
      artifact_id: ARTIFACT_ID,
      display_name: 'customer-service-lora',
      provider: 'openai_compatible',
      served_model_name: 'customer-service-lora-v1',
      endpoint_base_url: 'http://model.internal:8000/v1',
      auth_mode: 'none',
    }
    expect(CreateModelDeploymentRequestV2Schema.parse(request)).toEqual(request)
    for (const invalid of [
      { ...request, endpoint_base_url: 'file:///models/adapter' },
      { ...request, endpoint_base_url: 'http://user:secret@model.internal/v1' },
      { ...request, endpoint_base_url: 'http://model.internal/v1?token=secret' },
      { ...request, auth_mode: 'bearer' },
      { ...request, unknown: true },
    ]) {
      expect(CreateModelDeploymentRequestV2Schema.safeParse(invalid).success).toBe(false)
    }
    expect(normalizeModelDeploymentEndpointBaseUrlV2('HTTP://MODEL.INTERNAL:80/v1///')).toBe(
      'http://model.internal/v1',
    )
  })

  test('keeps endpoint and create digest out of the public Deployment response', () => {
    const deployment = publicDeployment()
    expect(ModelDeploymentV2Schema.parse(deployment)).toEqual(deployment)
    expect(
      ModelDeploymentV2Schema.safeParse({
        ...deployment,
        endpoint_base_url: 'http://model.internal:8000/v1',
      }).success,
    ).toBe(false)
    expect(
      ModelDeploymentV2Schema.safeParse({ ...deployment, create_digest: 'a'.repeat(64) }).success,
    ).toBe(false)
  })

  test('enforces status and health observation invariants', () => {
    const deployment = publicDeployment()
    expect(
      ModelDeploymentV2Schema.safeParse({
        ...deployment,
        health_status: 'unhealthy',
        health_checked_at: deployment.created_at,
        health_error_code: 'timeout',
      }).success,
    ).toBe(true)
    expect(
      ModelDeploymentV2Schema.safeParse({
        ...deployment,
        status: 'disabled',
        disabled_at: null,
      }).success,
    ).toBe(false)
    expect(
      ModelDeploymentV2Schema.safeParse({
        ...deployment,
        health_status: 'healthy',
        health_checked_at: deployment.created_at,
        health_error_code: 'network_error',
      }).success,
    ).toBe(false)
  })

  test('exposes endpoint and exact Artifact binding only on the internal resolver contract', () => {
    expect(
      ResolvedModelDeploymentV2Schema.parse({
        id: DEPLOYMENT_ID,
        artifact_id: ARTIFACT_ID,
        create_digest: 'a'.repeat(64),
        provider: 'openai_compatible',
        registration_mode: 'operator_attested',
        served_model_name: 'customer-service-lora-v1',
        endpoint_base_url: 'http://model.internal:8000/v1',
        auth_mode: 'none',
        base_model_reference: 'Qwen/Qwen3-0.6B',
        base_model_revision: '0123456789abcdef',
      }),
    ).toMatchObject({ id: DEPLOYMENT_ID, artifact_id: ARTIFACT_ID })
  })
})
