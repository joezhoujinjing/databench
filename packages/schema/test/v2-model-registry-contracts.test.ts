import { readFileSync } from 'node:fs'
import { hashV2ModelSourceEvidence } from '@databench/hashing'
import { describe, expect, test } from 'vitest'
import {
  classifyModelVersionSourceV2,
  ModelRegistrationInspectRequestV2Schema,
  ModelRegistrationPlanArtifactIdentityV1Schema,
  ModelRegistrationSourceV2Schema,
  ModelSourceEvidenceIdentityV1Schema,
  ModelSourceEvidenceV2Schema,
  ModelVersionCreateRepositoryIdentityV1Schema,
} from '../src/index.js'

const MODEL_ID = '8d5e4c3b-2a19-8877-9665-4433221100ff'
const DIGEST = 'a'.repeat(64)
const evidenceFixture = JSON.parse(
  readFileSync(new URL('./fixtures/model-source-evidence-v1.json', import.meta.url), 'utf8'),
) as {
  readonly profile: string
  readonly identity: unknown
  readonly expected_digest: string
  readonly wire_observation: unknown
}

function repositoryRequest() {
  return {
    target: { kind: 'existing_model', model_id: MODEL_ID },
    version_label: ' release-r1 ',
    source: {
      kind: 'repository_reference',
      provider: 'hugging_face',
      repository_id: 'Qwen/Qwen2.5-7B',
      revision: 'abc123',
      revision_kind: 'commit',
      base_model: null,
    },
  } as const
}

function deployment() {
  return {
    display_name: 'Internal Qwen',
    served_model_name: 'qwen',
    connectivity_scope: 'private_network',
    endpoint_base_url: 'https://models.example.test/v1/',
    auth_profile: 'none',
    credential_ref: null,
    declared_capabilities: { interfaces: ['chat_completions'], context_limit: null },
  } as const
}

