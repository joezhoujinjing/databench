import { readFile } from 'node:fs/promises'
import {
  createRecordRevisionV2,
  type PostTrainingRecordV2,
  ResourceLimitError,
} from '@databench/schema'
import { describe, expect, test } from 'vitest'
import {
  type CanonicalJsonlBadInputErrorV2,
  type CanonicalJsonlUnsupportedRecordSchemaErrorV2,
  type CanonicalJsonlValidationErrorV2,
  DEFAULT_CANONICAL_JSONL_MAX_TRANSPORT_BYTES_V2,
  readCanonicalJsonlV2,
  writeCanonicalJsonlV2,
} from '../src/index.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

describe('canonical v2 JSONL round-trip', () => {
  test('matches committed digest-sorted golden bytes', async () => {
    const input = new Uint8Array(
      await readFile(
        new URL('./golden/fixtures/v2/canonical-jsonl-round-trip.input.jsonl', import.meta.url),
      ),
    )
    const expected = new Uint8Array(
      await readFile(
        new URL('./golden/fixtures/v2/canonical-jsonl-round-trip.expected.jsonl', import.meta.url),
      ),
    )

    const imported = await collectRecords(readCanonicalJsonlV2(chunks(input, [0, 1, 7, 31])))
    const exported = await collectBytes(writeCanonicalJsonlV2(imported.map(createRecordRevisionV2)))
    expect(exported).toEqual(expected)

    const reimported = await collectRecords(readCanonicalJsonlV2(chunks(exported, [13, 1])))
    expect(
      reimported.map(createRecordRevisionV2).map((revision) => revision.record_digest),
    ).toEqual(
      imported
        .map(createRecordRevisionV2)
        .sort(compareRevisionIdentity)
        .map((revision) => revision.record_digest),
    )
  })

  test('round-trips detached canonical bytes with exact IDs and parent refs', async () => {
    const parentRevision = createRecordRevisionV2(makeRecord('6', 'Detached parent'))
    const child = {
      ...makeRecord('a', 'Detached child'),
      lineage: {
        parent_refs: [
          {
            id: parentRevision.record.id,
            record_digest: parentRevision.record_digest,
          },
        ],
        recipe: null,
        recipe_revision: null,
        run_id: null,
        steps: [],
      },
    } satisfies PostTrainingRecordV2
    const childRevision = createRecordRevisionV2(child)
    const exported = await collectBytes(writeCanonicalJsonlV2([childRevision]))

    const imported = await collectRecords(readCanonicalJsonlV2(chunks(exported, [1, 13])))
    expect(imported).toEqual([child])
    expect(imported[0]?.lineage?.parent_refs).toEqual(child.lineage.parent_refs)
    expect(imported.map(createRecordRevisionV2)).toEqual([childRevision])

    const reexported = await collectBytes(
      writeCanonicalJsonlV2(imported.map(createRecordRevisionV2)),
    )
    expect(reexported).toEqual(exported)
  })

  test('preserves imported IDs, record digests, and deterministic output bytes', async () => {
    const inputRecords = [
      makeRecord('2', '你好，世界🌍'),
      makeRecord('1', 'hello'),
      makeRecord('3', 'third'),
    ]
    const inputRevisions = inputRecords.map(createRecordRevisionV2)
    const input = encoder.encode(
      `  ${inputRevisions[0]?.record_json}\r\n\n${inputRevisions[1]?.record_json}\n${inputRevisions[2]?.record_json}`,
    )

    const imported = await collectRecords(readCanonicalJsonlV2(chunks(input, [7, 1, 19, 2, 5])))
    expect(imported.map((record) => record.id)).toEqual(inputRecords.map((record) => record.id))

    const importedRevisions = imported.map(createRecordRevisionV2)
    expect(importedRevisions.map((revision) => revision.record_digest)).toEqual(
      inputRevisions.map((revision) => revision.record_digest),
    )

    const bytes = await collectBytes(writeCanonicalJsonlV2(importedRevisions))
    const expected = [...inputRevisions]
      .sort(compareRevisionIdentity)
      .map((revision) => `${revision.record_json}\n`)
      .join('')
    expect(decoder.decode(bytes)).toBe(expected)

    const secondImport = await collectRecords(readCanonicalJsonlV2(chunks(bytes, [1])))
    expect(
      secondImport.map(createRecordRevisionV2).map((revision) => revision.record_digest),
    ).toEqual(
      [...inputRevisions].sort(compareRevisionIdentity).map((revision) => revision.record_digest),
    )
  })

  test('handles every byte boundary including split multi-byte UTF-8 code points', async () => {
    const record = makeRecord('a', '前缀🙂后缀🌍')
    const revision = createRecordRevisionV2(record)
    const bytes = encoder.encode(`${revision.record_json}\n`)
    const imported = await collectRecords(readCanonicalJsonlV2(chunks(bytes, [1])))

    expect(imported).toEqual([record])
    expect(createRecordRevisionV2(imported[0]).record_digest).toBe(revision.record_digest)
  })

  test('owns retained fragments when an async producer reuses its chunk buffer', async () => {
    const record = makeRecord('e', 'reused transport buffer')
    const bytes = encoder.encode(createRecordRevisionV2(record).record_json)
    const split = Math.ceil(bytes.byteLength / 2)
    const reusable = new Uint8Array(split)

    async function* source(): AsyncIterableIterator<Uint8Array> {
      reusable.set(bytes.subarray(0, split))
      yield reusable.subarray(0, split)
      reusable.fill(0)
      reusable.set(bytes.subarray(split))
      yield reusable.subarray(0, bytes.byteLength - split)
    }

    await expect(collectRecords(readCanonicalJsonlV2(source()))).resolves.toEqual([record])
  })

  test('accepts zero-length chunks, blank CRLF lines, no trailing LF, and final whitespace', async () => {
    const first = createRecordRevisionV2(makeRecord('4', 'first')).record_json
    const second = createRecordRevisionV2(makeRecord('5', 'second')).record_json
    const source = chunks(encoder.encode(`\r\n\n${first}\r\n\t \r\n${second}\n\t  `), [0, 1, 2])

    const imported = await collectRecords(readCanonicalJsonlV2(source))
    expect(imported.map((record) => record.id)).toEqual([
      `rec_${'4'.repeat(64)}`,
      `rec_${'5'.repeat(64)}`,
    ])
  })

  test('validates revisions before writing and ignores input order', async () => {
    const left = createRecordRevisionV2(makeRecord('b', 'left'))
    const right = createRecordRevisionV2(makeRecord('c', 'right'))
    const output = decoder.decode(
      await collectBytes(writeCanonicalJsonlV2(asAsyncIterable([right, left]))),
    )

    expect(output).toBe(
      [left, right]
        .sort(compareRevisionIdentity)
        .map((revision) => `${revision.record_json}\n`)
        .join(''),
    )

    const forged = {
      record: left.record,
      record_json: right.record_json,
      record_digest: left.record_digest,
    }
    await expect(
      collectBytes(
        writeCanonicalJsonlV2([forged] as unknown as Parameters<typeof writeCanonicalJsonlV2>[0]),
      ),
    ).rejects.toThrow('inconsistent record revision')
  })

  test('writes an empty iterable as zero bytes', async () => {
    expect(await collectBytes(writeCanonicalJsonlV2([]))).toEqual(new Uint8Array())
  })
})

