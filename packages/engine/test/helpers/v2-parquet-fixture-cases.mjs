export const V2_PARQUET_MATRIX_CASES = Object.freeze([
  Object.freeze({ id: 'empty', ordinal: 1, rows: 0 }),
  Object.freeze({ id: 'unicode-single', ordinal: 2, rows: 1 }),
  Object.freeze({ id: 'low-cardinality-payload', ordinal: 3, rows: 256 }),
  Object.freeze({ id: 'high-cardinality-payload', ordinal: 4, rows: 256 }),
  Object.freeze({ id: 'long-record-json', ordinal: 5, rows: 1 }),
  Object.freeze({ id: 'rows-65535', ordinal: 6, rows: 65_535 }),
  Object.freeze({ id: 'rows-65536', ordinal: 7, rows: 65_536 }),
  Object.freeze({ id: 'rows-65537', ordinal: 8, rows: 65_537 }),
])

export function matrixCase(caseId) {
  const descriptor = V2_PARQUET_MATRIX_CASES.find((candidate) => candidate.id === caseId)
  if (!descriptor) {
    throw new Error(`Unknown V2 Parquet matrix case: ${caseId}`)
  }
  return descriptor
}

export function* matrixRecords(caseId) {
  const descriptor = matrixCase(caseId)
  for (let index = 0; index < descriptor.rows; index += 1) {
    yield recordFor(descriptor, index)
  }
}

function recordFor(descriptor, index) {
  const record = baseRecord(descriptor, index)
  switch (descriptor.id) {
    case 'unicode-single':
      return {
        ...record,
        system_instruction: '请准确回答🙂',
        contents: [
          {
            role: 'user',
            parts: [
              {
                type: 'text',
                text: '你好，世界🌍 — café — Καλημέρα',
                thought: false,
                thought_signature: null,
                part_metadata: { locale: 'zh-Hans', emoji: '🙂' },
              },
            ],
            loss_weight: null,
          },
        ],
        lang: 'zh-Hans',
        extra: { case: descriptor.id, unicode: '雪🙂é𝄞' },
      }
    case 'low-cardinality-payload':
      return {
        ...record,
        extra: {
          bucket: `bucket-${index % 4}`,
          case: descriptor.id,
          repeated: 'the same payload vocabulary',
        },
      }
    case 'high-cardinality-payload':
      return {
        ...record,
        extra: {
          case: descriptor.id,
          token: `token-${index.toString(16).padStart(8, '0')}-${mix32(index)}`,
        },
      }
    case 'long-record-json':
      return {
        ...record,
        extra: {
          case: descriptor.id,
          prefix: '超长🙂',
          payload: 'x'.repeat(1_100_000),
        },
      }
    default:
      return {
        ...record,
        extra: {
          bucket: `boundary-${index % 16}`,
          case: descriptor.id,
        },
      }
  }
}

function baseRecord(descriptor, index) {
  return {
    schema_version: '2.0.0',
    id: recordId(descriptor.ordinal, index),
    system_instruction: null,
    contents: [],
    candidates: [],
    preference_relations: [],
    tools: [],
    verification: null,
    source: null,
    lang: null,
    lineage: null,
    tags: [descriptor.id],
    extra: {},
  }
}

function recordId(ordinal, index) {
  const prefix = ordinal.toString(16).padStart(2, '0')
  const suffix = index.toString(16).padStart(62, '0')
  return `rec_${prefix}${suffix}`
}

function mix32(index) {
  let value = (index + 0x9e3779b9) >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x21f0aaad) >>> 0
  value ^= value >>> 15
  value = Math.imul(value, 0x735a2d97) >>> 0
  value ^= value >>> 15
  return value.toString(16).padStart(8, '0')
}
