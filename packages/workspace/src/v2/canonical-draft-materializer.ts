import type { FileHandle } from 'node:fs/promises'
import { V2Dataset, type V2DatasetLimits } from '@databench/engine'
import { createArtifactHasher } from '@databench/hashing'
import { readCanonicalDraftJsonlV1, writeCanonicalJsonlV2 } from '@databench/io'
import { ResourceLimitError, ValidationError } from '@databench/schema'
import type { V2TempFile, V2TempReservation, V2TempStore } from '@databench/store'
import {
  V2CanonicalDraftIdentityAllocator,
  type V2CanonicalDraftRecordIdentityPlan,
} from './canonical-draft-identity.js'
import type { V2IdentityAllocatorCatalog } from './identity-allocator.js'

const TEMP_READ_CHUNK_BYTES = 64 * 1024

export interface V2CanonicalDraftMaterializeOptions {
  readonly expectedInputDigest?: string
}

export interface V2CanonicalDraftMaterialization {
  readonly inputDigest: string
  readonly recordCount: number
  readonly datasetVersion: string
  readonly contentLength: number
  /** Fully consume bytes or call dispose() to release the sealed output spool. */
  readonly bytes: AsyncIterable<Uint8Array>
  dispose(): Promise<void>
}

export interface MaterializeCanonicalDraftJsonlV1Input {
  readonly source: AsyncIterable<Uint8Array>
  readonly options: V2CanonicalDraftMaterializeOptions
  readonly tempStore: V2TempStore
  readonly catalog: V2IdentityAllocatorCatalog
  readonly getNamespace: () => Promise<string>
  readonly datasetLimits: Readonly<V2DatasetLimits>
  readonly jsonlLimits: Readonly<{ max_request_bytes: number; max_nesting_depth: number }>
  readonly signal: AbortSignal
}

export async function materializeCanonicalDraftJsonlV1(
  input: MaterializeCanonicalDraftJsonlV1Input,
): Promise<Readonly<V2CanonicalDraftMaterialization>> {
  input.signal.throwIfAborted()
  const expectedInputDigest = parseExpectedDigest(input.options.expectedInputDigest)
  let rawReservation: V2TempReservation | undefined
  let rawFile: V2TempFile | undefined
  let outputReservation: V2TempReservation | undefined
  let outputFile: V2TempFile | undefined
  try {
    rawReservation = await input.tempStore.reserve(
      input.jsonlLimits.max_request_bytes,
      input.signal,
    )
    rawFile = await input.tempStore.create('draft-raw', input.signal)
    const raw = await writeRawSpool(
      input.source,
      rawFile.handle,
      input.jsonlLimits.max_request_bytes,
      input.signal,
    )
    await rawFile.handle.sync()
    input.signal.throwIfAborted()
    await rawReservation.resize(raw.byteLength, input.signal)

    if (expectedInputDigest !== undefined && expectedInputDigest !== raw.digest) {
      throw inputDigestMismatch(expectedInputDigest, raw.digest)
    }

    const namespaceId = await input.getNamespace()
    input.signal.throwIfAborted()
    const allocator = new V2CanonicalDraftIdentityAllocator(namespaceId, raw.digest)
    const plans: V2CanonicalDraftRecordIdentityPlan[] = []
    let dataRowIndex = 0
    const records = (async function* () {
      const drafts = readCanonicalDraftJsonlV1(
        readTempFile(rawFile.handle, raw.byteLength, input.signal),
        {
          limits: {
            maxBytes: input.datasetLimits.max_record_bytes,
            maxDepth: input.jsonlLimits.max_nesting_depth,
          },
          maxTransportBytes: input.jsonlLimits.max_request_bytes,
          signal: input.signal,
        },
      )
      for await (const draft of drafts) {
        input.signal.throwIfAborted()
        const plan = allocator.planRecord(draft, dataRowIndex)
        plans.push(plan)
        dataRowIndex += 1
        yield plan.record
      }
    })()
    const dataset = await V2Dataset.fromAsyncRecords(records, input.datasetLimits, {
      signal: input.signal,
    })

    const outputReservationBytes = checkedAdd(
      input.datasetLimits.max_canonical_bytes,
      input.datasetLimits.max_records,
      'canonical draft output reservation',
    )
    outputReservation = await input.tempStore.reserve(outputReservationBytes, input.signal)
    outputFile = await input.tempStore.create('draft-output', input.signal)
    const maxPhysicalBytes = checkedAdd(
      input.datasetLimits.max_canonical_bytes,
      dataset.length,
      'canonical draft output bytes',
    )
    const outputBytes = await writeOutputSpool(
      writeCanonicalJsonlV2(dataset.records(), { signal: input.signal }),
      outputFile.handle,
      maxPhysicalBytes,
      input.signal,
    )
    await outputFile.handle.sync()
    input.signal.throwIfAborted()

    await allocator.claimPlans(plans, input.catalog, input.signal)
    input.signal.throwIfAborted()

    await input.tempStore.remove(rawFile)
    rawFile = undefined
    rawReservation.release()
    rawReservation = undefined

    const output = singleUseTempFileStream(
      input.tempStore,
      outputFile,
      outputReservation,
      outputBytes,
      input.signal,
    )
    outputFile = undefined
    outputReservation = undefined
    return Object.freeze({
      inputDigest: raw.digest,
      recordCount: dataset.length,
      datasetVersion: dataset.version,
      contentLength: outputBytes,
      bytes: output.bytes,
      dispose: output.dispose,
    })
  } catch (error) {
    await cleanupTemp(input.tempStore, outputFile, outputReservation, error)
    await cleanupTemp(input.tempStore, rawFile, rawReservation, error)
    throw error
  }
}

