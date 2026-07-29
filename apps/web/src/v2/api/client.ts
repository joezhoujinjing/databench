import {
  buildUrl,
  createApiClient,
  createAuthorizedFetch,
  type OpenApiFetchLike,
  unwrapOpenApiResponse,
} from '@/api/client.js'
import { ApiError, ensureJsonResponse } from '@/api/errors.js'
import type {
  AuditResultV2,
  CapabilitiesV2Envelope,
  ConverterRegistryPageV2,
  CreateBasicCleanJobRequestV2,
  DatasetLineageV2,
  DatasetViewV2,
  DeletedRefPageV2,
  DeleteRefRequestV2,
  DeleteRefResultV2,
  EvaluationRunPageV2,
  ExportPlanV2,
  ExportRequestV2,
  IngestResultV2,
  InspectExportRequestV2,
  PutRefRequestV2,
  RecordPageV2,
  RecordViewV2,
  RefMetadataV2,
  RefPageV2,
  RestoreRefRequestV2,
  RestoreRefResultV2,
  RunTransformRequestV2,
  RunTransformResultV2,
  TransformJobPageV2,
  TransformJobV2,
  TransformRegistryPageV2,
} from './types.js'

export interface V2ReadOptions {
  readonly base: string
  readonly fetch?: OpenApiFetchLike
  readonly signal?: AbortSignal
  readonly token: string
}

export interface V2RefsOptions extends V2ReadOptions {
  readonly cursor: string | null
  readonly limit: number
}

export interface V2DatasetOptions extends V2ReadOptions {
  readonly refOrVersion: string
}

export interface V2RecordsOptions extends V2DatasetOptions {
  readonly limit: number
  readonly offset: number
}

export interface V2RecordOptions extends V2DatasetOptions {
  readonly recordId: string
}

export interface V2IngestOptions extends V2ReadOptions {
  readonly expectedRefVersion: string | null
  readonly file: File
  readonly message: string | null
  readonly ref: string | null
}

export interface V2LineageOptions extends V2DatasetOptions {
  readonly cursor: string | null
  readonly maxDepth: number
  readonly maxNodes: number
}

export interface V2RunTransformOptions extends V2ReadOptions {
  readonly name: string
  readonly request: RunTransformRequestV2
}

export interface V2TransformJobsOptions extends V2ReadOptions {
  readonly cursor: string | null
  readonly limit: number
}

export interface V2EvaluationRunsOptions extends V2ReadOptions {
  readonly datasetVersion: string
  readonly limit: number
}

export interface V2CreateBasicCleanJobOptions extends V2ReadOptions {
  readonly request: CreateBasicCleanJobRequestV2
}

export interface V2TransformJobOptions extends V2ReadOptions {
  readonly jobId: string
}

export interface V2PutRefOptions extends V2ReadOptions {
  readonly name: string
  readonly request: PutRefRequestV2
}

export interface V2DeleteRefOptions extends V2ReadOptions {
  readonly name: string
  readonly request: DeleteRefRequestV2
}

export interface V2RestoreRefOptions extends V2ReadOptions {
  readonly name: string
  readonly request: RestoreRefRequestV2
}

export interface V2InspectExportOptions extends V2DatasetOptions {
  readonly request: InspectExportRequestV2
}

export interface V2ExportOptions extends V2ReadOptions {
  readonly datasetVersion: string
  readonly request: ExportRequestV2
}

export function getCapabilitiesV2(options: V2ReadOptions): Promise<CapabilitiesV2Envelope> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/capabilities', requestOptions(options.signal)),
  )
}

export function listRefsV2(options: V2RefsOptions): Promise<RefPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/refs', {
      ...requestOptions(options.signal),
      params: {
        query: {
          cursor: options.cursor,
          limit: options.limit,
        },
      },
    }),
  )
}

export function listDeletedRefsV2(options: V2RefsOptions): Promise<DeletedRefPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/deleted-refs', {
      ...requestOptions(options.signal),
      params: {
        query: {
          cursor: options.cursor,
          limit: options.limit,
        },
      },
    }),
  )
}

export function describeDatasetV2(options: V2DatasetOptions): Promise<DatasetViewV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/datasets/{ref_or_version}', {
      ...requestOptions(options.signal),
      params: { path: { ref_or_version: options.refOrVersion } },
    }),
  )
}

export function auditDatasetV2(options: V2DatasetOptions): Promise<AuditResultV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/datasets/{ref_or_version}:audit', {
      ...requestOptions(options.signal),
      params: { path: { ref_or_version: options.refOrVersion } },
    }),
  )
}

export async function ingestCanonicalDatasetV2(options: V2IngestOptions): Promise<IngestResultV2> {
  const form = new FormData()
  form.append('file', options.file, options.file.name)
  if (options.ref !== null) form.append('ref', options.ref)
  if (options.expectedRefVersion !== null) {
    form.append('expected_ref_version', options.expectedRefVersion)
  }
  if (options.message !== null) form.append('message', options.message)

  const response = await authorizedFetch(options)(
    new Request(buildUrl(options.base, '/v2/datasets:ingest-jsonl'), {
      body: form,
      method: 'POST',
      ...requestOptions(options.signal),
    }),
  )
  await ensureJsonResponse(response)
  return (await response.json()) as IngestResultV2
}

export function listTransformsV2(options: V2ReadOptions): Promise<TransformRegistryPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/transforms', requestOptions(options.signal)),
  )
}

export function runTransformV2(options: V2RunTransformOptions): Promise<RunTransformResultV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/transforms/{name}/run', {
      ...requestOptions(options.signal),
      body: options.request,
      params: { path: { name: options.name } },
    }),
  )
}

