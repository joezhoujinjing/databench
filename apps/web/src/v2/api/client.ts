import { createApiClient, type OpenApiFetchLike, unwrapOpenApiResponse } from '@/api/client.js'
import { ApiError } from '@/api/errors.js'
import type {
  AuditResultV2,
  CapabilitiesV2Envelope,
  DatasetViewV2,
  RecordPageV2,
  RecordViewV2,
  RefPageV2,
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
