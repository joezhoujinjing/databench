// biome-ignore-all lint/style/noNonNullAssertion: Fixed fixture positions are part of this golden contract.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { canonicalJsonV2 } from '@databench/hashing'
import { describe, expect, test } from 'vitest'
import {
  JsonValueV2Schema,
  normalizeCanonicalRecordV2,
  type PostTrainingRecordV2,
  PostTrainingRecordV2Schema,
  parseCanonicalRecordV2,
  readCompatibleRecordV2,
  writeCompatibleRecordV2,
} from '../src/index.js'

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./golden/fixtures/v2/${name}`, import.meta.url))
const readJson = <T>(name: string): T => JSON.parse(readFileSync(fixturePath(name), 'utf8')) as T

const baseRecord = readJson<PostTrainingRecordV2>('record-all-fields.input.json')
const invalidFixture = readJson<{ mutations: string[] }>('record-cross-field-invalid.input.json')

type Mutation = (record: PostTrainingRecordV2) => void

function callPart(record: PostTrainingRecordV2) {
  const part = record.candidates[0]?.contents[0]?.parts[0]
  if (part?.type !== 'function_call') {
    throw new Error('fixture call part is missing')
  }
  return part
}

function responsePart(record: PostTrainingRecordV2) {
  const part = record.candidates[0]?.contents[1]?.parts[0]
  if (part?.type !== 'function_response') {
    throw new Error('fixture response part is missing')
  }
  return part
}

const mutations: Record<string, Mutation> = {
  'invalid-schema-version': (record) => Reflect.set(record, 'schema_version', '2.0.1'),
  'invalid-record-id': (record) => {
    record.id = 'rec_INVALID'
  },
  'empty-system-instruction': (record) => {
    record.system_instruction = ''
  },
  'unknown-top-level-field': (record) => Reflect.set(record, 'future_field', true),
  'unknown-part-variant': (record) =>
    Reflect.set(record.contents[0]?.parts[0] ?? {}, 'type', 'audio'),
  'empty-content-parts': (record) => {
    record.contents[0]!.parts = []
  },
  'illegal-part-oneof-field': (record) => {
    Reflect.set(record.contents[0]!.parts[0]!, 'function_call', {
      id: 'extra-call',
      name: 'lookup_order',
      args: { order_id: '42' },
    })
  },
  'shared-role-not-alternating': (record) =>
    record.contents.push(structuredClone(record.contents[0]!)),
  'shared-does-not-end-user': (record) => {
    record.contents[0]!.role = 'ai'
  },
  'candidate-does-not-start-ai': (record) => {
    record.candidates[0]!.contents[0]!.role = 'user'
  },
  'candidate-role-not-alternating': (record) => {
    record.candidates[0]!.contents[1]!.role = 'ai'
  },
  'duplicate-call-id': (record) => {
    record.candidates[0]!.contents[0]!.parts.push(structuredClone(callPart(record)))
  },
  'dangling-response': (record) => {
    responsePart(record).function_response.call_id = 'missing-call'
  },
  'response-before-call': (record) => {
    record.contents[0]!.parts.push(structuredClone(responsePart(record)))
    record.candidates[0]!.contents[1]!.parts = [
      {
        type: 'text',
        text: 'Tool response intentionally moved earlier.',
        thought: false,
        thought_signature: null,
        part_metadata: {},
      },
    ]
  },
  'duplicate-response': (record) => {
    record.candidates[0]!.contents[1]!.parts.push(structuredClone(responsePart(record)))
  },
  'undeclared-tool': (record) => {
    callPart(record).function_call.name = 'missing_tool'
  },
  'invalid-tool-args': (record) => {
    Reflect.set(callPart(record).function_call.args, 'order_id', 42)
  },
  'duplicate-candidate-id': (record) => {
    record.candidates[1]!.id = record.candidates[0]!.id
  },
  'empty-generator-model': (record) => {
    record.candidates[0]!.generator!.model = ''
  },
  'negative-token-count': (record) => {
    record.candidates[0]!.token_count = -1
  },
  'duplicate-signal-id': (record) => {
    record.candidates[0]!.signals[1]!.id = record.candidates[0]!.signals[0]!.id
  },
  'empty-category-signal': (record) => {
    const value = record.candidates[0]!.signals[3]!.value
    if (value.type === 'category') {
      value.value = ''
    }
  },
  'non-finite-json-number': (record) => {
    Reflect.set(record.extra, 'demo.non_finite', Number.NaN)
  },
  'invalid-signal-scale': (record) => {
    const value = record.candidates[0]!.signals[0]!.value
    if (value.type === 'number') {
      value.scale_min = 1
    }
  },
  'invalid-signal-supersession': (record) => {
    record.candidates[0]!.signals[1]!.name = 'different-name'
  },
  'multiple-signal-successors': (record) => {
    const successor = structuredClone(record.candidates[0]!.signals[1]!)
    successor.id = `sig_${'9'.repeat(64)}`
    record.candidates[0]!.signals.push(successor)
  },
  'unknown-preference-candidate': (record) => {
    record.preference_relations[0]!.left_candidate_id = `cand_${'9'.repeat(64)}`
  },
  'same-preference-candidate': (record) => {
    record.preference_relations[0]!.right_candidate_id =
      record.preference_relations[0]!.left_candidate_id
  },
  'invalid-preference-supersession': (record) => {
    record.preference_relations[2]!.criterion = 'different'
  },
  'multiple-active-adjudicated': (record) => {
    record.preference_relations[2]!.supersedes = null
  },
  'duplicate-preference-id': (record) => {
    record.preference_relations[1]!.id = record.preference_relations[0]!.id
  },
  'negative-rank': (record) => {
    record.candidates[0]!.rank = -1
  },
  'negative-loss-weight': (record) => {
    record.contents[0]!.loss_weight = -1
  },
  'invalid-file-digest': (record) => {
    const part = record.contents[0]!.parts[1]
    if (part?.type === 'file_data') {
      part.file_data.digest.value = 'BAD'
    }
  },
  'negative-file-size': (record) => {
    const part = record.contents[0]!.parts[1]
    if (part?.type === 'file_data') {
      part.file_data.size_bytes = -1
    }
  },
  'noncanonical-media-type': (record) => {
    const part = record.contents[0]!.parts[1]
    if (part?.type === 'file_data') {
      part.file_data.media_type = 'IMAGE/PNG; charset=binary'
    }
  },
  'signed-file-uri': (record) => {
    const part = record.contents[0]!.parts[1]
    if (part?.type === 'file_data') {
      part.file_data.uri = 'https://example.com/file?x-amz-signature=secret'
    }
  },
  'invalid-verifier-route': (record) => {
    record.verification!.verifier = 'https://example.com/verifier'
  },
  'missing-verification-field': (record) => {
    Reflect.deleteProperty(record.verification ?? {}, 'constraint')
  },
  'credential-in-config': (record) => {
    Reflect.set(record.verification!.config, 'api_key', 'secret')
  },
  'invalid-created-at': (record) => {
    record.candidates[0]!.signals[0]!.created_at = '2026-07-23T16:00:00+08:00'
  },
  'invalid-calendar-date': (record) => {
    record.candidates[0]!.signals[0]!.created_at = '2026-02-30T08:00:00Z'
  },
  'human-email-source': (record) => {
    record.candidates[0]!.signals[0]!.source.id = 'person@example.com'
  },
  'invalid-source-url': (record) => {
    record.source!.url = 'https://user:password@example.com/data'
  },
  'empty-source-name': (record) => {
    record.source!.name = ''
  },
  'invalid-language-tag': (record) => {
    record.lang = 'not_a_language'
  },
  'self-parent': (record) => {
    record.lineage!.parent_refs[0]!.id = record.id
  },
  'duplicate-parent': (record) => {
    record.lineage!.parent_refs.push(structuredClone(record.lineage!.parent_refs[0]!))
  },
  'invalid-parent-digest': (record) => {
    record.lineage!.parent_refs[0]!.record_digest = 'BAD'
  },
  'unpaired-recipe': (record) => {
    record.lineage!.recipe_revision = null
  },
  'empty-lineage': (record) => {
    record.lineage = {
      parent_refs: [],
      recipe: null,
      recipe_revision: null,
      run_id: null,
      steps: [],
    }
  },
  'unsorted-tags': (record) => {
    record.tags.reverse()
  },
  'duplicate-tool-name': (record) => {
    record.tools.push(structuredClone(record.tools[0]!))
  },
}

describe('PostTrainingRecordV2 strict writer schema', () => {
  test('round-trips the all-fields fixture without dropping or adding fields', () => {
    const parsed = parseCanonicalRecordV2(baseRecord)
    expect(parsed).toEqual(baseRecord)
    expect(JSON.parse(canonicalJsonV2(parsed))).toEqual(baseRecord)
  })

  test('the invalid fixture and implemented mutation matrix stay synchronized', () => {
    expect(Object.keys(mutations).sort()).toEqual([...invalidFixture.mutations].sort())
  })

  test.each(invalidFixture.mutations)('rejects cross-field mutation: %s', (name) => {
    const record = structuredClone(baseRecord)
    mutations[name]!(record)
    expect(() => parseCanonicalRecordV2(record)).toThrow()
  })

  test('the response-before-call mutation reaches the intended trajectory invariant', () => {
    const record = structuredClone(baseRecord)
    mutations['response-before-call']!(record)
    const result = PostTrainingRecordV2Schema.safeParse(record)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'Response must reference an earlier call',
      )
    }
  })

  test('normalizes only the documented canonical boundary fields without mutating input', () => {
    const draft = structuredClone(baseRecord)
    draft.tags = ['工具', 'demo', 'demo']
    draft.candidates[0]!.signals[0]!.created_at = '2026-07-23T16:00:00+08:00'
    draft.tools[0]!.description = ''
    const filePart = draft.contents[0]!.parts[1]
    if (filePart?.type !== 'file_data') {
      throw new Error('fixture file_data part is missing')
    }
    filePart.file_data.media_type = 'IMAGE/PNG; charset=binary'

    expect(() => parseCanonicalRecordV2(draft)).toThrow()
    const normalized = normalizeCanonicalRecordV2(draft)
    expect(normalized.tags).toEqual(['demo', '工具'])
    expect(normalized.candidates[0]!.signals[0]!.created_at).toBe('2026-07-23T08:00:00Z')
    expect(normalized.tools[0]!.description).toBeNull()
    const normalizedFile = normalized.contents[0]!.parts[1]
    expect(normalizedFile?.type === 'file_data' && normalizedFile.file_data.media_type).toBe(
      'image/png',
    )
    expect(draft.tags).toEqual(['工具', 'demo', 'demo'])
  })

  test('normalizes timestamp offsets without losing sub-millisecond precision or repairing dates', () => {
    const precise = structuredClone(baseRecord)
    precise.candidates[0]!.signals[0]!.created_at = '2026-07-23T16:00:00.123456789+08:00'
    expect(normalizeCanonicalRecordV2(precise).candidates[0]!.signals[0]!.created_at).toBe(
      '2026-07-23T08:00:00.123456789Z',
    )

    const invalid = structuredClone(baseRecord)
    invalid.candidates[0]!.signals[0]!.created_at = '2026-02-30T08:00:00+08:00'
    expect(() => normalizeCanonicalRecordV2(invalid)).toThrow()
  })

  test.each([
    'i-klingon',
    'en-GB-oed',
    'sgn-BE-FR',
    'zh-min-nan',
    'x-private',
  ])('accepts valid grandfathered or private-use BCP-47 tag: %s', (tag) => {
    const record = structuredClone(baseRecord)
    record.lang = tag
    expect(() => parseCanonicalRecordV2(record)).not.toThrow()
  })

  test.each([
    'file:///Users/example/secret',
    'blob:https://example.com/temporary',
    'https://example.com/file?X-Goog-Signature=secret',
    'https://example.com/file?OSSAccessKeyId=secret',
  ])('rejects unstable or credential-bearing URI: %s', (uri) => {
    const record = structuredClone(baseRecord)
    const part = record.contents[0]!.parts[1]
    if (part?.type !== 'file_data') {
      throw new Error('fixture file_data part is missing')
    }
    part.file_data.uri = uri
    expect(() => parseCanonicalRecordV2(record)).toThrow()
  })

  test.each([
    [
      'part metadata',
      (record: PostTrainingRecordV2) => record.contents[0]!.parts[0]!.part_metadata,
    ],
    [
      'function response',
      (record: PostTrainingRecordV2) => {
        const part = responsePart(record)
        if (
          typeof part.function_response.response !== 'object' ||
          !part.function_response.response
        ) {
          throw new Error('fixture response object is missing')
        }
        return part.function_response.response
      },
    ],
    [
      'JSON signal',
      (record: PostTrainingRecordV2) => {
        const value = record.candidates[0]!.signals[4]!.value
        if (value.type !== 'json' || typeof value.value !== 'object' || !value.value) {
          throw new Error('fixture JSON signal is missing')
        }
        return value.value
      },
    ],
    [
      'verification ground truth',
      (record: PostTrainingRecordV2) =>
        record.verification!.ground_truth as Record<string, unknown>,
    ],
  ] as const)('rejects namespaced or camel-case credential in %s', (_name, selectPayload) => {
    const record = structuredClone(baseRecord)
    Reflect.set(selectPayload(record), 'provider.clientSecret', 'secret')
    expect(() => parseCanonicalRecordV2(record)).toThrow()
  })

  test.each([
    undefined,
    1n,
    new Date(),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    { nested: undefined },
  ])('rejects non-JSON JsonValue input %#', (value) => {
    expect(JsonValueV2Schema.safeParse(value).success).toBe(false)
  })
})

describe('v2 compatible reader and writer', () => {
  test('preserves unknown ordinary fields and future Part variants at value level', () => {
    const future = structuredClone(baseRecord) as PostTrainingRecordV2 & Record<string, unknown>
    Reflect.set(future, 'schema_version', '2.1.0')
    future.future_record_field = { enabled: true }
    const futurePart = {
      type: 'audio',
      audio_uri: 's3://datasets/audio/1.wav',
      thought: false,
      thought_signature: null,
      part_metadata: { 'future.codec': 'pcm' },
      future_flag: true,
    }
    Reflect.set(future.contents[0]!.parts, 0, futurePart)

    expect(() => parseCanonicalRecordV2(future)).toThrow()
    const compatible = readCompatibleRecordV2(future)
    const firstPart = compatible.contents[0]!.parts[0]
    expect(firstPart?.type).toBe('unknown')
    if (firstPart?.type !== 'unknown') {
      throw new Error('future Part was not wrapped')
    }
    expect(firstPart.original_type).toBe('audio')
    expect(firstPart.payload).toEqual({
      audio_uri: 's3://datasets/audio/1.wav',
      future_flag: true,
    })

    expect(JSON.parse(writeCompatibleRecordV2(compatible))).toEqual(future)
  })

  test('rejects an unknown schema major instead of pretending it is v2', () => {
    const futureMajor = structuredClone(baseRecord)
    Reflect.set(futureMajor, 'schema_version', '3.0.0')
    expect(() => readCompatibleRecordV2(futureMajor)).toThrow()
  })

  test('rejects malformed known Parts while preserving their future ordinary fields', () => {
    const malformed = structuredClone(baseRecord)
    Reflect.deleteProperty(malformed.contents[0]!.parts[0]!, 'text')
    expect(() => readCompatibleRecordV2(malformed)).toThrow()

    const futureKnown = structuredClone(baseRecord) as PostTrainingRecordV2 &
      Record<string, unknown>
    Reflect.set(futureKnown, 'schema_version', '2.1.0')
    Reflect.set(futureKnown.contents[0]!.parts[0]!, 'future_annotation', { kept: true })
    const compatible = readCompatibleRecordV2(futureKnown)
    expect(JSON.parse(writeCompatibleRecordV2(compatible))).toEqual(futureKnown)
  })
})
