import { BadInputError, ResourceLimitError } from '@databench/schema'
import { describe, expect, test } from 'vitest'
import { type ParsedV2IngestMultipart, parseV2IngestMultipart } from '../src/v2/multipart.js'

const BOUNDARY = 'databench-v2-test-boundary'
const EXPECTED_VERSION = 'a'.repeat(64)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('v2 streaming multipart parser', () => {
  test('parses fields-first input whose boundaries and UTF-8 values cross byte chunks', async () => {
    const bytes = multipart([
      textPart('ref', 'training-main'),
      textPart('message', '第一次导入'),
      textPart('expected_ref_version', EXPECTED_VERSION),
      filePart('file', encoder.encode('第一行\n第二行\n')),
    ])
    const request = multipartRequest(splitEveryByte(bytes))
    forbidBufferedRequestApis(request)

    const parsed = parseV2IngestMultipart(request)
    const [file, options] = await Promise.all([collect(parsed.file), parsed.options])

    expect(decoder.decode(file)).toBe('第一行\n第二行\n')
    expect(options).toEqual({
      ref: 'training-main',
      expected_ref_version: EXPECTED_VERSION,
      message: '第一次导入',
    })
  })

  test('streams a file-first body while trailing options are parsed without deadlock', async () => {
    const payload = encoder.encode(`${'x'.repeat(96 * 1024)}\n`)
    const bytes = multipart([
      filePart('file', payload),
      textPart('message', 'file came first'),
      textPart('ref', 'main'),
    ])
    const parsed = parseV2IngestMultipart(multipartRequest(chunk(bytes, 257)))

    const [file, options] = await withTimeout(
      Promise.all([collect(parsed.file), parsed.options]),
      2_000,
    )

    expect(file).toEqual(payload)
    expect(options).toEqual({
      ref: 'main',
      expected_ref_version: null,
      message: 'file came first',
    })
  })

  test('allows an empty file and absent optional fields', async () => {
    const parsed = parseV2IngestMultipart(
      multipartRequest(chunk(multipart([filePart('file', new Uint8Array())]), 3)),
      { maxFileBytes: 0 },
    )

    await expect(Promise.all([collect(parsed.file), parsed.options])).resolves.toEqual([
      new Uint8Array(),
      {
        ref: null,
        expected_ref_version: null,
        message: null,
      },
    ])
  })

  test('enforces an inclusive total request byte limit while reading chunks', async () => {
    const bytes = multipart([filePart('file', encoder.encode('abc'))])
    const exact = parseV2IngestMultipart(multipartRequest(chunk(bytes, 2)), {
      maxRequestBytes: bytes.byteLength,
      maxFileBytes: 3,
    })

    await expect(Promise.all([collect(exact.file), exact.options])).resolves.toEqual([
      encoder.encode('abc'),
      {
        ref: null,
        expected_ref_version: null,
        message: null,
      },
    ])

    const over = parseV2IngestMultipart(multipartRequest(chunk(bytes, 2)), {
      maxRequestBytes: bytes.byteLength - 1,
      maxFileBytes: 3,
    })
    const failures = await settleBoth(over)
    expect(failures[1]).toBeInstanceOf(ResourceLimitError)
    expect((failures[1] as ResourceLimitError).detail).toEqual({
      resource: 'request_bytes',
      limit: bytes.byteLength - 1,
      actual: bytes.byteLength,
    })
  })

  test('enforces an inclusive file byte limit without yielding the sentinel byte', async () => {
    const bytes = multipart([filePart('file', encoder.encode('abc'))])
    const exact = parseV2IngestMultipart(multipartRequest(chunk(bytes, 1)), {
      maxFileBytes: 3,
    })
    await expect(Promise.all([collect(exact.file), exact.options])).resolves.toEqual([
      encoder.encode('abc'),
      {
        ref: null,
        expected_ref_version: null,
        message: null,
      },
    ])

    const over = parseV2IngestMultipart(multipartRequest(chunk(bytes, 1)), {
      maxFileBytes: 2,
    })
    const failures = await settleBoth(over)
    expect(failures[0]).toBeInstanceOf(ResourceLimitError)
    expect(failures[1]).toBeInstanceOf(ResourceLimitError)
    expect((failures[0] as ResourceLimitError).detail).toEqual({
      resource: 'file_bytes',
      field: 'file',
      limit: 2,
      actual: 3,
    })
  })

  test.each([
    {
      label: 'a duplicate text field',
      parts: [textPart('ref', 'main'), textPart('ref', 'other'), filePart('file', bytes('x'))],
      message: 'must not be repeated',
    },
    {
      label: 'an unknown text field',
      parts: [textPart('name', 'main'), filePart('file', bytes('x'))],
      message: 'unknown multipart text field',
    },
    {
      label: 'an additional named file',
      parts: [filePart('file', bytes('x')), filePart('attachment', bytes('y'))],
      message: 'unknown or additional multipart file field',
    },
    {
      label: 'a duplicate file field',
      parts: [filePart('file', bytes('x')), filePart('file', bytes('y'))],
      message: 'must appear exactly once',
    },
    {
      label: 'a text part named file',
      parts: [textPart('file', 'not a file')],
      message: 'unknown multipart text field',
    },
  ])('rejects $label and closes both result channels', async ({ parts, message }) => {
    const parsed = parseV2IngestMultipart(multipartRequest(chunk(multipart(parts), 11)))
    const failures = await settleBoth(parsed)

    expect(failures[1]).toBeInstanceOf(BadInputError)
    expect((failures[1] as Error).message).toContain(message)
  })

  test.each([
    ['ref', ''],
    ['ref', 'null'],
    ['expected_ref_version', ''],
    ['expected_ref_version', 'null'],
    ['message', ''],
    ['message', 'null'],
  ])('rejects %s=%j instead of interpreting it as absence', async (name, value) => {
    const parsed = parseV2IngestMultipart(
      multipartRequest(
        chunk(
          multipart([
            textPart(name, value),
            ...(name === 'ref' ? [] : [textPart('ref', 'main')]),
            filePart('file', bytes('x')),
          ]),
          7,
        ),
      ),
    )
    const failures = await settleBoth(parsed)

    expect(failures[0]).toBeInstanceOf(BadInputError)
    expect((failures[0] as Error).message).toContain('absent instead of empty or literal null')
  })

  test.each(['expected_ref_version', 'message'])('rejects %s when ref is absent', async (name) => {
    const value = name === 'expected_ref_version' ? EXPECTED_VERSION : 'orphan message'
    const parsed = parseV2IngestMultipart(
      multipartRequest(chunk(multipart([filePart('file', bytes('x')), textPart(name, value)]), 13)),
    )

    const failures = await settleBoth(parsed)
    expect(failures[1]).toBeDefined()
    expect((failures[1] as Error).message).toContain('requires ref')
  })

  test('rejects a text field whose bytes are truncated by its configured limit', async () => {
    const parsed = parseV2IngestMultipart(
      multipartRequest(
        chunk(multipart([textPart('ref', 'main'), filePart('file', bytes('x'))]), 5),
      ),
      { maxFieldBytes: 3 },
    )
    const failures = await settleBoth(parsed)

    expect(failures[0]).toBeInstanceOf(ResourceLimitError)
    expect(failures[1]).toBeInstanceOf(ResourceLimitError)
    expect((failures[1] as ResourceLimitError).detail).toEqual({
      resource: 'multipart_field_bytes',
      field: 'ref',
      limit: 3,
      actual: 4,
    })
  })

  test('rejects a missing file and a truncated multipart envelope', async () => {
    const missing = parseV2IngestMultipart(
      multipartRequest(chunk(multipart([textPart('ref', 'main')]), 19)),
    )
    const missingFailures = await settleBoth(missing)
    expect((missingFailures[0] as Error).message).toContain('required exactly once')

    const complete = multipart([filePart('file', bytes('canonical\n'))])
    const truncated = parseV2IngestMultipart(
      multipartRequest(chunk(complete.subarray(0, complete.byteLength - 8), 17)),
    )
    const truncatedFailures = await settleBoth(truncated)
    expect(truncatedFailures[0]).toBeInstanceOf(BadInputError)
    expect(truncatedFailures[1]).toBeInstanceOf(BadInputError)
    expect((truncatedFailures[0] as Error).message).toContain('truncated')
    expect((truncatedFailures[1] as Error).message).toContain('truncated')
  })

  test('propagates an AbortSignal reason and cancels the Web request stream', async () => {
    const controller = new AbortController()
    const prefix = openFilePart(bytes('x'.repeat(96 * 1024)))
    let cancelledWith: unknown
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(prefix)
      },
      cancel(reason) {
        cancelledWith = reason
      },
    })
    const reason = new DOMException('client disconnected', 'AbortError')
    const parsed = parseV2IngestMultipart(multipartRequestFromStream(body, controller.signal), {
      signal: controller.signal,
    })
    const iterator = parsed.file[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    controller.abort(reason)

    await expect(drain(iterator)).rejects.toBe(reason)
    await expect(parsed.options).rejects.toBe(reason)
    await eventually(() => expect(cancelledWith).toBe(reason))
  })

  test('early return from the file iterator cancels the parser and request body', async () => {
    const prefix = openFilePart(bytes('x'.repeat(96 * 1024)))
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix)
      },
      cancel(reason) {
        cancelReason = reason
      },
    })
    const parsed = parseV2IngestMultipart(multipartRequestFromStream(body))
    const iterator = parsed.file[Symbol.asyncIterator]()

    expect((await iterator.next()).done).toBe(false)
    await iterator.return?.()

    await expect(parsed.options).rejects.toMatchObject({ name: 'AbortError' })
    await eventually(() => expect(cancelReason).toMatchObject({ name: 'AbortError' }))
  })

  test('a validation error cancels an otherwise-open request body', async () => {
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(multipart([textPart('unknown', 'value')]))
      },
      cancel(reason) {
        cancelReason = reason
      },
    })
    const parsed = parseV2IngestMultipart(multipartRequestFromStream(body))

    const failures = await settleBoth(parsed)
    expect(failures[0]).toBeInstanceOf(BadInputError)
    expect(failures[1]).toBeInstanceOf(BadInputError)
    await eventually(() => expect(cancelReason).toBeInstanceOf(BadInputError))
  })

  test.each([
    'application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
  ])('rejects content type %s before consuming the body', (contentType) => {
    const request = new Request('http://localhost/v2/datasets:ingest-jsonl', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: bytes('{}'),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    expect(() => parseV2IngestMultipart(request)).toThrow(BadInputError)
  })

  test('validates configured limits synchronously', () => {
    const request = multipartRequest([multipart([filePart('file', bytes('x'))])])

    expect(() => parseV2IngestMultipart(request, { maxRequestBytes: -1 })).toThrow(TypeError)
    expect(() =>
      parseV2IngestMultipart(request, { maxFileBytes: Number.MAX_SAFE_INTEGER }),
    ).toThrow(TypeError)
  })
})

