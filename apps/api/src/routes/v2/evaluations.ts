import {
  CancelEvaluationRunRequestV2Schema,
  CompleteEvaluationRunRequestV2Schema,
  CreateEvaluationRunRequestV2Schema,
  EvaluationRunPageRequestV2Schema,
  EvaluationRunPageV2Schema,
  EvaluationRunParamsV2Schema,
  EvaluationRunV2Schema,
  FailEvaluationResultUploadRequestV2Schema,
  FailEvaluationRunRequestV2Schema,
  FinalizeEvaluationResultUploadRequestV2Schema,
  NotFoundError,
  PrepareEvaluationResultUploadRequestV2Schema,
  PrepareEvaluationResultUploadResponseV2Schema,
  StartEvaluationRunRequestV2Schema,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { getV2Workspace } from '../../context.js'
import {
  jsonResponseV2,
  V2_EVALUATION_RUN_ACTION_ERROR_RESPONSES,
  V2_EVALUATION_RUN_CREATE_ERROR_RESPONSES,
  V2_EVALUATION_RUN_LIST_ERROR_RESPONSES,
  V2_EVALUATION_RUN_SHOW_ERROR_RESPONSES,
} from './openapi.js'
import { assertJsonContentTypeV2, readRawJsonRequestV2 } from './transport.js'

const CREATE_RUN_MAX_BYTES = 128 * 1024
const COMPLETE_RUN_MAX_BYTES = 8 * 1024 * 1024
const TERMINAL_RUN_MAX_BYTES = 4 * 1024

const createEvaluationRunRoute = createRoute({
  method: 'post',
  path: '/v2/evaluation-runs',
  operationId: 'createEvaluationRunV2',
  tags: ['v2 evaluation runs'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateEvaluationRunRequestV2Schema } },
    },
  },
  responses: {
    201: jsonResponseV2(EvaluationRunV2Schema, 'Created or replayed evaluation run'),
    ...V2_EVALUATION_RUN_CREATE_ERROR_RESPONSES,
  },
})

const listEvaluationRunsRoute = createRoute({
  method: 'get',
  path: '/v2/evaluation-runs',
  operationId: 'listEvaluationRunsV2',
  tags: ['v2 evaluation runs'],
  request: { query: EvaluationRunPageRequestV2Schema },
  responses: {
    200: jsonResponseV2(EvaluationRunPageV2Schema, 'Recent evaluation runs'),
    ...V2_EVALUATION_RUN_LIST_ERROR_RESPONSES,
  },
})

const getEvaluationRunRoute = createRoute({
  method: 'get',
  path: '/v2/evaluation-runs/{run_id}',
  operationId: 'getEvaluationRunV2',
  tags: ['v2 evaluation runs'],
  request: { params: EvaluationRunParamsV2Schema },
  responses: {
    200: jsonResponseV2(EvaluationRunV2Schema, 'Evaluation run'),
    ...V2_EVALUATION_RUN_SHOW_ERROR_RESPONSES,
  },
})

function actionRoute(
  suffix: 'start' | 'complete' | 'fail' | 'cancel',
  schema:
    | typeof StartEvaluationRunRequestV2Schema
    | typeof CompleteEvaluationRunRequestV2Schema
    | typeof FailEvaluationRunRequestV2Schema
    | typeof CancelEvaluationRunRequestV2Schema,
) {
  return createRoute({
    method: 'post',
    path: `/v2/evaluation-runs/{run_id}:${suffix}`,
    operationId: `${suffix}EvaluationRunV2`,
    tags: ['v2 evaluation runs'],
    request: {
      params: EvaluationRunParamsV2Schema,
      body: { required: true, content: { 'application/json': { schema } } },
    },
    responses: {
      200: jsonResponseV2(EvaluationRunV2Schema, `${suffix} evaluation run`),
      ...V2_EVALUATION_RUN_ACTION_ERROR_RESPONSES,
    },
  })
}

const startEvaluationRunRoute = actionRoute('start', StartEvaluationRunRequestV2Schema)
const completeEvaluationRunRoute = actionRoute('complete', CompleteEvaluationRunRequestV2Schema)
const failEvaluationRunRoute = actionRoute('fail', FailEvaluationRunRequestV2Schema)
const cancelEvaluationRunRoute = actionRoute('cancel', CancelEvaluationRunRequestV2Schema)

