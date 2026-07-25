import { createHash } from 'node:crypto'
import { V2Dataset } from '@databench/engine'
import type { PostTrainingRecordV2, RecordRevisionV2 } from '@databench/schema'
import { describe, expect, test } from 'vitest'
import {
  readWorkerRetainedJsonlV1,
  writeWorkerRecordTextJsonlV1,
} from '../src/v2/batch-transform.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('record-text-v1 Worker data plane', () => {
  test('projects shared and candidate text in exact part order without normalization', async () => {
    const dataset = V2Dataset.fromRecords([
      record('1', ['  prompt  ', 'second\npart'], [' answer ', 'tail']),
    ])
    const bytes = await collect(writeWorkerRecordTextJsonlV1(dataset.records()))
    const line = JSON.parse(decoder.decode(bytes).trimEnd())

    expect(line).toEqual({
      record_id: `rec_${'1'.repeat(64)}`,
      record_digest: [...dataset.records()][0]?.record_digest,
      text: '  prompt  \nsecond\npart\n answer \ntail',
    })
    expect(decoder.decode(bytes).endsWith('\n')).toBe(true)
  })

  test('accepts a strict retained subset and maps it to the opaque input revision', async () => {
    const dataset = V2Dataset.fromRecords([
      record('1', ['first'], ['answer']),
      record('2', ['second'], ['answer']),
    ])
    const inputs = [...dataset.records()]
    const selected = inputs[1]
    if (!selected) throw new Error('fixture input is missing')
    const bytes = encoder.encode(
      `${JSON.stringify({ record_id: selected.record.id, record_digest: selected.record_digest })}\n`,
    )

    await expect(read(bytes, inputs)).resolves.toEqual([selected])
    await expect(read(new Uint8Array(), inputs)).resolves.toEqual([])
  })

  test.each([
    [
      'duplicate key',
      (revision: RecordRevisionV2) =>
        `{"record_id":"${revision.record.id}","record_id":"${revision.record.id}","record_digest":"${revision.record_digest}"}\n`,
    ],
    [
      'unknown field',
      (revision: RecordRevisionV2) =>
        `${JSON.stringify({ record_id: revision.record.id, record_digest: revision.record_digest, text: 'x' })}\n`,
    ],
    [
      'unknown id',
      (revision: RecordRevisionV2) =>
        `${JSON.stringify({ record_id: `rec_${'f'.repeat(64)}`, record_digest: revision.record_digest })}\n`,
    ],
    [
      'wrong digest',
      (revision: RecordRevisionV2) =>
        `${JSON.stringify({ record_id: revision.record.id, record_digest: 'f'.repeat(64) })}\n`,
    ],
    [
      'duplicate identity',
      (revision: RecordRevisionV2) =>
        `${JSON.stringify({ record_id: revision.record.id, record_digest: revision.record_digest })}\n${JSON.stringify({ record_id: revision.record.id, record_digest: revision.record_digest })}\n`,
    ],
    [
      'blank line',
      (revision: RecordRevisionV2) =>
        `${JSON.stringify({ record_id: revision.record.id, record_digest: revision.record_digest })}\n\n`,
    ],
  ])('rejects %s output', async (_name, output) => {
    const dataset = V2Dataset.fromRecords([record('1', ['first'], ['answer'])])
    const revision = [...dataset.records()][0]
    if (!revision) throw new Error('fixture input is missing')
    await expect(read(encoder.encode(output(revision)), [revision])).rejects.toMatchObject({
      code: 'integrity_error',
    })
  })

  test('rejects malformed UTF-8, line overflow, and terminal size/digest/count mismatches', async () => {
    const dataset = V2Dataset.fromRecords([record('1', ['first'], ['answer'])])
    const revision = [...dataset.records()][0]
    if (!revision) throw new Error('fixture input is missing')
    const valid = encoder.encode(
      `${JSON.stringify({ record_id: revision.record.id, record_digest: revision.record_digest })}\n`,
    )
    const malformed = Uint8Array.from([...valid.subarray(0, 2), 0xff, ...valid.subarray(2)])

    await expect(read(malformed, [revision])).rejects.toMatchObject({ code: 'integrity_error' })
    await expect(
      readWorkerRetainedJsonlV1(chunks(valid), [revision], {
        terminal: terminal(valid, 1),
        maxLineBytes: valid.byteLength - 2,
      }),
    ).rejects.toMatchObject({ code: 'resource_limit' })
    await expect(
      readWorkerRetainedJsonlV1(chunks(valid), [revision], {
        terminal: { ...terminal(valid, 1), size: valid.byteLength + 1 },
      }),
    ).rejects.toThrow('size')
    await expect(
      readWorkerRetainedJsonlV1(chunks(valid), [revision], {
        terminal: { ...terminal(valid, 1), digest: 'f'.repeat(64) },
      }),
    ).rejects.toThrow('digest')
    await expect(
      readWorkerRetainedJsonlV1(chunks(valid), [revision], {
        terminal: { ...terminal(valid, 1), recordCount: 0 },
      }),
    ).rejects.toThrow('count')
  })
})

async function read(bytes: Uint8Array, inputs: readonly RecordRevisionV2[]) {
  return await readWorkerRetainedJsonlV1(chunks(bytes), inputs, {
    terminal: terminal(
      bytes,
      bytes.byteLength === 0 ? 0 : bytes.filter((byte) => byte === 0x0a).length,
    ),
  })
}

function terminal(bytes: Uint8Array, recordCount: number) {
  return {
    size: bytes.byteLength,
    digest: createHash('sha256').update(bytes).digest('hex'),
    recordCount,
  }
}

async function* chunks(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  const split = Math.floor(bytes.byteLength / 2)
  if (split > 0) yield bytes.subarray(0, split).slice()
  if (split < bytes.byteLength) yield bytes.subarray(split).slice()
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks = []
  let size = 0
  for await (const chunk of source) {
    chunks.push(chunk)
    size += chunk.byteLength
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function record(
  suffix: string,
  sharedTexts: readonly string[],
  candidateTexts: readonly string[],
): PostTrainingRecordV2 {
  return {
    schema_version: '2.0.0',
    id: `rec_${suffix.repeat(64)}`,
    contents: [content('user', sharedTexts)],
    candidates: [
      {
        id: `cand_${suffix.repeat(64)}`,
        contents: [content('ai', candidateTexts, true)],
        finish_reason: null,
        rank: null,
        selected: null,
        signals: [],
        generator: null,
        token_count: null,
        avg_logprobs: null,
      },
    ],
    preference_relations: [],
    tools: [],
    verification: null,
    source: null,
    lang: null,
    lineage: null,
    tags: [],
    extra: {},
  }
}

function content(role: 'user' | 'ai', texts: readonly string[], includeFile = false) {
  return {
    role,
    parts: [
      ...texts.map((text) => ({
        type: 'text' as const,
        text,
        thought: false,
        thought_signature: null,
        part_metadata: {},
      })),
      ...(includeFile
        ? [
            {
              type: 'file_data' as const,
              file_data: {
                uri: 'https://example.com/file.txt',
                media_type: 'text/plain',
                digest: { algorithm: 'blake3' as const, value: 'a'.repeat(64) },
                size_bytes: 1,
              },
              thought: false,
              thought_signature: null,
              part_metadata: {},
            },
          ]
        : []),
    ],
    loss_weight: null,
  }
}
