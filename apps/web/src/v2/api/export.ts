import { responseToApiError } from '@/api/errors.js'
import { exportDatasetV2Response, type V2ExportOptions } from './client.js'
import type { ExportPlanV2 } from './types.js'

export const BLOB_EXPORT_LIMIT_BYTES = 256 * 1024 * 1024

interface WritableFileStreamLike {
  abort(reason?: unknown): Promise<void>
  close(): Promise<void>
  write(data: Uint8Array): Promise<void>
}

interface FileHandleLike {
  createWritable(): Promise<WritableFileStreamLike>
}

export type ExportTarget =
  | { readonly kind: 'blob' }
  | { readonly handle: FileHandleLike; readonly kind: 'file-system' }

export interface DownloadExportOptions
  extends Pick<V2ExportOptions, 'base' | 'fetch' | 'signal' | 'token'> {
  readonly blobLimitBytes?: number
  readonly onBytes?: (bytes: number) => void
  readonly plan: ExportPlanV2
  readonly target: ExportTarget
}

export class ExportDownloadError extends Error {
  readonly cliCommand?: string
  readonly code: 'content_type' | 'empty_stream' | 'size_limit' | 'stream_failed'

  constructor(
    code: ExportDownloadError['code'],
    message: string,
    options: { cause?: unknown; cliCommand?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ExportDownloadError'
    this.code = code
    if (options.cliCommand !== undefined) this.cliCommand = options.cliCommand
  }
}

export async function chooseExportTarget(suggestedFilename: string): Promise<ExportTarget> {
  const picker = (
    globalThis as unknown as {
      showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileHandleLike>
    }
  ).showSaveFilePicker

  if (picker === undefined) return { kind: 'blob' }
  return {
    handle: await picker({ suggestedName: safeFilename(suggestedFilename) }),
    kind: 'file-system',
  }
}

export async function downloadExportV2(options: DownloadExportOptions): Promise<{ bytes: number }> {
  const { plan } = options
  const response = await exportDatasetV2Response({
    base: options.base,
    datasetVersion: plan.dataset_version,
    request: {
      accepted_fidelity_digest: plan.fidelity_digest,
      converter: plan.converter,
      options: plan.normalized_options,
    },
    token: options.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  if (!response.ok) throw await responseToApiError(response)
  assertContentType(response, plan.media_type)
  if (response.body === null) {
    throw new ExportDownloadError(
      'empty_stream',
      'The export response did not include a byte stream.',
    )
  }

  const filename = responseFilename(response, plan.suggested_filename)
  return options.target.kind === 'file-system'
    ? streamToFile(response.body, options.target.handle, options)
    : streamToBlob(response.body, filename, options)
}

async function streamToFile(
  stream: ReadableStream<Uint8Array>,
  handle: FileHandleLike,
  options: DownloadExportOptions,
): Promise<{ bytes: number }> {
  const reader = stream.getReader()
  let writable: WritableFileStreamLike | null = null
  let bytes = 0
  let closed = false
  let writerAborted = false
  let writerAbort: Promise<void> | null = null
  const cancel = () => {
    const reason = options.signal?.reason ?? new DOMException('Export cancelled', 'AbortError')
    void reader.cancel(reason).catch(() => undefined)
    if (writable !== null) {
      writerAborted = true
      writerAbort = writable.abort(reason).catch(() => undefined)
    }
  }
  options.signal?.addEventListener('abort', cancel, { once: true })

  try {
    if (options.signal?.aborted) throw options.signal.reason
    writable = await handle.createWritable()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      await writable.write(value)
      options.onBytes?.(bytes)
    }
    if (options.signal?.aborted) throw options.signal.reason
    await writable.close()
    if (options.signal?.aborted) throw options.signal.reason
    closed = true
    return { bytes }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    if (!closed && writable !== null) {
      if (writerAborted) {
        await writerAbort
      } else {
        await writable.abort(error).catch(() => undefined)
      }
    }
    throw new ExportDownloadError('stream_failed', 'The export stream was interrupted.', {
      cause: error,
    })
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

async function streamToBlob(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  options: DownloadExportOptions,
): Promise<{ bytes: number }> {
  const reader = stream.getReader()
  const chunks: ArrayBuffer[] = []
  const limit = options.blobLimitBytes ?? BLOB_EXPORT_LIMIT_BYTES
  let bytes = 0
  const cancel = () => {
    const reason = options.signal?.reason ?? new DOMException('Export cancelled', 'AbortError')
    void reader.cancel(reason).catch(() => undefined)
  }
  options.signal?.addEventListener('abort', cancel, { once: true })

  try {
    if (options.signal?.aborted) throw options.signal.reason
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) {
        const error = new ExportDownloadError(
          'size_limit',
          `The browser download exceeded the ${limit} byte safety limit.`,
          { cliCommand: exportCliCommand(options.plan) },
        )
        await reader.cancel(error).catch(() => undefined)
        throw error
      }
      const copy = new Uint8Array(value.byteLength)
      copy.set(value)
      chunks.push(copy.buffer)
      options.onBytes?.(bytes)
    }
    if (options.signal?.aborted) throw options.signal.reason
  } catch (error) {
    if (error instanceof ExportDownloadError) throw error
    await reader.cancel(error).catch(() => undefined)
    throw new ExportDownloadError('stream_failed', 'The export stream was interrupted.', {
      cause: error,
    })
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }

  const url = URL.createObjectURL(new Blob(chunks, { type: options.plan.media_type }))
  const anchor = document.createElement('a')
  anchor.download = filename
  anchor.href = url
  anchor.rel = 'noopener'
  try {
    anchor.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return { bytes }
}

export function assertContentType(response: Response, expected: string): void {
  const actual = response.headers.get('Content-Type')?.trim().toLowerCase()
  if (actual !== expected.trim().toLowerCase()) {
    throw new ExportDownloadError(
      'content_type',
      `Unexpected export Content-Type: ${actual ?? '(missing)'}.`,
    )
  }
}

export function responseFilename(response: Response, fallback: string): string {
  const header = response.headers.get('Content-Disposition')
  const match = header?.match(/(?:^|;)\s*filename="?([^";]+)"?/iu)
  const hinted = match?.[1]
  return hinted === undefined || !isSafeFilename(hinted) ? safeFilename(fallback) : hinted
}

export function safeFilename(value: string): string {
  const cleaned = [...value]
    .map((character) => (isForbiddenFilenameCharacter(character) ? '_' : character))
    .join('')
    .replace(/^\.+/u, '')
    .replace(/[. ]+$/u, '')
    .trim()
  return isSafeFilename(cleaned) ? cleaned : 'databench-export.jsonl'
}

function isSafeFilename(value: string): boolean {
  const stem = value.split('.')[0]?.toUpperCase() ?? ''
  return (
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    value.length <= 180 &&
    ![...value].some(isForbiddenFilenameCharacter) &&
    !value.startsWith('.') &&
    !/[. ]$/u.test(value) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)
  )
}

function isForbiddenFilenameCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0
  return (
    '\\/:*?"<>|'.includes(character) ||
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  )
}

export function exportCliCommand(plan: ExportPlanV2): string {
  const options = JSON.stringify(plan.normalized_options)
  return `databench dataset export ${shellQuote(plan.dataset_version)} --converter ${shellQuote(plan.converter)} --options ${shellQuote(options)} --accept-fidelity ${shellQuote(plan.fidelity_digest)} --output ${shellQuote(safeFilename(plan.suggested_filename))}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
