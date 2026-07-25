import { createHash } from 'node:crypto'
import {
  IntegrityError,
  isRecordRevisionV2,
  parseRawJsonV2,
  type RecordRevisionV2,
  ResourceLimitError,
} from '@databench/schema'

const NEWLINE = 0x0a
const RECORD_ID = /^rec_[0-9a-f]{64}$/
const DIGEST = /^[0-9a-f]{64}$/
const textEncoder = new TextEncoder()

export const DEFAULT_WORKER_RETAINED_MAX_BYTES_V1 = 1024 * 1024 * 1024
export const DEFAULT_WORKER_RETAINED_MAX_LINE_BYTES_V1 = 16 * 1024 * 1024 + 256

export interface WorkerRetainedTerminalV1 {
  readonly size: number
  readonly digest: string
  readonly recordCount: number
}

export interface ReadWorkerRetainedJsonlV1Options {
  readonly terminal: WorkerRetainedTerminalV1
  readonly maxBytes?: number
  readonly maxLineBytes?: number
  readonly signal?: AbortSignal
}

export interface WriteWorkerRecordTextJsonlV1Options {
  readonly signal?: AbortSignal
}

/**
 * Writes the fixed record-text-v1 projection in caller-provided record order.
 * V2Dataset.records() already supplies the required (digest, id) order.
 */
export async function* writeWorkerRecordTextJsonlV1(
  revisions: Iterable<RecordRevisionV2> | AsyncIterable<RecordRevisionV2>,
  options: WriteWorkerRecordTextJsonlV1Options = {},
): AsyncIterableIterator<Uint8Array> {
  let previous: RecordRevisionV2 | null = null
  options.signal?.throwIfAborted()
  for await (const revision of revisions) {
    options.signal?.throwIfAborted()
    assertRevision(revision)
    if (previous !== null && compareRevisionIdentity(previous, revision) >= 0) {
      throw new IntegrityError('Worker projection records are not in unique canonical order')
    }
    previous = revision
    const text = projectedText(revision)
    const line = `{"record_id":${JSON.stringify(revision.record.id)},"record_digest":${JSON.stringify(revision.record_digest)},"text":${JSON.stringify(text)}}\n`
    yield textEncoder.encode(line)
    options.signal?.throwIfAborted()
  }
}

/**
 * Strictly validates a Worker retained-identity JSONL stream and maps it back
 * to the exact opaque input revisions. It does not create canonical output.
 */
export async function readWorkerRetainedJsonlV1(
  source: AsyncIterable<Uint8Array>,
  inputRevisions: Iterable<RecordRevisionV2>,
  options: ReadWorkerRetainedJsonlV1Options,
): Promise<readonly RecordRevisionV2[]> {
  const maxBytes = positiveSafeInteger(
    'Worker retained maxBytes',
    options.maxBytes ?? DEFAULT_WORKER_RETAINED_MAX_BYTES_V1,
  )
  const maxLineBytes = positiveSafeInteger(
    'Worker retained maxLineBytes',
    options.maxLineBytes ?? DEFAULT_WORKER_RETAINED_MAX_LINE_BYTES_V1,
  )
  validateTerminal(options.terminal, maxBytes)
  const inputs = indexInputs(inputRevisions)
  if (options.terminal.recordCount > inputs.size) {
    throw new IntegrityError('Worker retained count exceeds the input record count', {
      input_count: inputs.size,
      output_count: options.terminal.recordCount,
    })
  }

  const hasher = createHash('sha256')
  const retained: RecordRevisionV2[] = []
  const seenIds = new Set<string>()
  const seenIdentities = new Set<string>()
  const line = new JsonlLineBuffer(maxLineBytes)
  let size = 0
  let lineNumber = 1

  const consumeLine = () => {
    if (line.length === 0) {
      throw invalidOutput('Worker retained JSONL contains a blank line', lineNumber)
    }
    const identity = parseRetainedLine(line.take(), lineNumber)
    if (seenIds.has(identity.recordId)) {
      throw invalidOutput('Worker retained JSONL contains a duplicate record ID', lineNumber, {
        record_id: identity.recordId,
      })
    }
    const expected = inputs.get(identity.recordId)
    if (!expected) {
      throw invalidOutput('Worker retained JSONL contains an unknown record ID', lineNumber, {
        record_id: identity.recordId,
      })
    }
    if (expected.record_digest !== identity.recordDigest) {
      throw invalidOutput(
        'Worker retained JSONL record digest does not match its input',
        lineNumber,
        {
          record_id: identity.recordId,
        },
      )
    }
    const identityKey = `${identity.recordId}\0${identity.recordDigest}`
    if (seenIdentities.has(identityKey)) {
      throw invalidOutput('Worker retained JSONL contains a duplicate record identity', lineNumber)
    }
    seenIds.add(identity.recordId)
    seenIdentities.add(identityKey)
    retained.push(expected)
    if (retained.length > inputs.size) {
      throw invalidOutput('Worker retained output exceeds the input record count', lineNumber)
    }
  }

  options.signal?.throwIfAborted()
  for await (const chunk of source) {
    options.signal?.throwIfAborted()
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('Worker retained source must yield Uint8Array chunks')
    }
    if (chunk.byteLength > maxBytes - size) {
      throw new ResourceLimitError('Worker retained JSONL exceeds its byte limit', {
        resource: 'worker_retained_bytes',
        limit: maxBytes,
        actual: size + chunk.byteLength,
      })
    }
    size += chunk.byteLength
    hasher.update(chunk)

    let start = 0
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== NEWLINE) continue
      line.append(chunk.subarray(start, index), lineNumber)
      consumeLine()
      lineNumber += 1
      start = index + 1
    }
    line.append(chunk.subarray(start), lineNumber)
  }
  options.signal?.throwIfAborted()
  if (line.length > 0) consumeLine()

  const digest = hasher.digest('hex')
  if (size !== options.terminal.size) {
    throw new IntegrityError('Worker retained JSONL size does not match the terminal event', {
      expected: options.terminal.size,
      actual: size,
    })
  }
  if (digest !== options.terminal.digest) {
    throw new IntegrityError('Worker retained JSONL digest does not match the terminal event', {
      expected: options.terminal.digest,
      actual: digest,
    })
  }
  if (retained.length !== options.terminal.recordCount) {
    throw new IntegrityError('Worker retained JSONL count does not match the terminal event', {
      expected: options.terminal.recordCount,
      actual: retained.length,
    })
  }
  return Object.freeze(retained)
}

