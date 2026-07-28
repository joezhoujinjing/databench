import {
  BinaryBodyV2Schema,
  CreateModelArtifactImportRequestV2Schema,
  ModelArtifactImportParamsV2Schema,
  ModelArtifactImportV2Schema,
  ModelArtifactPageRequestV2Schema,
  ModelArtifactPageV2Schema,
  ModelArtifactParamsV2Schema,
  ModelArtifactV2Schema,
  NotFoundError,
  SwiftStudioOutputCandidatePageV2Schema,
  SwiftStudioSessionOutputsParamsV2Schema,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { getV2Workspace } from '../../context.js'
import {
  jsonResponseV2,
  modelArtifactBinaryResponseV2,
  V2_MODEL_ARTIFACT_IMPORT_CREATE_ERROR_RESPONSES,
  V2_MODEL_ARTIFACT_LIST_ERROR_RESPONSES,
  V2_MODEL_ARTIFACT_SHOW_ERROR_RESPONSES,
  V2_SWIFT_STUDIO_OUTPUT_LIST_ERROR_RESPONSES,
} from './openapi.js'
import {
  assertJsonContentTypeV2,
  contentDispositionAttachmentV2,
  readRawJsonRequestV2,
  streamAsyncIterableV2,
} from './transport.js'

const CREATE_IMPORT_MAX_BYTES = 128 * 1024

const listOutputsRoute = createRoute({
  method: 'get',
  path: '/v2/swift-studio-sessions/{session_id}/outputs',
  operationId: 'listSwiftStudioSessionOutputsV2',
  tags: ['v2 Swift Studio Model Artifacts'],
  request: { params: SwiftStudioSessionOutputsParamsV2Schema },
  responses: {
    200: jsonResponseV2(SwiftStudioOutputCandidatePageV2Schema, 'Importable Studio outputs'),
    ...V2_SWIFT_STUDIO_OUTPUT_LIST_ERROR_RESPONSES,
  },
})

const createImportRoute = createRoute({
  method: 'post',
  path: '/v2/model-artifact-imports',
  operationId: 'createModelArtifactImportV2',
  tags: ['v2 Swift Studio Model Artifacts'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateModelArtifactImportRequestV2Schema } },
    },
  },
  responses: {
    201: jsonResponseV2(ModelArtifactImportV2Schema, 'Created or replayed Model Artifact import'),
    ...V2_MODEL_ARTIFACT_IMPORT_CREATE_ERROR_RESPONSES,
  },
})

const getImportRoute = createRoute({
  method: 'get',
  path: '/v2/model-artifact-imports/{import_id}',
  operationId: 'getModelArtifactImportV2',
  tags: ['v2 Swift Studio Model Artifacts'],
  request: { params: ModelArtifactImportParamsV2Schema },
  responses: {
    200: jsonResponseV2(ModelArtifactImportV2Schema, 'Model Artifact import'),
    ...V2_MODEL_ARTIFACT_SHOW_ERROR_RESPONSES,
  },
})

const listArtifactsRoute = createRoute({
  method: 'get',
  path: '/v2/model-artifacts',
  operationId: 'listModelArtifactsV2',
  tags: ['v2 Swift Studio Model Artifacts'],
  request: { query: ModelArtifactPageRequestV2Schema },
  responses: {
    200: jsonResponseV2(ModelArtifactPageV2Schema, 'Immutable Model Artifacts'),
    ...V2_MODEL_ARTIFACT_LIST_ERROR_RESPONSES,
  },
})

const getArtifactRoute = createRoute({
  method: 'get',
  path: '/v2/model-artifacts/{artifact_id}',
  operationId: 'getModelArtifactV2',
  tags: ['v2 Swift Studio Model Artifacts'],
  request: { params: ModelArtifactParamsV2Schema },
  responses: {
    200: jsonResponseV2(ModelArtifactV2Schema, 'Immutable Model Artifact'),
    ...V2_MODEL_ARTIFACT_SHOW_ERROR_RESPONSES,
  },
})