export function createBasicCleanJobV2(
  options: V2CreateBasicCleanJobOptions,
): Promise<TransformJobV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/transforms/basic-clean/jobs', {
      ...requestOptions(options.signal),
      body: options.request,
    }),
  )
}

export function listTransformJobsV2(options: V2TransformJobsOptions): Promise<TransformJobPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/transform-jobs', {
      ...requestOptions(options.signal),
      params: { query: { cursor: options.cursor, limit: options.limit } },
    }),
  )
}

export function listEvaluationRunsV2(
  options: V2EvaluationRunsOptions,
): Promise<EvaluationRunPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/evaluation-runs', {
      ...requestOptions(options.signal),
      params: {
        query: {
          cursor: null,
          dataset_version: options.datasetVersion,
          limit: options.limit,
        },
      },
    }),
  )
}

export function getTransformJobV2(options: V2TransformJobOptions): Promise<TransformJobV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/transform-jobs/{job_id}', {
      ...requestOptions(options.signal),
      params: { path: { job_id: options.jobId } },
    }),
  )
}

export function cancelTransformJobV2(options: V2TransformJobOptions): Promise<TransformJobV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/transform-jobs/{job_id}:cancel', {
      ...requestOptions(options.signal),
      params: { path: { job_id: options.jobId } },
    }),
  )
}

export function retryTransformJobV2(options: V2TransformJobOptions): Promise<TransformJobV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/transform-jobs/{job_id}:retry', {
      ...requestOptions(options.signal),
      params: { path: { job_id: options.jobId } },
    }),
  )
}

export function putRefV2(options: V2PutRefOptions): Promise<RefMetadataV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).PUT('/v2/refs/{name}', {
      ...requestOptions(options.signal),
      body: options.request,
      params: { path: { name: options.name } },
    }),
  )
}

export function deleteRefV2(options: V2DeleteRefOptions): Promise<DeleteRefResultV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).DELETE('/v2/refs/{name}', {
      ...requestOptions(options.signal),
      body: options.request,
      params: { path: { name: options.name } },
    }),
  )
}

export function restoreRefV2(options: V2RestoreRefOptions): Promise<RestoreRefResultV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).POST('/v2/refs/{name}:restore', {
      ...requestOptions(options.signal),
      body: options.request,
      params: { path: { name: options.name } },
    }),
  )
}

export async function getLineageV2(options: V2LineageOptions): Promise<DatasetLineageV2> {
  const page = await unwrapOpenApiResponse<DatasetLineageV2>(
    createApiClient(options).GET('/v2/lineage/{ref_or_version}', {
      ...requestOptions(options.signal),
      params: {
        path: { ref_or_version: options.refOrVersion },
        query: {
          cursor: options.cursor,
          max_depth: options.maxDepth,
          max_nodes: options.maxNodes,
        },
      },
    }),
  )
  if (page.root_dataset_version !== options.refOrVersion) {
    throw new ApiError({
      code: 'integrity_error',
      message: 'The lineage page does not match the requested immutable dataset version.',
      status: 500,
    })
  }
  return page
}

export function listConvertersV2(options: V2ReadOptions): Promise<ConverterRegistryPageV2> {
  return unwrapOpenApiResponse(
    createApiClient(options).GET('/v2/converters', requestOptions(options.signal)),
  )
}

export async function inspectExportV2(options: V2InspectExportOptions): Promise<ExportPlanV2> {
  const plan = await unwrapOpenApiResponse<ExportPlanV2>(
    createApiClient(options).POST('/v2/datasets/{ref_or_version}:inspect-export', {
      ...requestOptions(options.signal),
      body: options.request,
      params: { path: { ref_or_version: options.refOrVersion } },
    }),
  )
  if (plan.dataset_version !== options.refOrVersion) {
    throw new ApiError({
      code: 'integrity_error',
      message: 'The export plan does not match the requested immutable dataset version.',
      status: 500,
    })
  }
  return plan
}

export function exportDatasetV2Response(options: V2ExportOptions): Promise<Response> {
  return authorizedFetch(options)(
    new Request(
      buildUrl(options.base, `/v2/datasets/${encodeURIComponent(options.datasetVersion)}:export`),
      {
        body: JSON.stringify(options.request),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        ...requestOptions(options.signal),
      },
    ),
  )
}

export async function listDatasetRecordsV2(options: V2RecordsOptions): Promise<RecordPageV2> {
  const page = await unwrapOpenApiResponse<RecordPageV2>(
    createApiClient(options).GET('/v2/datasets/{ref_or_version}/records', {
      ...requestOptions(options.signal),
      params: {
        path: { ref_or_version: options.refOrVersion },
        query: { limit: options.limit, offset: options.offset },
      },
    }),
  )

  if (page.dataset_version !== options.refOrVersion || page.offset !== options.offset) {
    throw new ApiError({
      code: 'integrity_error',
      message: 'The record page does not match the requested immutable dataset version.',
      status: 500,
    })
  }

  return page
}

export async function getDatasetRecordV2(options: V2RecordOptions): Promise<RecordViewV2> {
  const view = await unwrapOpenApiResponse<RecordViewV2>(
    createApiClient(options).GET('/v2/datasets/{ref_or_version}/records/{record_id}', {
      ...requestOptions(options.signal),
      params: {
        path: {
          record_id: options.recordId,
          ref_or_version: options.refOrVersion,
        },
      },
    }),
  )

  if (view.dataset_version !== options.refOrVersion || view.record.id !== options.recordId) {
    throw new ApiError({
      code: 'integrity_error',
      message: 'The record does not match the requested immutable dataset version.',
      status: 500,
    })
  }

  return view
}

function requestOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function authorizedFetch(options: V2ReadOptions): OpenApiFetchLike {
  return createAuthorizedFetch(options.token, options.fetch)
}