function projectedText(revision: RecordRevisionV2): string {
  const texts: string[] = []
  const append = (contents: RecordRevisionV2['record']['contents']) => {
    for (const content of contents) {
      for (const part of content.parts) {
        if (part.type === 'text') texts.push(part.text)
      }
    }
  }
  append(revision.record.contents)
  for (const candidate of revision.record.candidates) append(candidate.contents)
  return texts.join('\n')
}

function indexInputs(revisions: Iterable<RecordRevisionV2>): ReadonlyMap<string, RecordRevisionV2> {
  const byId = new Map<string, RecordRevisionV2>()
  for (const revision of revisions) {
    assertRevision(revision)
    if (byId.has(revision.record.id)) {
      throw new IntegrityError('Worker retained input contains a duplicate record ID')
    }
    byId.set(revision.record.id, revision)
  }
  return byId
}

function parseRetainedLine(
  bytes: Uint8Array,
  line: number,
): { readonly recordId: string; readonly recordDigest: string } {
  let parsed: unknown
  try {
    parsed = parseRawJsonV2(bytes, { maxBytes: bytes.byteLength, maxDepth: 1 })
  } catch (error) {
    throw invalidOutput('Worker retained JSONL contains malformed JSON', line, undefined, error)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidOutput('Worker retained JSONL line must be an object', line)
  }
  const object = parsed as Record<string, unknown>
  const keys = Object.keys(object)
  if (
    keys.length !== 2 ||
    !Object.hasOwn(object, 'record_id') ||
    !Object.hasOwn(object, 'record_digest')
  ) {
    throw invalidOutput('Worker retained JSONL line has an invalid shape', line)
  }
  if (typeof object.record_id !== 'string' || !RECORD_ID.test(object.record_id)) {
    throw invalidOutput('Worker retained JSONL record_id is invalid', line)
  }
  if (typeof object.record_digest !== 'string' || !DIGEST.test(object.record_digest)) {
    throw invalidOutput('Worker retained JSONL record_digest is invalid', line)
  }
  return { recordId: object.record_id, recordDigest: object.record_digest }
}

function validateTerminal(terminal: WorkerRetainedTerminalV1, maxBytes: number): void {
  if (!Number.isSafeInteger(terminal.size) || terminal.size < 0 || terminal.size > maxBytes) {
    throw new ResourceLimitError('Worker terminal size is outside the retained byte limit', {
      resource: 'worker_retained_bytes',
      limit: maxBytes,
      actual: terminal.size,
    })
  }
  if (!DIGEST.test(terminal.digest)) {
    throw new TypeError('Worker terminal digest must be 64 lowercase hex characters')
  }
  if (!Number.isSafeInteger(terminal.recordCount) || terminal.recordCount < 0) {
    throw new TypeError('Worker terminal recordCount must be a non-negative safe integer')
  }
}

function assertRevision(value: unknown): asserts value is RecordRevisionV2 {
  if (!isRecordRevisionV2(value)) {
    throw new TypeError('Worker projection requires RecordRevisionV2 values')
  }
  if (!RECORD_ID.test(value.record.id) || !DIGEST.test(value.record_digest)) {
    throw new IntegrityError('Worker projection received an invalid record identity')
  }
}

function compareRevisionIdentity(left: RecordRevisionV2, right: RecordRevisionV2): number {
  if (left.record_digest !== right.record_digest)
    return left.record_digest < right.record_digest ? -1 : 1
  if (left.record.id === right.record.id) return 0
  return left.record.id < right.record.id ? -1 : 1
}

function invalidOutput(
  message: string,
  line: number,
  detail?: object,
  cause?: unknown,
): IntegrityError {
  const error = new IntegrityError(message, { line, ...detail })
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause })
  return error
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`)
  return value
}

class JsonlLineBuffer {
  #buffer = new Uint8Array(0)
  #length = 0

  constructor(readonly maxBytes: number) {}

  get length(): number {
    return this.#length
  }

  append(segment: Uint8Array, line: number): void {
    const required = this.#length + segment.byteLength
    if (segment.byteLength > this.maxBytes - this.#length) {
      throw new ResourceLimitError('Worker retained JSONL line exceeds its byte limit', {
        resource: 'worker_retained_line_bytes',
        limit: this.maxBytes,
        actual: required,
        line,
      })
    }
    if (segment.byteLength === 0) return
    if (required > this.#buffer.byteLength) {
      let capacity = Math.min(this.maxBytes, Math.max(256, this.#buffer.byteLength * 2))
      while (capacity < required) capacity = Math.min(this.maxBytes, capacity * 2)
      const next = new Uint8Array(capacity)
      next.set(this.#buffer.subarray(0, this.#length))
      this.#buffer = next
    }
    this.#buffer.set(segment, this.#length)
    this.#length = required
  }

  take(): Uint8Array {
    const result = this.#buffer.subarray(0, this.#length).slice()
    this.#buffer = new Uint8Array(0)
    this.#length = 0
    return result
  }
}
