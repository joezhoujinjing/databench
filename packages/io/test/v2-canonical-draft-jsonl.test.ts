import { describe, expect, test } from 'vitest'
import {
  type CanonicalJsonlBadInputErrorV2,
  type CanonicalJsonlValidationErrorV2,
  readCanonicalDraftJsonlV1,
} from '../src/index.js'

const encoder = new TextEncoder()

describe('canonical draft v1 JSONL reader', () => {
  test('streams LF, CRLF, and blank lines while materializing defaults', async () => {
    const first = draftLine('first')
    const second = draftLine('second')
    const source = chunks(encoder.encode(` \r\n${first}\r\n\n${second}`), [1, 3, 11])

    const records = await collect(readCanonicalDraftJsonlV1(source))

    expect(records).toHaveLength(2)
    expect(records.map((record) => record.contents[0]?.parts[0])).toMatchObject([
      { text: 'first' },
      { text: 'second' },
    ])
    expect(records[0]).toMatchObject({
      candidates: [],
      preference_relations: [],
      tools: [],
      verification: null,
      source: null,
      lang: null,
      lineage: null,
      tags: [],
      extra: {},
    })
  })

  test('reports physical lines and draft JSON pointers for strict validation', async () => {
    const invalid = draftLine('invalid').replace(
      '"draft_schema_version":"1.0.0"',
      '"draft_schema_version":"2.0.0"',
    )
    await expect(
      collect(readCanonicalDraftJsonlV1(singleChunk(`\n\n${invalid}\n`))),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CanonicalJsonlValidationErrorV2>>({
        name: 'CanonicalJsonlValidationErrorV2',
        issues: [
          expect.objectContaining({
            line: 3,
            path: '/draft_schema_version',
            code: 'invalid_value',
          }),
        ],
      }),
    )
  })

  test('shares duplicate-key, BOM, malformed UTF-8, and transport limits with canonical JSONL', async () => {
    const duplicate = draftLine('duplicate').replace('{', '{"draft_schema_version":"1.0.0",')
    await expect(collect(readCanonicalDraftJsonlV1(singleChunk(duplicate)))).rejects.toEqual(
      expect.objectContaining<Partial<CanonicalJsonlBadInputErrorV2>>({
        name: 'CanonicalJsonlBadInputErrorV2',
        issues: [expect.objectContaining({ code: 'duplicate_key', line: 1 })],
      }),
    )

    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(draftLine('bom'))])
    await expect(collect(readCanonicalDraftJsonlV1(chunks(bom, [1])))).rejects.toMatchObject({
      issues: [{ code: 'bom_not_allowed', line: 1 }],
    })
    await expect(
      collect(readCanonicalDraftJsonlV1(chunks(new Uint8Array([0x7b, 0xff, 0x7d]), [1]))),
    ).rejects.toMatchObject({ issues: [{ code: 'malformed_utf8', line: 1 }] })

    const bytes = encoder.encode(draftLine('bounded'))
    await expect(
      collect(
        readCanonicalDraftJsonlV1(singleChunk(bytes), { maxTransportBytes: bytes.length - 1 }),
      ),
    ).rejects.toMatchObject({
      code: 'resource_limit',
      detail: { resource: 'request_bytes', limit: bytes.length - 1, actual: bytes.length },
    })
  })

  test('stops before pulling when already aborted', async () => {
    let pulled = false
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    async function* source() {
      pulled = true
      yield encoder.encode(draftLine('unused'))
    }

    await expect(
      collect(readCanonicalDraftJsonlV1(source(), { signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(pulled).toBe(false)
  })
})

function draftLine(text: string): string {
  return JSON.stringify({
    draft_schema_version: '1.0.0',
    schema_version: '2.0.0',
    contents: [
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text,
            thought: false,
            thought_signature: null,
            part_metadata: {},
          },
        ],
        loss_weight: 0,
      },
    ],
  })
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

async function* singleChunk(input: string | Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield typeof input === 'string' ? encoder.encode(input) : input
}

async function* chunks(
  input: Uint8Array,
  sizes: readonly number[],
): AsyncIterableIterator<Uint8Array> {
  let offset = 0
  let index = 0
  while (offset < input.byteLength) {
    const size = sizes[index % sizes.length] ?? input.byteLength
    const end = Math.min(input.byteLength, offset + size)
    yield input.subarray(offset, end)
    offset = end
    index += 1
  }
}