async function writeRawSpool(
  source: AsyncIterable<Uint8Array>,
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Readonly<{ digest: string; byteLength: number }>> {
  const hasher = createArtifactHasher()
  let offset = 0
  signal.throwIfAborted()
  for await (const chunk of source) {
    signal.throwIfAborted()
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('Canonical draft source must yield Uint8Array chunks')
    }
    const next = checkedAdd(offset, chunk.byteLength, 'canonical draft request bytes')
    if (next > maxBytes) {
      throw new ResourceLimitError('Canonical draft upload exceeds the request byte limit', {
        resource: 'request_bytes',
        limit: maxBytes,
        actual: next,
      })
    }
    hasher.update(chunk)
    await writeAll(handle, chunk, offset, signal)
    offset = next
  }
  signal.throwIfAborted()
  return Object.freeze({ digest: hasher.digestHex(), byteLength: offset })
}

async function writeOutputSpool(
  source: AsyncIterable<Uint8Array>,
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal,
): Promise<number> {
  let offset = 0
  for await (const chunk of source) {
    signal.throwIfAborted()
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('Canonical draft materializer yielded a non-byte chunk')
    }
    const next = checkedAdd(offset, chunk.byteLength, 'canonical draft output bytes')
    if (next > maxBytes) {
      throw new ResourceLimitError('Canonical draft output exceeds the physical byte limit', {
        resource: 'canonical_output_bytes',
        limit: maxBytes,
        actual: next,
      })
    }
    await writeAll(handle, chunk, offset, signal)
    offset = next
  }
  return offset
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  start: number,
  signal: AbortSignal,
): Promise<void> {
  let written = 0
  while (written < bytes.byteLength) {
    signal.throwIfAborted()
    const result = await handle.write(bytes, written, bytes.byteLength - written, start + written)
    if (result.bytesWritten <= 0) throw new Error('V2 temporary file write made no progress')
    written += result.bytesWritten
  }
}

