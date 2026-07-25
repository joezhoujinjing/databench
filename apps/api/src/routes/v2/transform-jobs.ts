import {
  CreateBasicCleanJobRequestV2Schema,
  NotFoundError,
  ServiceUnavailableError,
  TransformJobPageRequestV2Schema,
  TransformJobPageV2Schema,
  TransformJobParamsV2Schema,
  TransformJobV2Schema,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { getV2Workspace } from '../../context.js'
import type { RegisterV2RoutesOptions } from './index.js'
import {
  jsonResponseV2,
  V2_TRANSFORM_JOB_ACTION_ERROR_RESPONSES,
  V2_TRANSFORM_JOB_CREATE_ERROR_RESPONSES,
  V2_TRANSFORM_JOB_LIST_ERROR_RESPONSES,
  V2_TRANSFORM_JOB_SHOW_ERROR_RESPONSES,
} from './openapi.js'
import { assertJsonContentTypeV2, readRawJsonRequestV2 } from './transport.js'

const CREATE_JOB_MAX_BYTES = 4_096

const createBasicCleanJobRoute = createRoute({
  method: 'post',
  path: '/v2/transforms/basic-clean/jobs',
  operationId: 'createBasicCleanJobV2',
  tags: ['v2 transform jobs'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: CreateBasicCleanJobRequestV2Schema },
      },
    },
  },
  responses: {
    202: jsonResponseV2(TransformJobV2Schema, 'Accepted fixed basic-clean transform job'),
    ...V2_TRANSFORM_JOB_CREATE_ERROR_RESPONSES,
  },
})

const listTransformJobsRoute = createRoute({
  method: 'get',
  path: '/v2/transform-jobs',
  operationId: 'listTransformJobsV2',
  tags: ['v2 transform jobs'],
  request: { query: TransformJobPageRequestV2Schema },
  responses: {
    200: jsonResponseV2(TransformJobPageV2Schema, 'Recent transform jobs'),
    ...V2_TRANSFORM_JOB_LIST_ERROR_RESPONSES,
  },
})

const getTransformJobRoute = createRoute({
  method: 'get',
  path: '/v2/transform-jobs/{job_id}',
  operationId: 'getTransformJobV2',
  tags: ['v2 transform jobs'],
  request: { params: TransformJobParamsV2Schema },
  responses: {
    200: jsonResponseV2(TransformJobV2Schema, 'Transform job'),
    ...V2_TRANSFORM_JOB_SHOW_ERROR_RESPONSES,
  },
})

const cancelTransformJobRoute = createRoute({
  method: 'post',
  path: '/v2/transform-jobs/{job_id}:cancel',
  operationId: 'cancelTransformJobV2',
  tags: ['v2 transform jobs'],
  request: { params: TransformJobParamsV2Schema },
  responses: {
    200: jsonResponseV2(TransformJobV2Schema, 'Cancelled or terminal transform job'),
    ...V2_TRANSFORM_JOB_ACTION_ERROR_RESPONSES,
  },
})

const retryTransformJobRoute = createRoute({
  method: 'post',
  path: '/v2/transform-jobs/{job_id}:retry',
  operationId: 'retryTransformJobV2',
  tags: ['v2 transform jobs'],
  request: { params: TransformJobParamsV2Schema },
  responses: {
    202: jsonResponseV2(TransformJobV2Schema, 'Transform job requeued for explicit retry'),
    ...V2_TRANSFORM_JOB_ACTION_ERROR_RESPONSES,
  },
})

export function registerV2TransformJobRoutes(
  app: OpenAPIHono<ApiEnv>,
  options: RegisterV2RoutesOptions,
): void {
  for (const route of [
    createBasicCleanJobRoute,
    listTransformJobsRoute,
    getTransformJobRoute,
    cancelTransformJobRoute,
    retryTransformJobRoute,
  ]) {
    app.openAPIRegistry.registerPath(route)
  }

  app.post(createBasicCleanJobRoute.getRoutingPath(), async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(context, CreateBasicCleanJobRequestV2Schema, {
      maxBytes: CREATE_JOB_MAX_BYTES,
      maxDepth: 3,
    })
    requireWorkerJobs(options)
    const result = await getV2Workspace(context).createBasicCleanJob(request, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 202)
  })

  app.get(listTransformJobsRoute.getRoutingPath(), async (context) => {
    const request = TransformJobPageRequestV2Schema.parse(context.req.query())
    const result = await getV2Workspace(context).listTransformJobs(request, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 200)
  })

  app.get(getTransformJobRoute.getRoutingPath(), async (context) => {
    const { job_id } = TransformJobParamsV2Schema.parse(context.req.param())
    const result = await getV2Workspace(context).getTransformJob(job_id, {
      signal: context.req.raw.signal,
    })
    if (result === null) throw new NotFoundError('Transform job was not found', { job_id })
    return context.json(result, 200)
  })

  app.post('/v2/transform-jobs/:target{[^/]+:cancel}', async (context) => {
    const job_id = actionTarget(context.req.param('target'), ':cancel')
    TransformJobParamsV2Schema.parse({ job_id })
    const result = await getV2Workspace(context).cancelTransformJob(job_id, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 200)
  })

  app.post('/v2/transform-jobs/:target{[^/]+:retry}', async (context) => {
    const job_id = actionTarget(context.req.param('target'), ':retry')
    TransformJobParamsV2Schema.parse({ job_id })
    requireWorkerJobs(options)
    const result = await getV2Workspace(context).retryTransformJob(job_id, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 202)
  })
}

function requireWorkerJobs(options: RegisterV2RoutesOptions): void {
  if (!options.workerJobsAvailable) {
    throw new ServiceUnavailableError('Batch transform Worker is unavailable', {
      dependency: 'worker',
    })
  }
}

function actionTarget(value: string | undefined, suffix: ':cancel' | ':retry'): string {
  if (value === undefined || !value.endsWith(suffix)) return ''
  return value.slice(0, -suffix.length)
}
