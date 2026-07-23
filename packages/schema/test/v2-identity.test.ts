import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  deriveV2RecordId,
  V2_IDENTITY_CLAIM_PROFILE,
  V2_IDENTITY_PROFILE,
} from '@databench/hashing'
import { describe, expect, test } from 'vitest'
import { ZodError } from 'zod'
import {
  compareExistingDerivedRevisionClaimV2,
  compareExistingIdentityClaimV2,
  DatasetIdentityEnvelopeV2Schema,
  DerivedRecordSeedV1Schema,
  IdentityClaimIntegrityErrorV2,
  IdentityClaimKeyV1Schema,
  IdentityConflictErrorV2,
  IdentityCreationRequestV1Schema,
  IdentityNamespaceV2Schema,
  materializeIdentityCreationRequestV2,
  materializeIdentityKeyV2,
  type PostTrainingRecordV2,
  prepareIdentityClaimV2,
  SourceRootSeedV1Schema,
  TransformCacheIdentityV1Schema,
} from '../src/index.js'

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./golden/fixtures/v2/${name}`, import.meta.url))
const readJson = <T>(name: string): T => JSON.parse(readFileSync(fixturePath(name), 'utf8')) as T

interface IdentityFixture {
  namespace: string
  seeds: Record<string, unknown>
  expected: Record<string, { entity_id: string; claim_key_digest: string; request_digest: string }>
  random_direct_expected: {
    entity_id: string
    claim_key_digest: string
    request_digest: string
  }
}

const record = readJson<PostTrainingRecordV2>('record-all-fields.input.json')
const fixture = readJson<IdentityFixture>('identity-claim-idempotency-conflict.expected.json')

describe('v2 identity requests and claims', () => {
  test('prepares seven strict profile claims with fixed IDs and digests', () => {
    const requests = buildRequests(record, fixture.seeds)
    const actual = Object.fromEntries(
      Object.entries(requests).map(([name, request]) => {
        const prepared = prepareIdentityClaimV2(fixture.namespace, request)
        return [
          name,
          {
            entity_id: prepared.entity_id,
            claim_key_digest: prepared.claim_key_digest,
            request_digest: prepared.request_digest,
          },
        ]
      }),
    )
    expect(actual).toEqual(fixture.expected)
  })

  test('keeps ordinary claims idempotent and rejects changed initial semantics', () => {
    const request = buildRequests(record, fixture.seeds).direct_root
    const first = prepareIdentityClaimV2(fixture.namespace, request)
    const same = prepareIdentityClaimV2(fixture.namespace, structuredClone(request))
    const changedRequest = structuredClone(request)
    changedRequest.initial_record.extra = { ...changedRequest.initial_record.extra, changed: true }
    const changed = prepareIdentityClaimV2(fixture.namespace, changedRequest)

    expect(compareExistingIdentityClaimV2(first, same)).toBe('existing_same_request')
    expect(first.entity_id).toBe(changed.entity_id)
    expect(first.claim_key_digest).toBe(changed.claim_key_digest)
    expect(first.request_digest).not.toBe(changed.request_digest)
    expect(() => compareExistingIdentityClaimV2(first, changed)).toThrow(IdentityConflictErrorV2)
    try {
      compareExistingIdentityClaimV2(first, changed)
      throw new Error('Expected the changed request to conflict')
    } catch (error) {
      expect(error).toMatchObject({ detail: { reason: 'claim_request_mismatch' } })
    }

    const differentClaim = prepareIdentityClaimV2(
      fixture.namespace,
      buildRequests(record, fixture.seeds).source_root,
    )
    try {
      compareExistingIdentityClaimV2(first, differentClaim)
      throw new Error('Expected the different claim to conflict')
    } catch (error) {
      expect(error).toMatchObject({ detail: { reason: 'claim_identity_mismatch' } })
    }
  })

  test('classifies invalid stored claims as integrity failures and invalid incoming claims as validation failures', () => {
    const request = buildRequests(record, fixture.seeds).direct_root
    const claim = prepareIdentityClaimV2(fixture.namespace, request)
    const invalid = { ...claim, request_digest: 'invalid' }

    expect(() => compareExistingIdentityClaimV2(invalid, claim)).toThrow(
      IdentityClaimIntegrityErrorV2,
    )
    expect(() => compareExistingIdentityClaimV2(claim, invalid)).toThrow(ZodError)
  })

  test('allows a new derived revision when only exact parent revision semantics change', () => {
    const request = buildRequests(record, fixture.seeds).derived_record
    const first = prepareIdentityClaimV2(fixture.namespace, request)
    const changedRequest = structuredClone(request)
    const parent = changedRequest.initial_record.lineage?.parent_refs[0]
    if (!parent) {
      throw new Error('derived fixture parent is missing')
    }
    parent.record_digest = '9'.repeat(64)
    const changed = prepareIdentityClaimV2(fixture.namespace, changedRequest)

    expect(first.entity_id).toBe(changed.entity_id)
    expect(first.claim_key_digest).toBe(changed.claim_key_digest)
    expect(first.request_digest).not.toBe(changed.request_digest)
    expect(() => compareExistingIdentityClaimV2(first, changed)).toThrow(IdentityConflictErrorV2)
    expect(compareExistingDerivedRevisionClaimV2(first, changed)).toBe('existing_derived_identity')
  })

  test('rejects invalid namespace, owner, producer, parent, index, and extra fields', () => {
    expect(IdentityNamespaceV2Schema.safeParse(fixture.namespace.toUpperCase()).success).toBe(false)
    expect(
      DerivedRecordSeedV1Schema.safeParse({
        ...(fixture.seeds.derived_record as object),
        parent_ids: [record.lineage?.parent_refs[0]?.id, record.lineage?.parent_refs[0]?.id],
      }).success,
    ).toBe(false)
    expect(
      DerivedRecordSeedV1Schema.safeParse({
        ...(fixture.seeds.derived_record as object),
        output_index: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false)

    const candidate = buildRequests(record, fixture.seeds).candidate
    expect(
      IdentityCreationRequestV1Schema.safeParse({
        ...candidate,
        owner_record_id: `rec_${'0'.repeat(64)}`,
      }).success,
    ).toBe(false)
    const signal = buildRequests(record, fixture.seeds).signal
    expect(
      IdentityCreationRequestV1Schema.safeParse({
        ...signal,
        seed: { ...signal.seed, producer: 'different-producer' },
      }).success,
    ).toBe(false)
    expect(
      IdentityCreationRequestV1Schema.safeParse({ ...candidate, unexpected: true }).success,
    ).toBe(false)

    for (const request of [
      buildRequests(record, fixture.seeds).artifact_row,
      buildRequests(record, fixture.seeds).direct_root,
    ]) {
      const ambiguous = structuredClone(request)
      if (!ambiguous.initial_record.source) {
        throw new Error('identity fixture source is missing')
      }
      ambiguous.initial_record.source.original_id = 'stable-upstream-id'
      expect(IdentityCreationRequestV1Schema.safeParse(ambiguous).success).toBe(false)
    }
  })

  test('validates proposed record IDs against full canonical record invariants', () => {
    const request = buildRequests(record, fixture.seeds).direct_root
    const proposedId = deriveV2RecordId(request.seed)
    const selfParent = structuredClone(request)
    selfParent.initial_record.lineage = {
      parent_refs: [{ id: proposedId, record_digest: '8'.repeat(64) }],
      recipe: null,
      recipe_revision: null,
      run_id: null,
      steps: [],
    }
    expect(() => prepareIdentityClaimV2(fixture.namespace, selfParent)).toThrow()
  })

  test('rejects invalid local candidate, signal, and preference semantics before claiming', () => {
    const candidate = structuredClone(buildRequests(record, fixture.seeds).candidate)
    const duplicateSignal = candidate.initial_candidate.signals[0]
    if (!duplicateSignal) {
      throw new Error('identity fixture candidate signal is missing')
    }
    candidate.initial_candidate.signals.push(structuredClone(duplicateSignal))
    expect(IdentityCreationRequestV1Schema.safeParse(candidate).success).toBe(false)
    expect(() => prepareIdentityClaimV2(fixture.namespace, candidate)).toThrow()

    const signal = structuredClone(buildRequests(record, fixture.seeds).signal)
    signal.seed.producer = 'person@example.com'
    signal.initial_signal.source.id = 'person@example.com'
    expect(IdentityCreationRequestV1Schema.safeParse(signal).success).toBe(false)
    expect(() => prepareIdentityClaimV2(fixture.namespace, signal)).toThrow()

    const preference = structuredClone(buildRequests(record, fixture.seeds).preference)
    preference.initial_preference.right_candidate_id =
      preference.initial_preference.left_candidate_id
    expect(IdentityCreationRequestV1Schema.safeParse(preference).success).toBe(false)
    expect(() => prepareIdentityClaimV2(fixture.namespace, preference)).toThrow()

    const credentialCandidate = structuredClone(buildRequests(record, fixture.seeds).candidate)
    if (!credentialCandidate.initial_candidate.generator) {
      throw new Error('identity fixture candidate generator is missing')
    }
    credentialCandidate.initial_candidate.generator.parameters = { api_key: 'secret' }
    expect(IdentityCreationRequestV1Schema.safeParse(credentialCandidate).success).toBe(false)
    expect(() => prepareIdentityClaimV2(fixture.namespace, credentialCandidate)).toThrow()

    const credentialSignal = structuredClone(buildRequests(record, fixture.seeds).signal)
    credentialSignal.initial_signal.value = {
      type: 'json',
      value: { api_key: 'secret' },
    }
    expect(IdentityCreationRequestV1Schema.safeParse(credentialSignal).success).toBe(false)
    expect(() => prepareIdentityClaimV2(fixture.namespace, credentialSignal)).toThrow()

    const badTrajectory = structuredClone(buildRequests(record, fixture.seeds).candidate)
    const functionCall = badTrajectory.initial_candidate.contents[0]?.parts[0]
    const userContent = badTrajectory.initial_candidate.contents[1]
    if (functionCall?.type !== 'function_call' || !userContent) {
      throw new Error('identity fixture candidate trajectory is missing')
    }
    userContent.parts = [structuredClone(functionCall)]
    expect(IdentityCreationRequestV1Schema.safeParse(badTrajectory).success).toBe(false)
    expect(() => prepareIdentityClaimV2(fixture.namespace, badTrajectory)).toThrow()
  })

  test('materializes absent random identity keys exactly once and never treats empty as absent', () => {
    let calls = 0
    const value = materializeIdentityKeyV2(null, () => {
      calls += 1
      return Uint8Array.from({ length: 32 }, (_, index) => index)
    })
    expect(value).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
    expect(calls).toBe(1)
    expect(materializeIdentityKeyV2('stable', () => Uint8Array.from([1]))).toBe('stable')
    expect(() => materializeIdentityKeyV2('', () => new Uint8Array(32))).toThrow()
    expect(() => materializeIdentityKeyV2(null, () => new Uint8Array(31))).toThrow(TypeError)
  })

  test('materializes and freezes a creation draft before retries or claim hashing', () => {
    const stableDirect = buildRequests(record, fixture.seeds).direct_root
    const draft = {
      ...stableDirect,
      seed: { ...stableDirect.seed, idempotency_key_or_random_seed: null },
    }
    let calls = 0
    const materialized = materializeIdentityCreationRequestV2(draft, () => {
      calls += 1
      return new Uint8Array(32).fill(0xab)
    })
    const first = prepareIdentityClaimV2(fixture.namespace, materialized)
    const retry = prepareIdentityClaimV2(fixture.namespace, materialized)

    expect(calls).toBe(1)
    expect(materialized.creation_profile).toBe('direct-root-v1')
    if (materialized.creation_profile !== 'direct-root-v1') {
      throw new Error('materialized direct draft changed profile')
    }
    expect(materialized.seed.idempotency_key_or_random_seed).toBe('ab'.repeat(32))
    expect(isDeepFrozen(materialized)).toBe(true)
    expect(isDeepFrozen(draft)).toBe(false)
    draft.initial_record.extra = { caller_changed: true }
    expect(materialized.initial_record.extra).not.toHaveProperty('caller_changed')
    expect({
      entity_id: first.entity_id,
      claim_key_digest: first.claim_key_digest,
      request_digest: first.request_digest,
    }).toEqual(fixture.random_direct_expected)
    expect(retry).toEqual(first)

    let stableCalls = 0
    const stable = materializeIdentityCreationRequestV2(
      buildRequests(record, fixture.seeds).candidate,
      () => {
        stableCalls += 1
        return new Uint8Array(32)
      },
    )
    expect(stableCalls).toBe(0)
    expect(stable.creation_profile).toBe('candidate-v1')
  })

  test('uses UTF-8 byte limits and strict runtime hash envelopes', () => {
    expect(materializeIdentityKeyV2('界'.repeat(341), () => new Uint8Array(32))).toHaveLength(341)
    expect(() => materializeIdentityKeyV2('界'.repeat(342), () => new Uint8Array(32))).toThrow()

    expect(
      DatasetIdentityEnvelopeV2Schema.safeParse({
        identity_profile: V2_IDENTITY_PROFILE,
        record_schema_version: '2.0.0',
        record_digests: [],
        created_at: '2026-07-23T00:00:00Z',
      }).success,
    ).toBe(false)
    expect(
      TransformCacheIdentityV1Schema.safeParse({
        identity_profile: V2_IDENTITY_PROFILE,
        op: 'filter',
        op_version: '1.0.0',
        input_dataset_versions: ['8'.repeat(64)],
        params: {},
      }).success,
    ).toBe(true)
  })

  test('rejects lone surrogates in seeds and initial semantic strings before hashing', () => {
    const sourceSeed = structuredClone(fixture.seeds.source_root) as {
      source: { name: string }
    }
    sourceSeed.source.name = '\ud800'
    expect(SourceRootSeedV1Schema.safeParse(sourceSeed).success).toBe(false)

    const request = structuredClone(buildRequests(record, fixture.seeds).direct_root)
    const part = request.initial_record.contents[0]?.parts[0]
    if (part?.type !== 'text') {
      throw new Error('identity fixture text part is missing')
    }
    part.text = '\ud800'
    expect(IdentityCreationRequestV1Schema.safeParse(request).success).toBe(false)
    expect(() => materializeIdentityCreationRequestV2(request, () => new Uint8Array(32))).toThrow()
  })

  test('rejects a claim envelope whose root seed namespace differs', () => {
    const source = fixture.seeds.source_root
    expect(
      IdentityClaimKeyV1Schema.safeParse({
        claim_profile: V2_IDENTITY_CLAIM_PROFILE,
        identity_profile: V2_IDENTITY_PROFILE,
        namespace: '018f0f3e-7b4a-7c12-8d33-000000000000',
        entity_kind: 'record',
        creation_profile: 'source-root-v1',
        claim_material: source,
      }).success,
    ).toBe(false)
  })
})

function buildRequests(base: PostTrainingRecordV2, seeds: Record<string, unknown>) {
  const candidate = base.candidates[0]
  const signal = candidate?.signals[0]
  const preference = base.preference_relations[0]
  if (!candidate || !signal || !preference) {
    throw new Error('identity fixture entities are missing')
  }
  const initialRecord = omitId(base)
  const initialRecordWithoutOriginalId = structuredClone(initialRecord)
  if (initialRecordWithoutOriginalId.source) {
    initialRecordWithoutOriginalId.source.original_id = null
  }
  const initialCandidate = omitId(candidate)
  const initialSignal = omitId(signal)
  const initialPreference = omitId(preference)
  return {
    source_root: {
      creation_profile: 'source-root-v1' as const,
      seed: seeds.source_root,
      initial_record: structuredClone(initialRecord),
    },
    artifact_row: {
      creation_profile: 'artifact-row-v1' as const,
      seed: seeds.artifact_row,
      initial_record: structuredClone(initialRecordWithoutOriginalId),
    },
    direct_root: {
      creation_profile: 'direct-root-v1' as const,
      seed: seeds.direct_root as { namespace: string; idempotency_key_or_random_seed: string },
      initial_record: structuredClone(initialRecordWithoutOriginalId),
    },
    derived_record: {
      creation_profile: 'derived-record-v1' as const,
      seed: seeds.derived_record as {
        op: string
        op_version: string
        params: Record<string, never>
        parent_ids: string[]
        output_index: number
      },
      initial_record: structuredClone(initialRecord),
    },
    candidate: {
      creation_profile: 'candidate-v1' as const,
      owner_record_id: base.id,
      seed: seeds.candidate as {
        record_id: string
        generation_run_id: string
        output_index: number
      },
      initial_candidate: initialCandidate,
    },
    signal: {
      creation_profile: 'signal-event-v1' as const,
      owner_candidate_id: candidate.id,
      seed: seeds.signal as { owner_id: string; producer: string; producer_event_key: string },
      initial_signal: initialSignal,
    },
    preference: {
      creation_profile: 'preference-event-v1' as const,
      owner_record_id: base.id,
      seed: seeds.preference as { owner_id: string; producer: string; producer_event_key: string },
      initial_preference: initialPreference,
    },
  }
}

function omitId<Entity extends { id: string }>(entity: Entity): Omit<Entity, 'id'> {
  const { id: _id, ...initial } = structuredClone(entity)
  return initial
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return true
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
}
