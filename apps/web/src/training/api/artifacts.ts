import {
  buildUrl,
  createApiClient,
  createAuthorizedFetch,
  type OpenApiFetchLike,
  unwrapOpenApiResponse,
} from '@/api/client.js'
import { responseToApiError } from '@/api/errors.js'
import type { components } from '@/api/generated/schema.js'
import { safeFilename } from '@/v2/api/export.js'

export type CreateModelArtifactImportRequestV2 =
  components['schemas']['CreateModelArtifactImportRequestV2']
export type ModelArtifactImportV2 = components['schemas']['ModelArtifactImportV2']
export type ModelArtifactPageV2 = components['schemas']['ModelArtifactPageV2']
export type ModelArtifactV2 = components['schemas']['ModelArtifactV2']
export type SwiftStudioOutputCandidatePageV2 =
  components['schemas']['SwiftStudioOutputCandidatePageV2']
export type SwiftStudioOutputCandidateV2 = components['schemas']['SwiftStudioOutputCandidateV2']

interface ArtifactClientOptions {
  readonly base: string
  readonly fetch?: OpenApiFetchLike
  readonly signal?: AbortSignal
  readonly token: string
}

export interface ListSwiftStudioOutputsOptions extends ArtifactClientOptions {
  readonly sessionId: string
}

export interface CreateModelArtifactImportOptions extends ArtifactClientOptions {
  readonly request: CreateModelArtifactImportRequestV2
}

export interface ModelArtifactImportOptions extends ArtifactClientOptions {
  readonly importId: string
}

export interface ListModelArtifactsOptions extends ArtifactClientOptions {
  readonly cursor: string | null
  readonly datasetVersion?: string
  readonly limit: number
  readonly registrationStatus?: 'all' | 'registered' | 'unregistered'
}

export interface ModelArtifactOptions extends ArtifactClientOptions {
  readonly artifactId: string
}

interface WritableFileStreamLike {
  abort(reason?: unknown): Promise<void>
  close(): Promise<void>
  write(data: Uint8Array): Promise<void>
}

interface FileHandleLike {
  createWritable(): Promise<WritableFileStreamLike>
}

export type ModelArtifactDownloadTarget =
  | { readonly kind: 'blob' }
  | { readonly handle: FileHandleLike; readonly kind: 'file-system' }

export interface DownloadModelArtifactOptions extends ArtifactClientOptions {
  readonly artifact: ModelArtifactV2
  readonly blobLimitBytes?: number
  readonly onBytes?: (bytes: number) => void
  readonly target: ModelArtifactDownloadTarget
}

export const MODEL_ARTIFACT_BLOB_LIMIT_BYTES = 256 * 1024 * 1024

export class ModelArtifactDownloadError extends Error {
  readonly code: 'content_type' | 'empty_stream' | 'size_mismatch' | 'size_limit' | 'stream_failed'

  constructor(code: ModelArtifactDownloadError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ModelArtifactDownloadError'
    this.code = code
  }
}

export function listSwiftStudioOutputsV2(
  options: ListSwiftStudioOutputsOptions,
): Promise<SwiftStudioOutputCandidatePageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/swift-studio-sessions/{session_id}/outputs', {
      ...requestOptions(options.signal),
      params: { path: { session_id: options.sessionId } },
    }),
  )
}

export function createModelArtifactImportV2(
  options: CreateModelArtifactImportOptions,
): Promise<ModelArtifactImportV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/model-artifact-imports', {
      ...requestOptions(options.signal),
      body: options.request,
    }),
  )
}

export function getModelArtifactImportV2(
  options: ModelArtifactImportOptions,
): Promise<ModelArtifactImportV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/model-artifact-imports/{import_id}', {
      ...requestOptions(options.signal),
      params: { path: { import_id: options.importId } },
    }),
  )
}

export function listModelArtifactsV2(
  options: ListModelArtifactsOptions,
): Promise<ModelArtifactPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/model-artifacts', {
      ...requestOptions(options.signal),
      params: {
        query: {
          artifact_kind: 'lora_adapter',
          cursor: options.cursor,
          limit: options.limit,
          registration_status: options.registrationStatus ?? 'all',
          ...(options.datasetVersion === undefined
            ? {}
            : { dataset_version: options.datasetVersion }),
        },
      },
    }),
  )
}

export function getModelArtifactV2(options: ModelArtifactOptions): Promise<ModelArtifactV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/model-artifacts/{artifact_id}', {
      ...requestOptions(options.signal),
      params: { path: { artifact_id: options.artifactId } },
    }),
  )
}

export function modelArtifactDownloadUrlV2(base: string, artifactId: string): string {
  return buildUrl(base, `/v2/model-artifacts/${encodeURIComponent(artifactId)}:download`)
}

