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
  hashArtifactBytes,
  hashV2DatasetIdentity,
  hashV2ExportFidelity,
  hashV2IdentityClaimKey,
  hashV2IdentityRequest,
  hashV2Record,
  hashV2TransformCache,
  type IdentityClaimHashInputV1,
  type IdentityRequestHashInputV1,
  type SourceRootSeedV1,
  type TransformCacheIdentityV1,
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
    fidelity: CanonicalJsonValue
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
  })

  test('sorts a defensive copy of record digests for unordered dataset identity', () => {
    const base = {
      identity_profile: 'databench-v2-jcs-1',
      record_schema_version: '2.0.0',
      record_digests: ['f'.repeat(64), '0'.repeat(64)],
    } as const satisfies DatasetIdentityEnvelopeV2
    const reversed = { ...base, record_digests: [...base.record_digests].reverse() }

    expect(hashV2DatasetIdentity(base)).toBe(hashV2DatasetIdentity(reversed))
    expect(base.record_digests).toEqual(['f'.repeat(64), '0'.repeat(64)])
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