describe('canonical v2 JSONL typed errors', () => {
  test('rejects duplicate keys before schema validation with one-based line and root pointer', async () => {
    const json = createRecordRevisionV2(makeRecord('d', 'duplicate')).record_json
    const duplicate = `{"id":"rec_${'e'.repeat(64)}",${json.slice(1)}`

    await expect(
      collectRecords(readCanonicalJsonlV2(singleChunk(`\n${duplicate}\n`))),
    ).rejects.toMatchObject({
      name: 'CanonicalJsonlBadInputErrorV2',
      code: 'bad_request',
      issues: [
        {
          line: 2,
          path: '',
          code: 'duplicate_key',
        },
      ],
    })
  })

  test('rejects a UTF-8 BOM and malformed UTF-8 as typed bad input', async () => {
    const json = encoder.encode(createRecordRevisionV2(makeRecord('e', 'bom')).record_json)
    const withBom = concatBytes([new Uint8Array([0xef, 0xbb, 0xbf]), json])

    await expect(collectRecords(readCanonicalJsonlV2(chunks(withBom, [1])))).rejects.toEqual(
      expect.objectContaining<Partial<CanonicalJsonlBadInputErrorV2>>({
        name: 'CanonicalJsonlBadInputErrorV2',
        issues: [expect.objectContaining({ line: 1, path: '', code: 'bom_not_allowed' })],
      }),
    )
    await expect(
      collectRecords(readCanonicalJsonlV2(chunks(new Uint8Array([0x7b, 0xff, 0x7d]), [1]))),
    ).rejects.toMatchObject({
      issues: [{ line: 1, path: '', code: 'malformed_utf8' }],
    })
    await expect(
      collectRecords(
        readCanonicalJsonlV2(
          chunks(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xe2, 0x82]), [1]),
        ),
      ),
    ).rejects.toMatchObject({
      issues: [{ line: 1, path: '', code: 'malformed_utf8' }],
    })
  })

  test('reports invalid canonical IDs with an exact JSON Pointer', async () => {
    const json = createRecordRevisionV2(makeRecord('f', 'bad id')).record_json
    const invalid = json.replace(`rec_${'f'.repeat(64)}`, 'external-id')

    await expect(
      collectRecords(readCanonicalJsonlV2(singleChunk(`\n\n${invalid}\n`))),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CanonicalJsonlValidationErrorV2>>({
        name: 'CanonicalJsonlValidationErrorV2',
        issues: [expect.objectContaining({ line: 3, path: '/id', code: 'invalid_format' })],
      }),
    )
  })

  test('reports nested schema paths as escaped JSON Pointers', async () => {
    const revision = createRecordRevisionV2(makeRecord('7', 'nested pointer'))
    const invalid = revision.record_json.replace('"role":"user"', '"role":"admin"')

    await expect(collectRecords(readCanonicalJsonlV2(singleChunk(invalid)))).rejects.toMatchObject({
      issues: [expect.objectContaining({ line: 1, path: '/contents/0/role' })],
    })
  })

  test('classifies every valid non-exact record semver separately from strict validation', async () => {
    const json = createRecordRevisionV2(makeRecord('8', 'future')).record_json
    for (const version of ['2.0.1', '2.1.0', '2.0.0+build.1', '3.0.0']) {
      const unsupported = json.replace('"schema_version":"2.0.0"', `"schema_version":"${version}"`)

      await expect(
        collectRecords(readCanonicalJsonlV2(singleChunk(`\n${unsupported}\n`))),
      ).rejects.toEqual(
        expect.objectContaining<Partial<CanonicalJsonlUnsupportedRecordSchemaErrorV2>>({
          name: 'CanonicalJsonlUnsupportedRecordSchemaErrorV2',
          code: 'unsupported_profile',
          line: 2,
          path: '/schema_version',
          value: version,
        }),
      )
    }
  })

  test('keeps malformed or missing versions in strict validation', async () => {
    const json = createRecordRevisionV2(makeRecord('6', 'invalid version')).record_json
    const malformed = json.replace('"schema_version":"2.0.0"', '"schema_version":"2.x.0"')
    const missing = json.replace(',"schema_version":"2.0.0"', '')

    await expect(
      collectRecords(readCanonicalJsonlV2(singleChunk(malformed))),
    ).rejects.toMatchObject({
      name: 'CanonicalJsonlValidationErrorV2',
      code: 'validation_error',
      issues: [expect.objectContaining({ line: 1, path: '/schema_version' })],
    })
    await expect(collectRecords(readCanonicalJsonlV2(singleChunk(missing)))).rejects.toMatchObject({
      name: 'CanonicalJsonlValidationErrorV2',
      code: 'validation_error',
      issues: [expect.objectContaining({ line: 1, path: '/schema_version' })],
    })
  })

  test('reports a duplicate key before an unsupported schema version', async () => {
    const json = createRecordRevisionV2(makeRecord('0', 'priority'))
      .record_json.replace('"schema_version":"2.0.0"', '"schema_version":"3.0.0"')
      .replace('{', '{"schema_version":"3.0.0",')

    await expect(collectRecords(readCanonicalJsonlV2(singleChunk(json)))).rejects.toMatchObject({
      name: 'CanonicalJsonlBadInputErrorV2',
      code: 'bad_request',
      issues: [{ line: 1, path: '', code: 'duplicate_key' }],
    })
  })

  test('enforces the per-record transport byte gate before an unbounded line is buffered', async () => {
    const source = chunks(encoder.encode(' '.repeat(33)), [4])
    await expect(
      collectRecords(
        readCanonicalJsonlV2(source, {
          limits: { maxBytes: 32, maxDepth: 128 },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'CanonicalJsonlResourceLimitErrorV2',
      code: 'resource_limit',
      detail: {
        resource: 'record_bytes',
        limit: 32,
        actual: 33,
      },
      issues: [{ line: 1, path: '', code: 'byte_limit_exceeded' }],
    })
  })

  test('allows the exact per-line byte limit and rejects one byte over it', async () => {
    const line = encoder.encode(createRecordRevisionV2(makeRecord('a', 'boundary')).record_json)
    const limits = { maxBytes: line.byteLength, maxDepth: 128 }
    await expect(
      collectRecords(readCanonicalJsonlV2(chunks(line, [1]), { limits })),
    ).resolves.toHaveLength(1)

    const oneByteOver = concatBytes([line, encoder.encode(' ')])
    await expect(
      collectRecords(readCanonicalJsonlV2(chunks(oneByteOver, [line.byteLength, 1]), { limits })),
    ).rejects.toMatchObject({
      name: 'CanonicalJsonlResourceLimitErrorV2',
      code: 'resource_limit',
      detail: {
        resource: 'record_bytes',
        limit: line.byteLength,
        actual: line.byteLength + 1,
      },
      issues: [{ line: 1, path: '', code: 'byte_limit_exceeded' }],
    })
  })

  test('maps JSON nesting depth admission to a typed resource limit', async () => {
    await expect(
      collectRecords(
        readCanonicalJsonlV2(singleChunk('{"outer":{"inner":true}}'), {
          limits: { maxBytes: 1024, maxDepth: 1 },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'CanonicalJsonlResourceLimitErrorV2',
      code: 'resource_limit',
      detail: {
        resource: 'json_depth',
        limit: 1,
        actual: 2,
      },
      issues: [{ line: 1, path: '', code: 'depth_limit_exceeded' }],
    })
  })

  test('enforces the default and configurable total transport byte limit inclusively', async () => {
    expect(DEFAULT_CANONICAL_JSONL_MAX_TRANSPORT_BYTES_V2).toBe(1024 ** 3)
    const transport = encoder.encode(
      `${createRecordRevisionV2(makeRecord('b', 'transport')).record_json}\n`,
    )

    await expect(
      collectRecords(
        readCanonicalJsonlV2(chunks(transport, [0, 1]), {
          maxTransportBytes: transport.byteLength,
        }),
      ),
    ).resolves.toHaveLength(1)
    await expect(
      collectRecords(
        readCanonicalJsonlV2(chunks(transport, [transport.byteLength - 1, 1]), {
          maxTransportBytes: transport.byteLength - 1,
        }),
      ),
    ).rejects.toMatchObject({
      name: 'ResourceLimitError',
      code: 'resource_limit',
      detail: {
        resource: 'request_bytes',
        limit: transport.byteLength - 1,
        actual: transport.byteLength,
      },
    })
  })

  test('rejects invalid total transport limit options before pulling the source', async () => {
    let pulled = false
    async function* source(): AsyncIterableIterator<Uint8Array> {
      pulled = true
      yield new Uint8Array()
    }

    await expect(
      collectRecords(readCanonicalJsonlV2(source(), { maxTransportBytes: -1 })),
    ).rejects.toThrow('maxTransportBytes')
    expect(pulled).toBe(false)
  })

  test('snapshots each raw JSON limit exactly once before pulling the source', async () => {
    const reads = { bytes: 0, depth: 0 }
    const limits = {
      get maxBytes() {
        reads.bytes += 1
        return 0
      },
      get maxDepth() {
        reads.depth += 1
        return 0
      },
    }

    await expect(
      collectRecords(readCanonicalJsonlV2(chunks(new Uint8Array(), [1]), { limits })),
    ).resolves.toEqual([])
    expect(reads).toEqual({ bytes: 1, depth: 1 })
  })
})

describe('canonical v2 JSONL streaming and eager handoff', () => {
  test('yields from a large transport before pulling the remaining records', async () => {
    const line = encoder.encode(
      `${createRecordRevisionV2(makeRecord('9', 'stream')).record_json}\n`,
    )
    let pulls = 0
    let closed = false

    async function* largeTransport(): AsyncIterableIterator<Uint8Array> {
      try {
        while (pulls < 100_000) {
          pulls += 1
          yield line
        }
      } finally {
        closed = true
      }
    }

    const reader = readCanonicalJsonlV2(largeTransport())
    const first = await reader.next()
    expect(first.done).toBe(false)
    expect(first.value?.id).toBe(`rec_${'9'.repeat(64)}`)
    expect(pulls).toBe(1)
    await reader.return()
    expect(closed).toBe(true)
  })

  test('observes cancellation before yielding another line from the current chunk', async () => {
    const lines = ['7', '8'].map(
      (digit) => `${createRecordRevisionV2(makeRecord(digit, digit)).record_json}\n`,
    )
    const controller = new AbortController()
    const reader = readCanonicalJsonlV2(singleChunk(lines.join('')), {
      signal: controller.signal,
    })

    await expect(reader.next()).resolves.toMatchObject({ done: false })
    controller.abort()
    await expect(reader.next()).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('lets the eager snapshot consumer stop the transport at its aggregate limit', async () => {
    const lines = ['a', 'b', 'c', 'd'].map((digit) =>
      encoder.encode(`${createRecordRevisionV2(makeRecord(digit, digit)).record_json}\n`),
    )
    let pulls = 0
    let closed = false

    async function* transport(): AsyncIterableIterator<Uint8Array> {
      try {
        for (const line of lines) {
          pulls += 1
          yield line
        }
      } finally {
        closed = true
      }
    }

    await expect(materializeForEagerSnapshot(readCanonicalJsonlV2(transport()), 2)).rejects.toEqual(
      expect.objectContaining({
        name: 'ResourceLimitError',
        code: 'resource_limit',
        detail: { resource: 'records', limit: 2, actual: 3 },
      }),
    )
    expect(pulls).toBe(3)
    expect(closed).toBe(true)
  })

  test('closes the upstream iterator when parsing fails', async () => {
    let closed = false
    async function* transport(): AsyncIterableIterator<Uint8Array> {
      try {
        yield encoder.encode('{"duplicate":1,"duplicate":2}\n')
        yield encoder.encode('unreachable')
      } finally {
        closed = true
      }
    }

    await expect(collectRecords(readCanonicalJsonlV2(transport()))).rejects.toMatchObject({
      name: 'CanonicalJsonlBadInputErrorV2',
    })
    expect(closed).toBe(true)
  })

  test('closes an async writer input when revision validation fails', async () => {
    const valid = createRecordRevisionV2(makeRecord('c', 'valid'))
    let closed = false
    async function* revisions(): AsyncIterableIterator<typeof valid> {
      try {
        yield {
          ...valid,
          record_json: createRecordRevisionV2(makeRecord('d', 'other')).record_json,
        } as typeof valid
        yield valid
      } finally {
        closed = true
      }
    }

    await expect(collectBytes(writeCanonicalJsonlV2(revisions()))).rejects.toThrow(
      'inconsistent record revision',
    )
    expect(closed).toBe(true)
  })

  test('does not finish a writer cancelled while its input returns done', async () => {
    const controller = new AbortController()
    const revisions: AsyncIterable<ReturnType<typeof createRecordRevisionV2>> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            controller.abort()
            return { done: true, value: undefined }
          },
        }
      },
    }

    await expect(
      collectBytes(writeCanonicalJsonlV2(revisions, { signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

function makeRecord(idDigit: string, text: string): PostTrainingRecordV2 {
  return {
    schema_version: '2.0.0',
    id: `rec_${idDigit.repeat(64)}`,
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
        loss_weight: null,
      },
    ],
    candidates: [],
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

async function collectRecords(
  records: AsyncIterable<PostTrainingRecordV2>,
): Promise<PostTrainingRecordV2[]> {
  const result: PostTrainingRecordV2[] = []
  for await (const record of records) {
    result.push(record)
  }
  return result
}

async function collectBytes(bytes: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of bytes) {
    chunks.push(chunk)
  }
  return concatBytes(chunks)
}

async function* chunks(
  bytes: Uint8Array,
  pattern: readonly number[],
): AsyncIterableIterator<Uint8Array> {
  let offset = 0
  let patternIndex = 0
  let emptyChunks = 0
  while (offset < bytes.byteLength) {
    const requested = pattern[patternIndex % pattern.length] ?? bytes.byteLength
    patternIndex += 1
    if (requested === 0) {
      yield new Uint8Array()
      emptyChunks += 1
      if (emptyChunks > pattern.length) {
        throw new Error('Chunk pattern cannot consist entirely of zero-length chunks')
      }
      continue
    }
    emptyChunks = 0
    const end = Math.min(offset + requested, bytes.byteLength)
    yield bytes.subarray(offset, end)
    offset = end
  }
}

function singleChunk(value: string): AsyncIterable<Uint8Array> {
  return chunks(encoder.encode(value), [Number.MAX_SAFE_INTEGER])
}

async function* asAsyncIterable<T>(values: readonly T[]): AsyncIterableIterator<T> {
  for (const value of values) {
    yield value
  }
}

function concatBytes(chunksInput: readonly Uint8Array[]): Uint8Array {
  const length = chunksInput.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunksInput) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function materializeForEagerSnapshot(
  records: AsyncIterable<PostTrainingRecordV2>,
  maxRecords: number,
): Promise<readonly PostTrainingRecordV2[]> {
  const retained: PostTrainingRecordV2[] = []
  for await (const record of records) {
    if (retained.length >= maxRecords) {
      throw new ResourceLimitError('V2 dataset exceeds the records limit', {
        resource: 'records',
        limit: maxRecords,
        actual: retained.length + 1,
      })
    }
    retained.push(record)
  }
  return retained
}

function compareRevisionIdentity(
  left: ReturnType<typeof createRecordRevisionV2>,
  right: ReturnType<typeof createRecordRevisionV2>,
): number {
  if (left.record_digest !== right.record_digest) {
    return left.record_digest < right.record_digest ? -1 : 1
  }
  if (left.record.id === right.record.id) {
    return 0
  }
  return left.record.id < right.record.id ? -1 : 1
}