export async function chooseModelArtifactDownloadTarget(
  artifact: ModelArtifactV2,
): Promise<ModelArtifactDownloadTarget> {
  const picker = (
    globalThis as unknown as {
      showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileHandleLike>
    }
  ).showSaveFilePicker
  if (picker === undefined) return { kind: 'blob' }
  return {
    handle: await picker({ suggestedName: artifactFilename(artifact) }),
    kind: 'file-system',
  }
}

export async function downloadModelArtifactV2(
  options: DownloadModelArtifactOptions,
): Promise<{ bytes: number }> {
  const expectedBytes = options.artifact.archive_size_bytes
  const blobLimit = options.blobLimitBytes ?? MODEL_ARTIFACT_BLOB_LIMIT_BYTES
  if (options.target.kind === 'blob' && expectedBytes > blobLimit) {
    throw new ModelArtifactDownloadError(
      'size_limit',
      `This Artifact is larger than the browser's ${blobLimit} byte in-memory download limit.`,
    )
  }
  const authorizedFetch = createAuthorizedFetch(options.token, options.fetch)
  const response = await authorizedFetch(
    new Request(modelArtifactDownloadUrlV2(options.base, options.artifact.id), {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
  )
  if (!response.ok) throw await responseToApiError(response)
  const contentType = response.headers.get('Content-Type')?.trim().toLowerCase()
  if (contentType !== 'application/zstd') {
    throw new ModelArtifactDownloadError(
      'content_type',
      `Unexpected Model Artifact Content-Type: ${contentType ?? '(missing)'}.`,
    )
  }
  const declaredLength = response.headers.get('Content-Length')
  if (declaredLength !== null && Number(declaredLength) !== expectedBytes) {
    throw new ModelArtifactDownloadError(
      'size_mismatch',
      'Model Artifact response size did not match immutable metadata.',
    )
  }
  if (response.body === null) {
    throw new ModelArtifactDownloadError(
      'empty_stream',
      'The Model Artifact response did not include a byte stream.',
    )
  }
  return options.target.kind === 'file-system'
    ? streamArtifactToFile(response.body, options.target.handle, options)
    : streamArtifactToBlob(response.body, options, blobLimit)
}

function requestOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

async function streamArtifactToFile(
  stream: ReadableStream<Uint8Array>,
  handle: FileHandleLike,
  options: DownloadModelArtifactOptions,
): Promise<{ bytes: number }> {
  const reader = stream.getReader()
  let writable: WritableFileStreamLike | null = null
  let bytes = 0
  let closed = false
  try {
    options.signal?.throwIfAborted()
    writable = await handle.createWritable()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      await writable.write(value)
      options.onBytes?.(bytes)
    }
    options.signal?.throwIfAborted()
    if (bytes !== options.artifact.archive_size_bytes) {
      throw new ModelArtifactDownloadError(
        'size_mismatch',
        'Downloaded Model Artifact bytes did not match immutable metadata.',
      )
    }
    await writable.close()
    closed = true
    return { bytes }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    if (!closed && writable !== null) await writable.abort(error).catch(() => undefined)
    if (error instanceof ModelArtifactDownloadError) throw error
    throw new ModelArtifactDownloadError(
      'stream_failed',
      'The Model Artifact download was interrupted.',
      error,
    )
  } finally {
    reader.releaseLock()
  }
}

async function streamArtifactToBlob(
  stream: ReadableStream<Uint8Array>,
  options: DownloadModelArtifactOptions,
  limit: number,
): Promise<{ bytes: number }> {
  const reader = stream.getReader()
  const chunks: ArrayBuffer[] = []
  let bytes = 0
  try {
    options.signal?.throwIfAborted()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) {
        throw new ModelArtifactDownloadError(
          'size_limit',
          `The browser download exceeded the ${limit} byte in-memory limit.`,
        )
      }
      const copy = new Uint8Array(value.byteLength)
      copy.set(value)
      chunks.push(copy.buffer)
      options.onBytes?.(bytes)
    }
    options.signal?.throwIfAborted()
    if (bytes !== options.artifact.archive_size_bytes) {
      throw new ModelArtifactDownloadError(
        'size_mismatch',
        'Downloaded Model Artifact bytes did not match immutable metadata.',
      )
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    if (error instanceof ModelArtifactDownloadError) throw error
    throw new ModelArtifactDownloadError(
      'stream_failed',
      'The Model Artifact download was interrupted.',
      error,
    )
  } finally {
    reader.releaseLock()
  }

  const url = URL.createObjectURL(new Blob(chunks, { type: 'application/zstd' }))
  const anchor = document.createElement('a')
  anchor.download = artifactFilename(options.artifact)
  anchor.href = url
  anchor.rel = 'noopener'
  try {
    anchor.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return { bytes }
}

function artifactFilename(artifact: ModelArtifactV2): string {
  return safeFilename(`${artifact.display_name}.tar.zst`)
}