interface TestPart {
  readonly name: string
  readonly value: Uint8Array
  readonly filename?: string
  readonly contentType?: string
}

function textPart(name: string, value: string): TestPart {
  return { name, value: encoder.encode(value) }
}

function filePart(name: string, value: Uint8Array): TestPart {
  return {
    name,
    value,
    filename: 'records.jsonl',
    contentType: 'application/x-ndjson',
  }
}

function multipart(parts: readonly TestPart[]): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    chunks.push(encoder.encode(`--${BOUNDARY}\r\n`))
    const filename = part.filename === undefined ? '' : `; filename="${part.filename}"`
    chunks.push(
      encoder.encode(`Content-Disposition: form-data; name="${part.name}"${filename}\r\n`),
    )
    if (part.contentType !== undefined) {
      chunks.push(encoder.encode(`Content-Type: ${part.contentType}\r\n`))
    }
    chunks.push(encoder.encode('\r\n'))
    chunks.push(part.value)
    chunks.push(encoder.encode('\r\n'))
  }
  chunks.push(encoder.encode(`--${BOUNDARY}--\r\n`))
  return concat(chunks)
}

function openFilePart(value: Uint8Array): Uint8Array {
  return concat([
    encoder.encode(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="records.jsonl"\r\nContent-Type: application/x-ndjson\r\n\r\n`,
    ),
    value,
  ])
}

function multipartRequest(chunks: readonly Uint8Array[]): Request {
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const value = chunks[index]
      if (value === undefined) {
        controller.close()
        return
      }
      index += 1
      controller.enqueue(value)
    },
  })
  return multipartRequestFromStream(body)
}

function multipartRequestFromStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Request {
  return new Request('http://localhost/v2/datasets:ingest-jsonl', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body,
    duplex: 'half',
    ...(signal === undefined ? {} : { signal }),
  } as RequestInit & { duplex: 'half' })
}

function forbidBufferedRequestApis(request: Request): void {
  Object.defineProperties(request, {
    arrayBuffer: {
      value: () => {
        throw new Error('arrayBuffer() must not be used')
      },
    },
    formData: {
      value: () => {
        throw new Error('formData() must not be used')
      },
    },
  })
}

function splitEveryByte(value: Uint8Array): Uint8Array[] {
  return Array.from(value, (_, index) => value.subarray(index, index + 1))
}

function chunk(value: Uint8Array, size: number): Uint8Array[] {
  const result: Uint8Array[] = []
  for (let offset = 0; offset < value.byteLength; offset += size) {
    result.push(value.subarray(offset, Math.min(value.byteLength, offset + size)))
  }
  return result
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunkValue) => total + chunkValue.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunkValue of chunks) {
    result.set(chunkValue, offset)
    offset += chunkValue.byteLength
  }
  return result
}

function bytes(value: string): Uint8Array {
  return encoder.encode(value)
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const value of source) {
    chunks.push(value)
  }
  return concat(chunks)
}

async function settleBoth(parsed: ParsedV2IngestMultipart): Promise<readonly unknown[]> {
  const [file, options] = await Promise.allSettled([collect(parsed.file), parsed.options])
  return [
    file.status === 'rejected' ? file.reason : undefined,
    options.status === 'rejected' ? options.reason : undefined,
  ]
}

async function drain(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  while (!(await iterator.next()).done) {
    // Drain until the parser terminates or rejects.
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('operation timed out'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function eventually(assertion: () => void, attempts = 20): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  throw lastError
}
