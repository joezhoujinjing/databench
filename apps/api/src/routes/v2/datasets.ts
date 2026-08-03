import {
  AuditResultV2Schema,
  BadInputError,
  BinaryBodyV2Schema,
  DatasetRecordParamsV2Schema,
  DatasetRefOrVersionParamsV2Schema,
  DatasetVersionParamsV2Schema,
  DatasetViewV2Schema,
  ExportPlanV2Schema,
  ExportPreviewV2Schema,
  ExportRequestV2Schema,
  IngestCanonicalV2FormSchema,
  IngestResultV2Schema,
  InspectExportRequestV2Schema,
  NotFoundError,
  RecordPageRequestV2Schema,
  RecordPageV2Schema,
  RecordViewV2Schema,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { getV2Workspace } from '../../context.js'
import { parseV2IngestMultipart } from '../../v2/multipart.js'
import {
  binaryResponseV2,
  jsonResponseV2,
  V2_AUDIT_ERROR_RESPONSES,
  V2_DATASET_DESCRIBE_ERROR_RESPONSES,
  V2_DATASET_READ_ERROR_RESPONSES,
  V2_EXPORT_ERROR_RESPONSES,
  V2_INGEST_ERROR_RESPONSES,
  V2_INSPECT_EXPORT_ERROR_RESPONSES,
} from './openapi.js'
import {
  assertJsonContentTypeV2,
  contentDispositionAttachmentV2,
  readRawJsonRequestV2,
  streamAsyncIterableV2,
} from './transport.js'

const ingestRoute = createRoute({
  method: 'post',
  path: '/v2/datasets:ingest-jsonl',
  operationId: 'ingestCanonicalDatasetV2',
  tags: ['v2 datasets'],
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: IngestCanonicalV2FormSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponseV2(IngestResultV2Schema, 'Committed canonical V2 dataset'),
    ...V2_INGEST_ERROR_RESPONSES,
  },
})

const describeRoute = createRoute({
  method: 'get',
  path: '/v2/datasets/{ref_or_version}',
  operationId: 'describeDatasetV2',
  tags: ['v2 datasets'],
  request: { params: DatasetRefOrVersionParamsV2Schema },
  responses: {
    200: jsonResponseV2(DatasetViewV2Schema, 'Exact V2 dataset view'),
    ...V2_DATASET_DESCRIBE_ERROR_RESPONSES,
  },
})

const recordsRoute = createRoute({
  method: 'get',
  path: '/v2/datasets/{ref_or_version}/records',
  operationId: 'listDatasetRecordsV2',
  tags: ['v2 datasets'],
  request: {
    params: DatasetRefOrVersionParamsV2Schema,
    query: RecordPageRequestV2Schema,
  },
  responses: {
    200: jsonResponseV2(RecordPageV2Schema, 'Exact-version V2 record summaries'),
    ...V2_DATASET_READ_ERROR_RESPONSES,
  },
})

const recordRoute = createRoute({
  method: 'get',
  path: '/v2/datasets/{ref_or_version}/records/{record_id}',
  operationId: 'getDatasetRecordV2',
  tags: ['v2 datasets'],
  request: { params: DatasetRecordParamsV2Schema },
  responses: {
    200: jsonResponseV2(RecordViewV2Schema, 'Complete canonical V2 record view'),
    ...V2_DATASET_READ_ERROR_RESPONSES,
  },
})

const auditRoute = createRoute({
  method: 'post',
  path: '/v2/datasets/{ref_or_version}:audit',
  operationId: 'auditDatasetV2',
  tags: ['v2 datasets'],
  request: { params: DatasetRefOrVersionParamsV2Schema },
  responses: {
    200: jsonResponseV2(AuditResultV2Schema, 'Full V2 layout integrity audit'),
    ...V2_AUDIT_ERROR_RESPONSES,
  },
})

const inspectExportRoute = createRoute({
  method: 'post',
  path: '/v2/datasets/{ref_or_version}:inspect-export',
  operationId: 'inspectDatasetExportV2',
  tags: ['v2 export'],
  request: {
    params: DatasetRefOrVersionParamsV2Schema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: InspectExportRequestV2Schema,
        },
      },
    },
  },
  responses: {
    200: jsonResponseV2(ExportPlanV2Schema, 'Deterministic V2 export fidelity plan'),
    ...V2_INSPECT_EXPORT_ERROR_RESPONSES,
  },
})

const previewExportRoute = createRoute({
  method: 'post',
  path: '/v2/datasets/{ref_or_version}:preview-export',
  operationId: 'previewDatasetExportV2',
  tags: ['v2 export'],
  request: {
    params: DatasetRefOrVersionParamsV2Schema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: InspectExportRequestV2Schema,
        },
      },
    },
  },
  responses: {
    200: jsonResponseV2(ExportPreviewV2Schema, 'Bounded real-record V2 export preview'),
    ...V2_INSPECT_EXPORT_ERROR_RESPONSES,
  },
})

const exportRoute = createRoute({
  method: 'post',
  path: '/v2/datasets/{dataset_version}:export',
  operationId: 'exportDatasetV2',
  tags: ['v2 export'],
  request: {
    params: DatasetVersionParamsV2Schema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: ExportRequestV2Schema,
        },
      },
    },
  },
  responses: {
    200: binaryResponseV2(BinaryBodyV2Schema, 'Exact-version deterministic V2 export stream'),
    ...V2_EXPORT_ERROR_RESPONSES,
  },
})