describe('Model registry strict contracts', () => {
  test('normalizes bounded text and rejects extra keys at every request boundary', () => {
    const parsed = ModelRegistrationInspectRequestV2Schema.parse(repositoryRequest())
    expect(parsed.version_label).toBe('release-r1')
    expect(
      ModelRegistrationInspectRequestV2Schema.safeParse({ ...repositoryRequest(), extra: true })
        .success,
    ).toBe(false)
    expect(
      ModelRegistrationInspectRequestV2Schema.safeParse({
        ...repositoryRequest(),
        source: { ...repositoryRequest().source, extra: true },
      }).success,
    ).toBe(false)
  })

  test.each([
    ['credential', 'authorization: Bearer hidden'],
    ['absolute path', '/srv/models/qwen'],
    ['Windows path', 'C:\\models\\qwen'],
    ['control character', 'qwen\u0000model'],
    ['lone surrogate', 'qwen\ud800model'],
  ])('rejects %s in repository IDs', (_name, repositoryId) => {
    expect(
      ModelRegistrationInspectRequestV2Schema.safeParse({
        ...repositoryRequest(),
        source: { ...repositoryRequest().source, repository_id: repositoryId },
      }).success,
    ).toBe(false)
  })

  test('enforces the three-way source union and deployment auth/ref consistency', () => {
    expect(
      ModelRegistrationSourceV2Schema.safeParse({
        kind: 'databench_artifact',
        artifact_id: MODEL_ID,
        repository_id: 'forbidden',
      }).success,
    ).toBe(false)
    expect(
      ModelRegistrationSourceV2Schema.safeParse({
        kind: 'existing_service',
        provider: 'openai_compatible',
        external_model_ref: 'qwen',
        external_version_ref: 'r1',
        declared_reference_kind: 'immutable_version',
        base_model: null,
        deployment: { ...deployment(), auth_profile: 'bearer_ref' },
      }).success,
    ).toBe(false)
    expect(
      ModelRegistrationSourceV2Schema.safeParse({
        kind: 'existing_service',
        provider: 'openai_compatible',
        external_model_ref: 'qwen',
        external_version_ref: 'r1',
        declared_reference_kind: 'immutable_version',
        base_model: null,
        deployment: { ...deployment(), credential_ref: 'qwen-prod' },
      }).success,
    ).toBe(false)
  })

  test('keeps nullable base-model binding explicit in source and identity shapes', () => {
    expect(ModelRegistrationInspectRequestV2Schema.parse(repositoryRequest()).source).toMatchObject(
      {
        base_model: null,
      },
    )
    expect(
      ModelVersionCreateRepositoryIdentityV1Schema.parse({
        model_version_create_profile: 'model-version-create-repository-v1',
        namespace: '018f1d8e-7a2b-8c3d-9e4f-1234567890ab',
        model_id: MODEL_ID,
        version_label: 'r1',
        source_fingerprint: DIGEST,
        base_model_reference: null,
        base_model_revision: null,
      }),
    ).toMatchObject({ base_model_reference: null, base_model_revision: null })
  })

  test('classification derives only from source shape and bounded evidence', () => {
    const immutableArtifact = ModelRegistrationSourceV2Schema.parse({
      kind: 'databench_artifact',
      artifact_id: MODEL_ID,
    })
    expect(classifyModelVersionSourceV2(immutableArtifact)).toEqual({
      source_mutability: 'immutable',
      verification_level: 'content_verified',
      evidence_digest: null,
    })

    const mutableRepository = ModelRegistrationSourceV2Schema.parse({
      ...repositoryRequest().source,
      revision_kind: 'tag',
    })
    const verifiedEvidence = ModelSourceEvidenceV2Schema.parse({
      evidence_kind: 'provider_resolution',
      adapter: 'hugging-face',
      adapter_version: '1',
      observed_revision: 'abc123',
      observed_at: '2026-08-04T12:00:00.000Z',
      result: 'verified',
      response_digest: DIGEST,
      license: 'apache-2.0',
      cache_status: 'not_cached',
    })
    expect(classifyModelVersionSourceV2(mutableRepository, [verifiedEvidence])).toEqual({
      source_mutability: 'mutable',
      verification_level: 'provider_verified',
      evidence_digest: null,
    })

    const exactRepository = ModelRegistrationSourceV2Schema.parse({
      ...repositoryRequest().source,
      revision_kind: 'commit',
    })
    expect(classifyModelVersionSourceV2(exactRepository, [verifiedEvidence], DIGEST)).toEqual({
      source_mutability: 'immutable',
      verification_level: 'provider_verified',
      evidence_digest: DIGEST,
    })
    const operatorAttestation = ModelSourceEvidenceV2Schema.parse({
      ...verifiedEvidence,
      evidence_kind: 'operator_attestation',
    })
    expect(classifyModelVersionSourceV2(exactRepository, [operatorAttestation], DIGEST)).toEqual({
      source_mutability: 'unknown',
      verification_level: 'operator_attested',
      evidence_digest: null,
    })
    const opaqueRepository = ModelRegistrationSourceV2Schema.parse({
      ...repositoryRequest().source,
      revision_kind: 'opaque',
    })
    expect(classifyModelVersionSourceV2(opaqueRepository, [verifiedEvidence], DIGEST)).toEqual({
      source_mutability: 'unknown',
      verification_level: 'provider_verified',
      evidence_digest: DIGEST,
    })
    const drift = ModelSourceEvidenceV2Schema.parse({
      ...verifiedEvidence,
      observed_revision: 'different',
      result: 'revision_mismatch',
    })
    expect(
      classifyModelVersionSourceV2(exactRepository, [verifiedEvidence, drift], DIGEST),
    ).toEqual({
      source_mutability: 'unknown',
      verification_level: 'operator_attested',
      evidence_digest: DIGEST,
    })
    expect(
      ModelSourceEvidenceV2Schema.safeParse({
        ...drift,
        observed_revision: null,
        response_digest: null,
      }).success,
    ).toBe(false)
  })

  test('locks the strict source-evidence wire profile and deterministic digest', () => {
    const identity = ModelSourceEvidenceIdentityV1Schema.parse(evidenceFixture.identity)
    const observation = ModelSourceEvidenceV2Schema.parse(evidenceFixture.wire_observation)

    expect(evidenceFixture.profile).toBe('model-source-evidence-v1')
    expect(hashV2ModelSourceEvidence(identity)).toBe(evidenceFixture.expected_digest)
    expect(observation.observed_at).toBe('2026-08-04T12:00:00.000Z')
    expect(
      ModelSourceEvidenceV2Schema.safeParse({
        ...(evidenceFixture.wire_observation as Record<string, unknown>),
        provider_response: { forbidden: true },
      }).success,
    ).toBe(false)
    expect(
      ModelSourceEvidenceIdentityV1Schema.safeParse({
        ...(evidenceFixture.identity as Record<string, unknown>),
        observed_at: observation.observed_at,
      }).success,
    ).toBe(false)
  })

  test('registration plan identity rejects client-injected classification fields and extras', () => {
    const request = repositoryRequest()
    expect(
      ModelRegistrationPlanArtifactIdentityV1Schema.safeParse({
        plan_profile: 'model-registration-plan-artifact-v1',
        namespace: '018f1d8e-7a2b-8c3d-9e4f-1234567890ab',
        normalized_request: {
          ...request,
          source: { kind: 'databench_artifact', artifact_id: MODEL_ID },
        },
        model_id: MODEL_ID,
        model_create_digest: null,
        source_fingerprint: DIGEST,
        version_create_digest: DIGEST,
        classification: {
          source_mutability: 'immutable',
          verification_level: 'content_verified',
          evidence_digest: null,
        },
        extra: true,
      }).success,
    ).toBe(false)
  })
})
