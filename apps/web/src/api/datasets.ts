import { buildUrl, expectOkResponse, type FetchLike, rawRequest, requestJson } from './client.js'
import { clampLimit } from './pagination.js'
import type {
  DatasetManifest,
  ExportFormat,
  IngestKind,
  IngestSamplesRequest,
  SamplesPage,
} from './types.js'

export interface DatasetRequestOptions {
  base: string
  fetch?: FetchLike
  token: string
}

export interface SamplesRequestOptions extends DatasetRequestOptions {
  limit: number
  offset?: number
  ref: string
}

export interface IngestJsonlOptions extends DatasetRequestOptions {
  file: Blob
  kind?: IngestKind | ''
  name?: string
  source?: string
}

export interface ExportDatasetOptions extends DatasetRequestOptions {
  fmt?: ExportFormat
  ref: string
}

export function createDataset(
  options: DatasetRequestOptions & { payload: IngestSamplesRequest },
): Promise<DatasetManifest> {
  const { payload, ...requestOptions } = options

  return requestJson<DatasetManifest>('/v1/datasets', {
    ...requestOptions,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
}

export function ingestJsonl(options: IngestJsonlOptions): Promise<DatasetManifest> {
  const { file, kind, name, source, ...requestOptions } = options
  const formData = new FormData()
  const filename = typeof File !== 'undefined' && file instanceof File ? file.name : 'dataset.jsonl'

  formData.append('file', file, filename)

  return requestJson<DatasetManifest>('/v1/datasets:ingest-jsonl', {
    ...requestOptions,
    body: formData,
    method: 'POST',
    query: {
      kind: kind === '' ? undefined : kind,
      name: blankToUndefined(name),
      source: blankToUndefined(source),
    },
  })
}

export function getDataset(
  options: DatasetRequestOptions & { ref: string },
): Promise<DatasetManifest> {
  const { ref, ...requestOptions } = options

  return requestJson<DatasetManifest>(`/v1/datasets/${encodeURIComponent(ref)}`, requestOptions)
}

export function getSamples(options: SamplesRequestOptions): Promise<SamplesPage> {
  const { limit: requestedLimit, offset, ref, ...requestOptions } = options
  const limit = clampLimit(requestedLimit)

  return requestJson<SamplesPage>(`/v1/datasets/${encodeURIComponent(ref)}/samples`, {
    ...requestOptions,
    query: { limit, offset: offset ?? 0 },
  })
}

export function nextSamplePageParam(lastPage: SamplesPage): number | undefined {
  const nextOffset = lastPage.offset + lastPage.limit

  return nextOffset < lastPage.total ? nextOffset : undefined
}

export function exportDatasetUrl({
  base,
  fmt = 'messages-jsonl',
  ref,
}: Pick<ExportDatasetOptions, 'base' | 'fmt' | 'ref'>): string {
  return buildUrl(base, `/v1/datasets/${encodeURIComponent(ref)}/export`, { fmt })
}

export function exportDatasetResponse(options: ExportDatasetOptions): Promise<Response> {
  const { fmt, ref, ...requestOptions } = options

  return rawRequest(`/v1/datasets/${encodeURIComponent(ref)}/export`, {
    ...requestOptions,
    method: 'GET',
    query: { fmt: fmt ?? 'messages-jsonl' },
  }).then(expectOkResponse)
}

export async function downloadExport(options: ExportDatasetOptions): Promise<void> {
  const fmt = options.fmt ?? 'messages-jsonl'
  const response = await exportDatasetResponse({ ...options, fmt })
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = exportFilename(options.ref, fmt)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function exportFilename(ref: string, fmt: ExportFormat = 'messages-jsonl'): string {
  return `${sanitizeFilenamePart(ref)}.${fmt}.jsonl`
}

export function sanitizeFilenamePart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/gu, '_')
  return sanitized === '' ? 'dataset' : sanitized
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === '' ? undefined : trimmed
}