export function registerV2DatasetRoutes(app: OpenAPIHono<ApiEnv>): void {
  registerOpenApiPaths(app)

  app.post(ingestRoute.getRoutingPath(), async (context) => {
    const workspace = getV2Workspace(context)
    const limits = workspace.postTrainingV2Capability().limits
    const multipart = parseV2IngestMultipart(context.req.raw, {
      maxRequestBytes: limits.max_request_bytes,
      maxFileBytes: limits.max_request_bytes,
      signal: context.req.raw.signal,
    })

    try {
      const result = await workspace.addJsonl(multipart.file, multipart.options, {
        signal: context.req.raw.signal,
      })
      return context.json(result, 200)
    } catch (error) {
      multipart.cancel(error)
      throw error
    }
  })

  app.get(describeRoute.getRoutingPath(), async (context) => {
    const { ref_or_version } = DatasetRefOrVersionParamsV2Schema.parse(context.req.param())
    const result = await getV2Workspace(context).describeDataset(ref_or_version, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 200)
  })

  app.get(recordsRoute.getRoutingPath(), async (context) => {
    const { ref_or_version } = DatasetRefOrVersionParamsV2Schema.parse(context.req.param())
    const request = RecordPageRequestV2Schema.parse(context.req.query())
    const result = await getV2Workspace(context).getRecordPage(ref_or_version, request, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 200)
  })

  app.get(recordRoute.getRoutingPath(), async (context) => {
    const { ref_or_version, record_id } = DatasetRecordParamsV2Schema.parse(context.req.param())
    const result = await getV2Workspace(context).getRecordView(ref_or_version, record_id, {
      signal: context.req.raw.signal,
    })
    if (result === null) {
      throw new NotFoundError('V2 record was not found', {
        dataset: ref_or_version,
        record_id,
      })
    }
    return context.json(result, 200)
  })

  app.post('/v2/datasets/:target{[^/]+:audit}', async (context) => {
    const ref_or_version = actionTarget(context.req.param('target'), ':audit')
    DatasetRefOrVersionParamsV2Schema.parse({ ref_or_version })
    const result = await getV2Workspace(context).audit(ref_or_version, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 200)
  })

  app.post('/v2/datasets/:target{[^/]+:inspect-export}', async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const ref_or_version = actionTarget(context.req.param('target'), ':inspect-export')
    DatasetRefOrVersionParamsV2Schema.parse({ ref_or_version })
    const workspace = getV2Workspace(context)
    const limits = workspace.postTrainingV2Capability().limits
    const request = await readRawJsonRequestV2(context, InspectExportRequestV2Schema, {
      maxBytes: limits.max_record_bytes,
      maxDepth: limits.max_nesting_depth,
    })
    const plan = await workspace.inspectExport(ref_or_version, request, {
      signal: context.req.raw.signal,
    })
    return context.json(plan, 200)
  })

  app.post('/v2/datasets/:target{[^/]+:preview-export}', async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const ref_or_version = actionTarget(context.req.param('target'), ':preview-export')
    DatasetRefOrVersionParamsV2Schema.parse({ ref_or_version })
    const workspace = getV2Workspace(context)
    const limits = workspace.postTrainingV2Capability().limits
    const request = await readRawJsonRequestV2(context, InspectExportRequestV2Schema, {
      maxBytes: limits.max_record_bytes,
      maxDepth: limits.max_nesting_depth,
    })
    const preview = await workspace.previewExport(ref_or_version, request, {
      signal: context.req.raw.signal,
    })
    return context.json(preview, 200)
  })

  app.post('/v2/datasets/:target{[^/]+:export}', async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const dataset_version = actionTarget(context.req.param('target'), ':export')
    DatasetVersionParamsV2Schema.parse({ dataset_version })
    const workspace = getV2Workspace(context)
    const limits = workspace.postTrainingV2Capability().limits
    const request = await readRawJsonRequestV2(context, ExportRequestV2Schema, {
      maxBytes: limits.max_record_bytes,
      maxDepth: limits.max_nesting_depth,
    })
    const streamAbort = new AbortController()
    const signal = AbortSignal.any([context.req.raw.signal, streamAbort.signal])
    const exported = await workspace.export(dataset_version, request, { signal })
    const body = streamAsyncIterableV2(exported.bytes, (reason) => {
      streamAbort.abort(
        reason ?? new DOMException('V2 export response was cancelled', 'AbortError'),
      )
    })

    return context.body(body, 200, {
      'Content-Type': exported.plan.media_type,
      'Content-Disposition': contentDispositionAttachmentV2(exported.plan.suggested_filename),
    })
  })
}

function registerOpenApiPaths(app: OpenAPIHono<ApiEnv>): void {
  for (const route of [
    ingestRoute,
    describeRoute,
    recordsRoute,
    recordRoute,
    auditRoute,
    inspectExportRoute,
    previewExportRoute,
    exportRoute,
  ]) {
    app.openAPIRegistry.registerPath(route)
  }
}

function actionTarget(value: string | undefined, suffix: string): string {
  if (value === undefined || !value.endsWith(suffix)) {
    throw new BadInputError(`Malformed V2 action path; expected suffix ${suffix}`)
  }
  return value.slice(0, -suffix.length)
}