const downloadArtifactRoute = createRoute({
  method: 'get',
  path: '/v2/model-artifacts/{artifact_id}:download',
  operationId: 'downloadModelArtifactV2',
  tags: ['v2 Swift Studio Model Artifacts'],
  request: { params: ModelArtifactParamsV2Schema },
  responses: {
    200: modelArtifactBinaryResponseV2(BinaryBodyV2Schema, 'Verified Model Artifact archive'),
    ...V2_MODEL_ARTIFACT_SHOW_ERROR_RESPONSES,
  },
})

export function registerV2ModelArtifactRoutes(app: OpenAPIHono<ApiEnv>): void {
  for (const route of [
    listOutputsRoute,
    createImportRoute,
    getImportRoute,
    listArtifactsRoute,
    getArtifactRoute,
    downloadArtifactRoute,
  ]) {
    app.openAPIRegistry.registerPath(route)
  }

  app.get(listOutputsRoute.getRoutingPath(), async (context) => {
    const { session_id } = SwiftStudioSessionOutputsParamsV2Schema.parse(context.req.param())
    const page = await getV2Workspace(context).listSwiftStudioOutputs(session_id, {
      signal: context.req.raw.signal,
    })
    return context.json(page, 200)
  })

  app.post(createImportRoute.getRoutingPath(), async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(context, CreateModelArtifactImportRequestV2Schema, {
      maxBytes: CREATE_IMPORT_MAX_BYTES,
      maxDepth: 6,
    })
    const artifactImport = await getV2Workspace(context).createModelArtifactImport(request, {
      signal: context.req.raw.signal,
    })
    return context.json(artifactImport, 201)
  })

  app.get(getImportRoute.getRoutingPath(), async (context) => {
    const { import_id } = ModelArtifactImportParamsV2Schema.parse(context.req.param())
    const artifactImport = await getV2Workspace(context).getModelArtifactImport(import_id, {
      signal: context.req.raw.signal,
    })
    if (artifactImport === null) {
      throw new NotFoundError('Model Artifact import was not found', { import_id })
    }
    return context.json(artifactImport, 200)
  })

  app.get(listArtifactsRoute.getRoutingPath(), async (context) => {
    const request = ModelArtifactPageRequestV2Schema.parse(context.req.query())
    const page = await getV2Workspace(context).listModelArtifacts(request, {
      signal: context.req.raw.signal,
    })
    return context.json(page, 200)
  })

  app.get('/v2/model-artifacts/:target{[^/]+:download}', async (context) => {
    const artifact_id = actionTarget(context.req.param('target'), ':download')
    ModelArtifactParamsV2Schema.parse({ artifact_id })
    const streamAbort = new AbortController()
    const signal = AbortSignal.any([context.req.raw.signal, streamAbort.signal])
    const download = await getV2Workspace(context).downloadModelArtifact(artifact_id, { signal })
    const body = streamAsyncIterableV2(download.bytes, (reason) => {
      streamAbort.abort(
        reason ?? new DOMException('Model Artifact response was cancelled', 'AbortError'),
      )
    })
    return context.body(body, 200, {
      'Content-Type': 'application/zstd',
      'Content-Disposition': contentDispositionAttachmentV2(
        `${download.artifact.display_name}.tar.zst`,
      ),
      'Content-Length': String(download.artifact.archive_size_bytes),
    })
  })

  app.get(getArtifactRoute.getRoutingPath(), async (context) => {
    const { artifact_id } = ModelArtifactParamsV2Schema.parse(context.req.param())
    const artifact = await getV2Workspace(context).getModelArtifact(artifact_id, {
      signal: context.req.raw.signal,
    })
    if (artifact === null) throw new NotFoundError('Model Artifact was not found', { artifact_id })
    return context.json(artifact, 200)
  })
}

function actionTarget(value: string | undefined, suffix: string): string {
  if (value === undefined || !value.endsWith(suffix)) return ''
  return value.slice(0, -suffix.length)
}
