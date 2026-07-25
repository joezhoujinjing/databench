import {
  createRecordRevisionV2,
  DEFAULT_RAW_JSON_LIMITS_V2,
  type PostTrainingRecordV2,
  PostTrainingRecordV2Schema,
  parseRawJsonV2,
  RawJsonErrorV2,
  type RawJsonLimitsV2,
  type RecordRevisionV2,
  ResourceLimitError,
} from '@databench/schema'
import {
  CanonicalJsonlBadInputErrorV2,
  CanonicalJsonlResourceLimitErrorV2,
  CanonicalJsonlUnsupportedRecordSchemaErrorV2,
  CanonicalJsonlValidationErrorV2,
} from './errors.js'

const NEWLINE = 0x0a
const textEncoder = new TextEncoder()

export const DEFAULT_CANONICAL_JSONL_MAX_TRANSPORT_BYTES_V2 = 1024 * 1024 * 1024

export interface ReadCanonicalJsonlV2Options {
  readonly limits?: RawJsonLimitsV2
  readonly maxTransportBytes?: number
  readonly signal?: AbortSignal
}

export interface WriteCanonicalJsonlV2Options {
  readonly signal?: AbortSignal
}

interface CanonicalJsonlOutputRowV2 {
  readonly record_digest: string
  readonly record_id: string
  readonly record_json: string
}

/**
 * Reads canonical v2 JSONL without buffering the complete transport. Each data
 * line is independently duplicate-checked and strict-schema validated before
 * it is yielded. Snapshot materialization and aggregate eager limits remain an
 * Engine/Workspace responsibility.
 */
export async function* readCanonicalJsonlV2(
  source: AsyncIterable<Uint8Array>,
  options: ReadCanonicalJsonlV2Options = {},
): AsyncIterableIterator<PostTrainingRecordV2> {
  for await (const { line, value } of readRawCanonicalJsonlV2(source, options)) {
    yield parseCanonicalJsonlValueV2(value, line)
  }
}

/** Package-internal bounded JSONL transport reader shared with canonical draft. */
export async function* readRawCanonicalJsonlV2(
  source: AsyncIterable<Uint8Array>,
  options: ReadCanonicalJsonlV2Options = {},
): AsyncIterableIterator<Readonly<{ line: number; value: unknown }>> {
  const limits = freezeAndValidateLimits(options.limits ?? DEFAULT_RAW_JSON_LIMITS_V2)
  const maxTransportBytes = validateMaxTransportBytes(
    options.maxTransportBytes ?? DEFAULT_CANONICAL_JSONL_MAX_TRANSPORT_BYTES_V2,
  )
  const signal = options.signal
  let transportBytes = 0
  let lineNumber = 1
  let lineBuffer: Uint8Array = new Uint8Array(0)
  let lineBytes = 0

  const finishLine = (): Readonly<{ line: number; value: unknown }> | null => {
    const bytes = lineBuffer.subarray(0, lineBytes)
    lineBytes = 0
    if (isBlankLine(bytes)) {
      return null
    }
    return Object.freeze({
      line: lineNumber,
      value: parseRawJsonlLineV2(bytes, lineNumber, limits),
    })
  }

  signal?.throwIfAborted()
  for await (const chunk of source) {
    signal?.throwIfAborted()
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('Canonical JSONL source must yield Uint8Array chunks')
    }
    transportBytes = addTransportBytes(transportBytes, chunk.byteLength, maxTransportBytes)

    let start = 0
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== NEWLINE) {
        continue
      }

      lineBuffer = appendSegment(
        chunk.subarray(start, index),
        lineBuffer,
        lineBytes,
        lineNumber,
        limits,
      )
      lineBytes += index - start
      const parsed = finishLine()
      if (parsed !== null) {
        yield parsed
        signal?.throwIfAborted()
      }
      lineNumber += 1
      start = index + 1
    }

    const remainder = chunk.subarray(start)
    lineBuffer = appendSegment(remainder, lineBuffer, lineBytes, lineNumber, limits)
    lineBytes += remainder.byteLength
  }

  signal?.throwIfAborted()
  if (lineBytes > 0) {
    const parsed = finishLine()
    if (parsed !== null) {
      yield parsed
      signal?.throwIfAborted()
    }
  }
}

/**
 * Emits deterministic canonical JSONL from opaque revisions. Input order is
 * ignored; output is ordered by (record_digest, record_id).
 */
export async function* writeCanonicalJsonlV2(
  revisions: Iterable<RecordRevisionV2> | AsyncIterable<RecordRevisionV2>,
  options: WriteCanonicalJsonlV2Options = {},
): AsyncIterableIterator<Uint8Array> {
  const validated: CanonicalJsonlOutputRowV2[] = []
  const signal = options.signal
  signal?.throwIfAborted()
  for await (const revision of revisions) {
    signal?.throwIfAborted()
    validated.push(validateRevision(revision))
  }
  signal?.throwIfAborted()
  validated.sort(compareRevisionIdentityAscii)

  for (const revision of validated) {
    signal?.throwIfAborted()
    yield textEncoder.encode(`${revision.record_json}\n`)
    signal?.throwIfAborted()
  }
}

