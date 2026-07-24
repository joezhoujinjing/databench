import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { BadInputError } from '@databench/schema'
import type { CliOperation } from './runtime.js'

export async function* readCliInput(path: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
  signal.throwIfAborted()
  const source = path === '-' ? process.stdin : createReadStream(path)
  const abort = () => {
    source.destroy(abortReason(signal))
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const chunk of source) {
      signal.throwIfAborted()
      if (typeof chunk === 'string') {
        yield new TextEncoder().encode(chunk)
      } else {
        yield chunk
      }
    }
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', abort)
    if (path !== '-') source.destroy()
  }
}

export async function writeCliStdout(
  bytes: AsyncIterable<Uint8Array>,
  mediaType: string,
  operation: CliOperation,
): Promise<void> {
  if (!isTextMediaType(mediaType) && process.stdout.isTTY === true) {
    throw new BadInputError(
      'refusing to write binary export data to a TTY; use --output or pipe stdout',
    )
  }

  let outputFailure: unknown
  const fail = (error: unknown) => {
    outputFailure ??= error
    operation.abort(error)
  }
  const onError = (error: Error) => fail(error)
  const onClose = () => {
    if (!process.stdout.writableFinished) {
      const error = new Error('stdout closed before the export completed')
      Object.assign(error, { code: 'EPIPE' })
      fail(error)
    }
  }
  process.stdout.on('error', onError)
  process.stdout.on('close', onClose)
  try {
    for await (const chunk of bytes) {
      operation.signal.throwIfAborted()
      if (outputFailure !== undefined) throw outputFailure
      if (chunk.byteLength === 0) continue
      try {
        await writeStdoutChunk(chunk, operation.signal)
      } catch (error) {
        fail(error)
        throw error
      }
      if (outputFailure !== undefined) throw outputFailure
    }
    operation.signal.throwIfAborted()
    if (outputFailure !== undefined) throw outputFailure
  } finally {
    process.stdout.removeListener('error', onError)
    process.stdout.removeListener('close', onClose)
  }
}

export async function writeCliFileAtomically(
  outputPath: string,
  bytes: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const target = resolve(outputPath)
  const directory = dirname(target)
  const temporary = resolve(
    directory,
    `.${basename(target)}.databench-${process.pid}-${randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    signal.throwIfAborted()
    handle = await open(temporary, 'wx', 0o600)
    await handle.chmod(0o600)
    for await (const chunk of bytes) {
      signal.throwIfAborted()
      let offset = 0
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null)
        if (bytesWritten <= 0) throw new Error('export file write made no progress')
        offset += bytesWritten
      }
    }
    signal.throwIfAborted()
    await handle.sync()
    await handle.close()
    handle = undefined
    signal.throwIfAborted()
    await rename(temporary, target)
    return target
  } catch (primaryError) {
    const cleanupFailures: unknown[] = []
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    try {
      await rm(temporary, { force: true })
    } catch (error) {
      cleanupFailures.push(error)
    }
    if (cleanupFailures.length > 0) {
      const cleanupError =
        cleanupFailures.length === 1
          ? cleanupFailures[0]
          : new AggregateError(cleanupFailures, 'Multiple temporary export cleanup steps failed')
      attachCleanupFailure(primaryError, cleanupError)
    }
    throw primaryError
  }
}

function isTextMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(';', 1)[0]?.trim().toLowerCase()
  return (
    normalized?.startsWith('text/') === true ||
    normalized === 'application/json' ||
    normalized === 'application/x-ndjson' ||
    normalized?.endsWith('+json') === true
  )
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('CLI operation was aborted', 'AbortError')
}

function attachCleanupFailure(primaryError: unknown, cleanupError: unknown): void {
  if (
    (typeof primaryError === 'object' && primaryError !== null) ||
    typeof primaryError === 'function'
  ) {
    try {
      Object.defineProperties(primaryError, {
        cliCleanupFailed: { configurable: true, value: true },
        suppressed: { configurable: true, value: cleanupError },
      })
      return
    } catch {
      // A frozen/non-extensible third-party error is handled by the aggregate below.
    }
  }
  throw new AggregateError(
    [primaryError, cleanupError],
    'Export failed and temporary export cleanup also failed',
  )
}

async function writeStdoutChunk(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolveWrite, rejectWrite) => {
    let settled = false
    const cleanup = () => {
      process.stdout.removeListener('error', onError)
      process.stdout.removeListener('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined || error === null) resolveWrite()
      else rejectWrite(error)
    }
    const onError = (error: Error) => finish(error)
    const onClose = () => {
      const error = new Error('stdout closed before the export completed')
      Object.assign(error, { code: 'EPIPE' })
      finish(error)
    }
    const onAbort = () => finish(abortReason(signal))
    process.stdout.once('error', onError)
    process.stdout.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      process.stdout.write(chunk, (error) => finish(error))
    } catch (error) {
      finish(error)
    }
  })
}