async function* readTempFile(
  handle: FileHandle,
  byteLength: number,
  signal: AbortSignal,
): AsyncIterableIterator<Uint8Array> {
  let offset = 0
  while (offset < byteLength) {
    signal.throwIfAborted()
    const requested = Math.min(TEMP_READ_CHUNK_BYTES, byteLength - offset)
    const buffer = new Uint8Array(requested)
    const { bytesRead } = await handle.read(buffer, 0, requested, offset)
    if (bytesRead <= 0) throw new Error('V2 temporary file ended before its sealed length')
    offset += bytesRead
    yield bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead)
  }
  signal.throwIfAborted()
}

function singleUseTempFileStream(
  tempStore: V2TempStore,
  file: V2TempFile,
  reservation: V2TempReservation,
  byteLength: number,
  signal: AbortSignal,
): Readonly<{ bytes: AsyncIterable<Uint8Array>; dispose(): Promise<void> }> {
  let consumed = false
  let cleanupPromise: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      try {
        await tempStore.remove(file)
      } finally {
        reservation.release()
      }
    })()
    return cleanupPromise
  }
  const cleanupAfterAbort = (): void => {
    void cleanup().catch(() => undefined)
  }
  signal.addEventListener('abort', cleanupAfterAbort, { once: true })
  if (signal.aborted) cleanupAfterAbort()

  const bytes = Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      if (consumed) throw new TypeError('Canonical draft output stream can only be consumed once')
      if (cleanupPromise !== undefined) {
        throw new TypeError('Canonical draft output stream has already been disposed')
      }
      consumed = true
      return (async function* () {
        let primary: unknown
        let cleanupFailure: unknown
        try {
          yield* readTempFile(file.handle, byteLength, signal)
        } catch (error) {
          primary = error
          throw error
        } finally {
          signal.removeEventListener('abort', cleanupAfterAbort)
          try {
            await cleanup()
          } catch (cleanupError) {
            if (primary === undefined) cleanupFailure = cleanupError
            else attachSuppressed(primary, cleanupError)
          }
        }
        if (cleanupFailure !== undefined) throw cleanupFailure
      })()
    },
  })
  return Object.freeze({
    bytes,
    dispose: async () => {
      signal.removeEventListener('abort', cleanupAfterAbort)
      await cleanup()
    },
  })
}

async function cleanupTemp(
  tempStore: V2TempStore,
  file: V2TempFile | undefined,
  reservation: V2TempReservation | undefined,
  primary: unknown,
): Promise<void> {
  try {
    if (file !== undefined) await tempStore.remove(file)
  } catch (cleanupError) {
    attachSuppressed(primary, cleanupError)
  } finally {
    reservation?.release()
  }
}

function parseExpectedDigest(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('Expected canonical draft input digest must be lowercase 64-hex')
  }
  return value
}

function inputDigestMismatch(expected: string, actual: string): ValidationError {
  const message = 'Canonical draft input digest does not match the expected preview digest'
  return new ValidationError(message, {
    issues: [{ path: '', line: null, code: 'input_digest_mismatch', message, expected, actual }],
  })
}

function checkedAdd(left: number, right: number, resource: string): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    throw new TypeError(`${resource} operands must be non-negative safe integers`)
  }
  if (right > Number.MAX_SAFE_INTEGER - left) {
    throw new ResourceLimitError(`${resource} exceeds the safe integer range`, {
      resource,
      limit: Number.MAX_SAFE_INTEGER,
      actual: (BigInt(left) + BigInt(right)).toString(),
    })
  }
  return left + right
}

function attachSuppressed(primary: unknown, suppressed: unknown): void {
  if (Object.is(primary, suppressed)) return
  if ((typeof primary !== 'object' && typeof primary !== 'function') || primary === null) return
  const existing = (primary as { suppressed?: unknown[] }).suppressed
  if (Array.isArray(existing)) existing.push(suppressed)
  else Object.defineProperty(primary, 'suppressed', { value: [suppressed], configurable: true })
}