function parseRawJsonlLineV2(bytes: Uint8Array, line: number, limits: RawJsonLimitsV2): unknown {
  let parsed: unknown
  try {
    parsed = parseRawJsonV2(bytes, limits)
  } catch (error) {
    if (error instanceof RawJsonErrorV2) {
      if (error.reason === 'byte_limit_exceeded') {
        throw new CanonicalJsonlResourceLimitErrorV2(
          {
            line,
            path: '',
            code: error.reason,
            message: error.message,
          },
          'record_bytes',
          limits.maxBytes,
          bytes.byteLength,
        )
      }
      if (error.reason === 'depth_limit_exceeded') {
        throw new CanonicalJsonlResourceLimitErrorV2(
          {
            line,
            path: '',
            code: error.reason,
            message: error.message,
          },
          'json_depth',
          limits.maxDepth,
          nextActual(limits.maxDepth, 1),
        )
      }
      throw new CanonicalJsonlBadInputErrorV2({
        line,
        path: '',
        code: error.reason,
        message: error.message,
      })
    }
    throw error
  }

  return parsed
}

function parseCanonicalJsonlValueV2(parsed: unknown, line: number): PostTrainingRecordV2 {
  const schemaVersion = readSchemaVersion(parsed)
  if (schemaVersion !== null && isSemver(schemaVersion) && schemaVersion !== '2.0.0') {
    throw new CanonicalJsonlUnsupportedRecordSchemaErrorV2(line, schemaVersion)
  }

  const result = PostTrainingRecordV2Schema.safeParse(parsed)
  if (!result.success) {
    throw new CanonicalJsonlValidationErrorV2(
      line,
      result.error.issues.map((issue) => ({
        path: zodPathToJsonPointer(issue.path),
        code: issue.code,
        message: issue.message,
      })),
    )
  }
  return result.data
}

function appendSegment(
  segment: Uint8Array,
  buffer: Uint8Array,
  currentBytes: number,
  line: number,
  limits: RawJsonLimitsV2,
): Uint8Array {
  if (segment.byteLength > limits.maxBytes - currentBytes) {
    throw new CanonicalJsonlResourceLimitErrorV2(
      {
        line,
        path: '',
        code: 'byte_limit_exceeded',
        message: `Raw JSON exceeds the ${limits.maxBytes} byte limit`,
      },
      'record_bytes',
      limits.maxBytes,
      nextActual(currentBytes, segment.byteLength),
    )
  }
  if (segment.byteLength === 0) {
    return buffer
  }

  const requiredBytes = currentBytes + segment.byteLength
  let owned = buffer
  if (owned.byteLength < requiredBytes) {
    let capacity = Math.min(limits.maxBytes, Math.max(requiredBytes, 4096))
    if (owned.byteLength > 0) {
      capacity = Math.min(limits.maxBytes, Math.max(requiredBytes, owned.byteLength * 2))
    }
    owned = new Uint8Array(capacity)
    owned.set(buffer.subarray(0, currentBytes))
  }
  owned.set(segment, currentBytes)
  return owned
}

function isBlankLine(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0x09 && byte !== 0x0d && byte !== 0x20) {
      return false
    }
  }
  return true
}

function readSchemaVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const schemaVersion = (value as Record<string, unknown>).schema_version
  return typeof schemaVersion === 'string' ? schemaVersion : null
}

function isSemver(version: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version,
  )
}

export function zodPathToJsonPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return ''
  }
  return `/${path.map((part) => escapeJsonPointerToken(String(part))).join('/')}`
}

function escapeJsonPointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

function freezeAndValidateLimits(limits: RawJsonLimitsV2): Readonly<RawJsonLimitsV2> {
  if (limits === null || typeof limits !== 'object') {
    throw new TypeError('Canonical JSONL limits must be an object')
  }
  const maxBytes = limits.maxBytes
  const maxDepth = limits.maxDepth
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('Canonical JSONL maxBytes must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError('Canonical JSONL maxDepth must be a non-negative safe integer')
  }
  return Object.freeze({ maxBytes, maxDepth })
}

function validateMaxTransportBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Canonical JSONL maxTransportBytes must be a non-negative safe integer')
  }
  return value
}

function addTransportBytes(current: number, increment: number, limit: number): number {
  if (increment > limit - current) {
    throw new ResourceLimitError('Canonical JSONL transport exceeds the request byte limit', {
      resource: 'request_bytes',
      limit,
      actual: nextActual(current, increment),
    })
  }
  return current + increment
}

function nextActual(current: number, increment: number): number | string {
  return current <= Number.MAX_SAFE_INTEGER - increment
    ? current + increment
    : (BigInt(current) + BigInt(increment)).toString()
}

function validateRevision(revision: RecordRevisionV2): CanonicalJsonlOutputRowV2 {
  if (typeof revision !== 'object' || revision === null || !('record' in revision)) {
    throw new TypeError('Canonical JSONL writer requires RecordRevisionV2 values')
  }
  const recalculated = createRecordRevisionV2(revision.record)
  if (
    recalculated.record_json !== revision.record_json ||
    recalculated.record_digest !== revision.record_digest
  ) {
    throw new TypeError('Canonical JSONL writer received an inconsistent record revision')
  }
  return Object.freeze({
    record_digest: revision.record_digest,
    record_id: revision.record.id,
    record_json: revision.record_json,
  })
}

function compareRevisionIdentityAscii(
  left: CanonicalJsonlOutputRowV2,
  right: CanonicalJsonlOutputRowV2,
): number {
  if (left.record_digest < right.record_digest) {
    return -1
  }
  if (left.record_digest > right.record_digest) {
    return 1
  }
  if (left.record_id < right.record_id) {
    return -1
  }
  if (left.record_id > right.record_id) {
    return 1
  }
  return 0
}