const prepareEvaluationResultUploadRoute = createRoute({
  method: 'post',
  path: '/v2/evaluation-runs/{run_id}:prepare-result-upload',
  operationId: 'prepareEvaluationResultUploadV2',
  tags: ['v2 evaluation runs'],
  request: {
    params: EvaluationRunParamsV2Schema,
    body: {
      required: true,
      content: { 'application/json': { schema: PrepareEvaluationResultUploadRequestV2Schema } },
    },
  },
  responses: {
    200: jsonResponseV2(
      PrepareEvaluationResultUploadResponseV2Schema,
      'Prepare or replay exact evaluation result upload',
    ),
    ...V2_EVALUATION_RUN_ACTION_ERROR_RESPONSES,
  },
})

const finalizeEvaluationResultUploadRoute = createRoute({
  method: 'post',
  path: '/v2/evaluation-runs/{run_id}:finalize-result-upload',
  operationId: 'finalizeEvaluationResultUploadV2',
  tags: ['v2 evaluation runs'],
  request: {
    params: EvaluationRunParamsV2Schema,
    body: {
      required: true,
      content: { 'application/json': { schema: FinalizeEvaluationResultUploadRequestV2Schema } },
    },
  },
  responses: {
    200: jsonResponseV2(EvaluationRunV2Schema, 'Finalize or replay evaluation result upload'),
    ...V2_EVALUATION_RUN_ACTION_ERROR_RESPONSES,
  },
})

const failEvaluationResultUploadRoute = createRoute({
  method: 'post',
  path: '/v2/evaluation-runs/{run_id}:fail-result-upload',
  operationId: 'failEvaluationResultUploadV2',
  tags: ['v2 evaluation runs'],
  request: {
    params: EvaluationRunParamsV2Schema,
    body: {
      required: true,
      content: { 'application/json': { schema: FailEvaluationResultUploadRequestV2Schema } },
    },
  },
  responses: {
    200: jsonResponseV2(EvaluationRunV2Schema, 'Fail or replay evaluation result upload'),
    ...V2_EVALUATION_RUN_ACTION_ERROR_RESPONSES,
  },
})

