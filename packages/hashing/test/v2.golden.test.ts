import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  type CandidateSeedV1,
  type CanonicalJsonValue,
  canonicalJsonV2,
  compareJcsUtf16,
  createArtifactHasher,
  type DatasetIdentityEnvelopeV2,
  deriveV2CandidateId,
  deriveV2PreferenceId,
  deriveV2RecordId,
  deriveV2SignalId,
  type EventSeedV1,
  type ExportFidelityIdentityV1,
  hashArtifactBytes,
  hashV2DatasetIdentity,
  hashV2DatasetIdentityFromSortedRecordDigests,
  hashV2EvaluationRunCreate,
  hashV2ExportFidelity,
  hashV2IdentityClaimKey,
  hashV2IdentityRequest,
  hashV2ModelArtifactImportCreate,
  hashV2Record,
  hashV2SwiftStudioOutputHandle,
  hashV2SwiftStudioSessionCreate,
  hashV2TransformCache,
  type IdentityClaimHashInputV1,
  type IdentityRequestHashInputV1,
  type RecordSeedV1,
  type SourceRootSeedV1,
  type TransformCacheIdentityV1,
  V2_EVALUATION_RUN_CREATE_PROFILE,
  V2_MODEL_ARTIFACT_IMPORT_CREATE_PROFILE,
  V2_SWIFT_STUDIO_SESSION_CREATE_PROFILE,
} from '../src/index.js'

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./golden/fixtures/v2/${name}`, import.meta.url))
const readJson = <T>(name: string): T => JSON.parse(readFileSync(fixturePath(name), 'utf8')) as T

describe('canonicalJsonV2', () => {
  test('matches the RFC 8785 serialization sample byte for byte', () => {
    const input = readJson<unknown>('jcs-rfc8785-official.input.json')
    const expected = readJson<{ canonical: string; utf8_hex: string; blake3: string }>(
      'jcs-rfc8785-official.expected.json',
    )

    const canonical = canonicalJsonV2(input)
    expect(canonical).toBe(expected.canonical)
    expect(Buffer.from(canonical).toString('hex')).toBe(expected.utf8_hex)
    expect(hashArtifactBytes(new TextEncoder().encode(canonical))).toBe(expected.blake3)
  })

  test('uses UTF-16 property order and exact ECMAScript number spelling', () => {
    const input = readJson<{
      property_order: Record<string, string>
      number_values: number[]
      unicode_values: Record<string, string>
    }>('jcs-unicode-number-boundaries.input.json')
    const expected = readJson<{
      property_order_utf8_hex: string
      number_values_canonical: string
      unicode_values_utf8_hex: string
    }>('jcs-unicode-number-boundaries.expected.json')

    expect(Buffer.from(canonicalJsonV2(input.property_order)).toString('hex')).toBe(
      expected.property_order_utf8_hex,
    )
    expect(canonicalJsonV2(input.number_values)).toBe(expected.number_values_canonical)
    expect(Buffer.from(canonicalJsonV2(input.unicode_values)).toString('hex')).toBe(
      expected.unicode_values_utf8_hex,
    )
    expect(['דּ', '😀'].sort(compareJcsUtf16)).toEqual(['😀', 'דּ'])
  })

  test('preserves readonly arrays, null, insertion-independent objects, and negative zero rules', () => {
    const value = Object.freeze({
      z: Object.freeze([null, -0, true, Object.freeze({ b: 2, a: 1 })]),
      a: 'value',
    }) as const

    expect(canonicalJsonV2(value)).toBe('{"a":"value","z":[null,0,true,{"a":1,"b":2}]}')
    expect(canonicalJsonV2({ b: 2, a: 1 })).toBe(canonicalJsonV2({ a: 1, b: 2 }))
  })

  test.each([
    ['undefined', undefined],
    ['bigint', 1n],
    ['date', new Date('2026-01-01T00:00:00Z')],
    ['function', () => undefined],
    ['symbol', Symbol('v2')],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate key', { '\udfff': true }],
  ])('rejects invalid JCS value: %s', (_name, value) => {
    expect(() => canonicalJsonV2(value)).toThrow(TypeError)
  })

  test('rejects cyclic, sparse, accessor, and symbol-keyed containers', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const sparse = Array.from({ length: 1 })
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 1,
    })
    const symbolKeyed = { [Symbol('hidden')]: true }

    for (const value of [cycle, sparse, accessor, symbolKeyed]) {
      expect(() => canonicalJsonV2(value)).toThrow(TypeError)
    }
  })
})

interface DomainFixture {
  inputs: {
    record_seed: SourceRootSeedV1
    candidate_seed: CandidateSeedV1
    signal_seed: EventSeedV1
    preference_seed: EventSeedV1
    record: CanonicalJsonValue
    dataset: DatasetIdentityEnvelopeV2
    cache: TransformCacheIdentityV1
    claim: IdentityClaimHashInputV1
    request: IdentityRequestHashInputV1
    fidelity: ExportFidelityIdentityV1
  }
  expected: Record<string, string>
}

describe('v2 named hash domains', () => {
  test('matches independently generated fixed vectors for every V1 domain', () => {
    const fixture = readJson<DomainFixture>('hash-domain-separation.expected.json')
    const actual = {
      record_id: deriveV2RecordId(fixture.inputs.record_seed),
      candidate_id: deriveV2CandidateId(fixture.inputs.candidate_seed),
      signal_id: deriveV2SignalId(fixture.inputs.signal_seed),
      preference_id: deriveV2PreferenceId(fixture.inputs.preference_seed),
      record_digest: hashV2Record(fixture.inputs.record),
      dataset_version: hashV2DatasetIdentity(fixture.inputs.dataset),
      cache_key: hashV2TransformCache(fixture.inputs.cache),
      claim_key_digest: hashV2IdentityClaimKey(fixture.inputs.claim),
      request_digest: hashV2IdentityRequest(fixture.inputs.request),
      fidelity_digest: hashV2ExportFidelity(fixture.inputs.fidelity),
    }

    expect(actual).toEqual(fixture.expected)
    expect(new Set(Object.values(actual)).size).toBe(Object.values(actual).length)
    expect(deriveV2SignalId(fixture.inputs.signal_seed).slice(4)).not.toBe(
      deriveV2PreferenceId(fixture.inputs.signal_seed).slice(5),
    )

    const fidelityCanonical =
      '{"config_hints":{},"converter":"canonical-jsonl","converter_version":"1.0.0","dataset_version":"5555555555555555555555555555555555555555555555555555555555555555","export_fidelity_profile":"databench-export-fidelity-1","fidelity":{"changes":[],"preserved":["contents"]},"identity_profile":"databench-v2-jcs-1","media_type":"application/x-ndjson","normalized_options":{},"output_count":1}'
    expect(canonicalJsonV2(fixture.inputs.fidelity)).toBe(fidelityCanonical)
    expect(
      hashArtifactBytes(
        new TextEncoder().encode(
          `databench.export-fidelity.databench-export-fidelity-1\0${fidelityCanonical}`,
        ),
      ),
    ).toBe(fixture.expected.fidelity_digest)
  })

  test('sorts a defensive copy of record digests for unordered dataset identity', () => {
    const base = {
      identity_profile: 'databench-v2-jcs-1',
      record_schema_version: '2.0.0',
      record_digests: ['f'.repeat(64), '0'.repeat(64)],
    } as const satisfies DatasetIdentityEnvelopeV2
    const reversed = { ...base, record_digests: [...base.record_digests].reverse() }

    expect(hashV2DatasetIdentity(base)).toBe(hashV2DatasetIdentity(reversed))
    expect(hashV2DatasetIdentityFromSortedRecordDigests([...base.record_digests].sort())).toBe(
      hashV2DatasetIdentity(base),
    )
    expect(base.record_digests).toEqual(['f'.repeat(64), '0'.repeat(64)])
  })

  test('rejects invalid or unsorted incremental dataset digest streams', () => {
    expect(() => hashV2DatasetIdentityFromSortedRecordDigests(['z'.repeat(64)])).toThrow(TypeError)
    expect(() =>
      hashV2DatasetIdentityFromSortedRecordDigests(['f'.repeat(64), '0'.repeat(64)]),
    ).toThrow(TypeError)
  })

  test('normalizes fidelity sets and excludes display-only or extra fields', () => {
    const identity = {
      export_fidelity_profile: 'databench-export-fidelity-1',
      identity_profile: 'databench-v2-jcs-1',
      dataset_version: '5'.repeat(64),
      converter: 'trl-sft',
      converter_version: '1.0.0',
      normalized_options: { include_tools: true },
      media_type: 'application/x-ndjson',
      output_count: 2,
      config_hints: { trainer: 'trl' },
      fidelity: {
        preserved: ['/tools', '/contents', '/tools'],
        changes: [
          {
            path: '/candidates',
            action: 'dropped',
            impact: 'informational',
            reason: 'trainer_omits_generator',
          },
          {
            path: '/contents',
            action: 'transformed',
            impact: 'none',
            reason: 'args_encoded_as_json_string',
          },
          {
            path: '/candidates',
            action: 'dropped',
            impact: 'informational',
            reason: 'trainer_omits_generator',
          },
        ],
      },
    } as const satisfies ExportFidelityIdentityV1
    const normalized = {
      ...identity,
      fidelity: {
        preserved: ['/contents', '/tools'],
        changes: [identity.fidelity.changes[1], identity.fidelity.changes[0]],
      },
    } as const satisfies ExportFidelityIdentityV1
    const widened = { ...identity, suggested_filename: 'ignored.jsonl' }
    const widenedAsIdentity: ExportFidelityIdentityV1 = widened

    const before = structuredClone(identity)
    expect(hashV2ExportFidelity(identity)).toBe(hashV2ExportFidelity(normalized))
    expect(hashV2ExportFidelity(widenedAsIdentity)).toBe(hashV2ExportFidelity(normalized))
    expect(identity).toEqual(before)
  })

  test('excludes snapshot metadata from exact hash envelopes at runtime', () => {
    const identity = {
      identity_profile: 'databench-v2-jcs-1',
      record_schema_version: '2.0.0',
      record_digests: ['0'.repeat(64)],
    } as const satisfies DatasetIdentityEnvelopeV2
    const widenedSnapshot = { ...identity, dataset_version: 'f'.repeat(64), num_records: 1 }

    expect(hashV2DatasetIdentity(widenedSnapshot)).toBe(hashV2DatasetIdentity(identity))
  })
})

interface EntityIdFixture {
  inputs: {
    source_root: RecordSeedV1
    artifact_row: RecordSeedV1
    direct_root: RecordSeedV1
    derived_record: RecordSeedV1
    candidate: CandidateSeedV1
    signal: EventSeedV1
    preference: EventSeedV1
  }
  expected: Record<string, string>
}

describe('v2 identity and version fixed vectors', () => {
  test('locks the canonical evaluation run create request domain', () => {
    const identity = {
      evaluation_run_create_profile: V2_EVALUATION_RUN_CREATE_PROFILE,
      provider: 'evalscope' as const,
      provider_task_id: 'task-fixed-1',
      dataset_version: 'a'.repeat(64),
      source_ref: 'main',
      converter: 'evalscope-general-qa' as const,
      converter_version: '1.0.0',
      normalized_options: { target_source: 'none' },
      fidelity_digest: 'b'.repeat(64),
      benchmark: 'general_qa',
      model_name: 'Qwen/Qwen3-8B',
      evalscope_commit: 'c'.repeat(40),
    }
    expect(hashV2EvaluationRunCreate(identity)).toBe(
      'de467c5dd0ce450c5d234cbaefe483bf83ee97c307d578e3928f5150fa6d25b8',
    )
    expect(hashV2EvaluationRunCreate({ ...identity, provider_task_id: 'task-fixed-2' })).not.toBe(
      hashV2EvaluationRunCreate(identity),
    )
  })

  test('locks the canonical Swift Studio Session create domain and excludes display metadata', () => {
    const identity = {
      swift_studio_session_create_profile: V2_SWIFT_STUDIO_SESSION_CREATE_PROFILE,
      namespace: '11111111-1111-4111-8111-111111111111',
      dataset_version: 'a'.repeat(64),
      converter: 'ms-swift' as const,
      converter_version: '1.0.0',
      normalized_options: { columns: { messages: 'messages' }, shuffle: false },
      fidelity_digest: 'b'.repeat(64),
      output_count: 32,
      provider: 'swift-studio' as const,
      upstream_commit: 'c'.repeat(40),
      image_digest: 'd'.repeat(64),
      runtime_capability_digest: 'e'.repeat(64),
    }
    const canonical =
      '{"converter":"ms-swift","converter_version":"1.0.0","dataset_version":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fidelity_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","image_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","namespace":"11111111-1111-4111-8111-111111111111","normalized_options":{"columns":{"messages":"messages"},"shuffle":false},"output_count":32,"provider":"swift-studio","runtime_capability_digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","swift_studio_session_create_profile":"swift-studio-session-create-v1","upstream_commit":"cccccccccccccccccccccccccccccccccccccccc"}'
    expect(canonicalJsonV2(identity)).toBe(canonical)
    expect(
      hashArtifactBytes(
        new TextEncoder().encode(
          `databench.swift-studio-session-create.swift-studio-session-create-v1\0${canonical}`,
        ),
      ),
    ).toBe('800545a120fba5c2f243dd1dd5ee90c00d727e6d6c5ea02ea1487a2b5c2752e3')
    expect(hashV2SwiftStudioSessionCreate(identity)).toBe(
      '800545a120fba5c2f243dd1dd5ee90c00d727e6d6c5ea02ea1487a2b5c2752e3',
    )
    expect(
      hashV2SwiftStudioSessionCreate({ ...identity, dataset_version: 'f'.repeat(64) }),
    ).not.toBe(hashV2SwiftStudioSessionCreate(identity))

    const displayOnly = { ...identity, display_ref: 'main' }
    const widenedIdentity: typeof identity = displayOnly
    expect(hashV2SwiftStudioSessionCreate(widenedIdentity)).toBe(
      hashV2SwiftStudioSessionCreate(identity),
    )
  })

  test('locks the Model Artifact import identity without storing the opaque output handle', () => {
    const outputHandleDigest = hashV2SwiftStudioOutputHandle(
      'swo_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    )
    expect(outputHandleDigest).toBe(
      'c46de776e3cc6776ebfc31ce4f8d89784af9f243704ee03e28b7d7d9ac92368b',
    )
    const identity = {
      model_artifact_import_create_profile: V2_MODEL_ARTIFACT_IMPORT_CREATE_PROFILE,
      namespace: '11111111-1111-4111-8111-111111111111',
      studio_session_id: '22222222-2222-4222-8222-222222222222',
      output_handle_digest: outputHandleDigest,
      artifact_kind: 'lora_adapter' as const,
      display_name: 'customer-service-lora',
      base_model: {
        reference: 'Qwen/Qwen3-0.6B',
        revision: '0123456789abcdef',
      },
    }
    expect(hashV2ModelArtifactImportCreate(identity)).toBe(
      '2b06972781ca71726fa6a44240bde2e080edab4d2a23a5bcb9348e9ae4524c81',
    )
    expect(
      hashV2ModelArtifactImportCreate({
        ...identity,
        base_model: { ...identity.base_model, revision: null },
      }),
    ).not.toBe(hashV2ModelArtifactImportCreate(identity))
  })

  test('matches all record seed profiles and four public entity prefixes', () => {
    const fixture = readJson<EntityIdFixture>('entity-id-four-prefixes.expected.json')
    expect({
      source_root: deriveV2RecordId(fixture.inputs.source_root),
      artifact_row: deriveV2RecordId(fixture.inputs.artifact_row),
      direct_root: deriveV2RecordId(fixture.inputs.direct_root),
      derived_record: deriveV2RecordId(fixture.inputs.derived_record),
      candidate: deriveV2CandidateId(fixture.inputs.candidate),
      signal: deriveV2SignalId(fixture.inputs.signal),
      preference: deriveV2PreferenceId(fixture.inputs.preference),
    }).toEqual(fixture.expected)
  })

  test('locks the all-fields record canonical bytes and domain digest', () => {
    const record = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            '../../schema/test/golden/fixtures/v2/record-all-fields.input.json',
            import.meta.url,
          ),
        ),
        'utf8',
      ),
    ) as Record<string, CanonicalJsonValue>
    const expected = readJson<{
      canonical_utf8_length: number
      canonical_json_blake3: string
      record_digest: string
    }>('record-digest-all-fields.expected.json')
    const canonical = canonicalJsonV2(record)

    expect(new TextEncoder().encode(canonical).byteLength).toBe(expected.canonical_utf8_length)
    expect(hashArtifactBytes(new TextEncoder().encode(canonical))).toBe(
      expected.canonical_json_blake3,
    )
    expect(hashV2Record(record)).toBe(expected.record_digest)

    for (const key of Object.keys(record)) {
      const changed = structuredClone(record)
      changed[key] = changedValue(changed[key])
      expect(hashV2Record(changed), key).not.toBe(expected.record_digest)
    }
  })

  test('locks the v2.0 empty dataset version and canonical envelope', () => {
    const fixture = readJson<{
      input: DatasetIdentityEnvelopeV2
      canonical: string
      expected_version: string
    }>('dataset-empty-2-0-0.expected.json')
    expect(canonicalJsonV2(fixture.input)).toBe(fixture.canonical)
    expect(hashV2DatasetIdentity(fixture.input)).toBe(fixture.expected_version)
    expect(hashV2DatasetIdentityFromSortedRecordDigests([])).toBe(fixture.expected_version)
  })

  test('keeps transform input order and every cache identity field significant', () => {
    const base = {
      identity_profile: 'databench-v2-jcs-1',
      op: 'mix',
      op_version: '1.0.0',
      input_dataset_versions: ['1'.repeat(64), '2'.repeat(64)],
      params: { weight: 1 },
    } as const satisfies TransformCacheIdentityV1
    const digest = hashV2TransformCache(base)
    const variants: TransformCacheIdentityV1[] = [
      { ...base, op: 'filter' },
      { ...base, op_version: '1.0.1' },
      { ...base, input_dataset_versions: [...base.input_dataset_versions].reverse() },
      { ...base, params: { weight: 2 } },
    ]
    for (const variant of variants) {
      expect(hashV2TransformCache(variant)).not.toBe(digest)
    }
  })
})

function changedValue(value: CanonicalJsonValue | undefined): CanonicalJsonValue {
  if (value === null) {
    return 'changed'
  }
  if (Array.isArray(value)) {
    return [...value, null]
  }
  if (typeof value === 'object') {
    return { ...value, changed: true }
  }
  if (typeof value === 'string') {
    return `${value}-changed`
  }
  if (typeof value === 'number') {
    return value + 1
  }
  return !value
}

describe('incremental artifact BLAKE3', () => {
  test('matches one-shot bytes while isolated hashers are interleaved', () => {
    const encoder = new TextEncoder()
    const first = createArtifactHasher()
    const second = createArtifactHasher()

    first.update(encoder.encode('em'))
    second.update(encoder.encode('empty'))
    first.update(encoder.encode('pty'))

    const expected = hashArtifactBytes(encoder.encode('empty'))
    expect(first.digestHex()).toBe(expected)
    expect(second.digestHex()).toBe(expected)
  })

  test('supports empty input and rejects use after finalization', () => {
    const hasher = createArtifactHasher()
    expect(hasher.digestHex()).toBe(hashArtifactBytes(new Uint8Array()))
    expect(() => hasher.update(new Uint8Array())).toThrow(/finalized/)
    expect(() => hasher.digestHex()).toThrow(/more than once/)
  })
})