export function registerV2EvaluationRunRoutes(app: OpenAPIHono<ApiEnv>): void {
  for (const route of [
    createEvaluationRunRoute,
    listEvaluationRunsRoute,
    getEvaluationRunRoute,
    startEvaluationRunRoute,
    completeEvaluationRunRoute,
    failEvaluationRunRoute,
    cancelEvaluationRunRoute,
    prepareEvaluationResultUploadRoute,
    finalizeEvaluationResultUploadRoute,
    failEvaluationResultUploadRoute,
  ]) {
    app.openAPIRegistry.registerPath(route)
  }

  app.post(createEvaluationRunRoute.getRoutingPath(), async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(context, CreateEvaluationRunRequestV2Schema, {
      maxBytes: CREATE_RUN_MAX_BYTES,
      maxDepth: 8,
    })
    const run = await getV2Workspace(context).createEvaluationRun(request, {
      signal: context.req.raw.signal,
    })
    return context.json(run, 201)
  })

  app.get(listEvaluationRunsRoute.getRoutingPath(), async (context) => {
    const request = EvaluationRunPageRequestV2Schema.parse(context.req.query())
    const page = await getV2Workspace(context).listEvaluationRuns(request, {
      signal: context.req.raw.signal,
    })
    return context.json(page, 200)
  })

  app.get(getEvaluationRunRoute.getRoutingPath(), async (context) => {
    const { run_id } = EvaluationRunParamsV2Schema.parse(context.req.param())
    const run = await getV2Workspace(context).getEvaluationRun(run_id, {
      signal: context.req.raw.signal,
    })
    if (run === null) throw new NotFoundError('Evaluation run was not found', { run_id })
    return context.json(run, 200)
  })

  app.post('/v2/evaluation-runs/:target{[^/]+:start}', async (context) => {
    const runId = actionTarget(context.req.param('target'), ':start')
    EvaluationRunParamsV2Schema.parse({ run_id: runId })
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(context, StartEvaluationRunRequestV2Schema, {
      maxBytes: TERMINAL_RUN_MAX_BYTES,
      maxDepth: 2,
    })
    const run = await getV2Workspace(context).startEvaluationRun(runId, request, {
      signal: context.req.raw.signal,
    })
    return context.json(run, 200)
  })

  app.post('/v2/evaluation-runs/:target{[^/]+:complete}', async (context) => {
    const runId = actionTarget(context.req.param('target'), ':complete')
    EvaluationRunParamsV2Schema.parse({ run_id: runId })
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(context, CompleteEvaluationRunRequestV2Schema, {
      maxBytes: COMPLETE_RUN_MAX_BYTES,
      maxDepth: 8,
    })
    const run = await getV2Workspace(context).completeEvaluationRun(runId, request, {
      signal: context.req.raw.signal,
    })
    return context.json(run, 200)
  })

  app.post('/v2/evaluation-runs/:target{[^/]+:fail}', async (context) => {
    const runId = actionTarget(context.req.param('target'), ':fail')
    EvaluationRunParamsV2Schema.parse({ run_id: runId })
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(context, FailEvaluationRunRequestV2Schema, {
      maxBytes: TERMINAL_RUN_MAX_BYTES,
      maxDepth: 4,
    })
    const run = await getV2Workspace(context).failEvaluationRun(runId, request, {
      signal: context.req.raw.signal,
    })
    return context.json(run, 200)
  })

  app.post('/v2/evaluation-runs/:target{[^/]+:cancel}', async (context) => {
    const runId = actionTarget(context.req.param('target'), ':cancel')
    EvaluationRunParamsV2Schema.parse({ run_id: runId })
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(context, CancelEvaluationRunRequestV2Schema, {
      maxBytes: TERMINAL_RUN_MAX_BYTES,
      maxDepth: 4,
    })
    const run = await getV2Workspace(context).cancelEvaluationRun(runId, request, {
      signal: context.req.raw.signal,
    })
    return context.json(run, 200)
  })

  app.post('/v2/evaluation-runs/:target{[^/]+:prepare-result-upload}', async (context) => {
    const runId = actionTarget(context.req.param('target'), ':prepare-result-upload')
    EvaluationRunParamsV2Schema.parse({ run_id: runId })
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(
      context,
      PrepareEvaluationResultUploadRequestV2Schema,
      { maxBytes: TERMINAL_RUN_MAX_BYTES, maxDepth: 2 },
    )
    const result = await getV2Workspace(context).prepareEvaluationResultUpload(runId, request, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 200)
  })

  app.post('/v2/evaluation-runs/:target{[^/]+:finalize-result-upload}', async (context) => {
    const runId = actionTarget(context.req.param('target'), ':finalize-result-upload')
    EvaluationRunParamsV2Schema.parse({ run_id: runId })
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(
      context,
      FinalizeEvaluationResultUploadRequestV2Schema,
      { maxBytes: TERMINAL_RUN_MAX_BYTES, maxDepth: 3 },
    )
    const run = await getV2Workspace(context).finalizeEvaluationResultUpload(runId, request, {
      signal: context.req.raw.signal,
    })
    return context.json(run, 200)
  })

  app.post('/v2/evaluation-runs/:target{[^/]+:fail-result-upload}', async (context) => {
    const runId = actionTarget(context.req.param('target'), ':fail-result-upload')
    EvaluationRunParamsV2Schema.parse({ run_id: runId })
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(context, FailEvaluationResultUploadRequestV2Schema, {
      maxBytes: TERMINAL_RUN_MAX_BYTES,
      maxDepth: 4,
    })
    const run = await getV2Workspace(context).failEvaluationResultUpload(runId, request, {
      signal: context.req.raw.signal,
    })
    return context.json(run, 200)
  })
}

function actionTarget(value: string | undefined, suffix: `:${string}`): string {
  if (value === undefined || !value.endsWith(suffix)) return ''
  return value.slice(0, -suffix.length)
}
