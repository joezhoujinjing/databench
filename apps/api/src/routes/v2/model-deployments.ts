import {
  CheckModelDeploymentRequestV2Schema,
  CreateModelDeploymentRequestV2Schema,
  DisableModelDeploymentRequestV2Schema,
  ModelDeploymentPageRequestV2Schema,
  ModelDeploymentPageV2Schema,
  ModelDeploymentParamsV2Schema,
  ModelDeploymentV2Schema,
  NotFoundError,
  ValidationError,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { getV2Workspace } from '../../context.js'
import { requireModelDeploymentBearer } from '../model-deployment-auth.js'
import {
  jsonResponseV2,
  V2_MODEL_DEPLOYMENT_ACTION_ERROR_RESPONSES,
  V2_MODEL_DEPLOYMENT_CREATE_ERROR_RESPONSES,
  V2_MODEL_DEPLOYMENT_LIST_ERROR_RESPONSES,
  V2_MODEL_DEPLOYMENT_SHOW_ERROR_RESPONSES,
} from './openapi.js'
import { assertJsonContentTypeV2, readRawJsonRequestV2 } from './transport.js'

const CREATE_MAX_BYTES = 16 * 1024
const ACTION_MAX_BYTES = 1024
const OPERATOR_SECURITY = [{ ModelDeploymentOperatorBearer: [] }]

export interface RegisterV2ModelDeploymentRoutesOptions {
  readonly modelDeploymentOperatorToken?: string
  readonly modelDeploymentServiceCredential?: string
}

const createDeploymentRoute = createRoute({
  method: 'post',
  path: '/v2/model-deployments',
  operationId: 'createModelDeploymentV2',
  security: OPERATOR_SECURITY,
  tags: ['v2 Model Deployments'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateModelDeploymentRequestV2Schema } },
    },
  },
  responses: {
    201: jsonResponseV2(ModelDeploymentV2Schema, 'Created or replayed Model Deployment'),
    ...V2_MODEL_DEPLOYMENT_CREATE_ERROR_RESPONSES,
  },
})

const listDeploymentsRoute = createRoute({
  method: 'get',
  path: '/v2/model-deployments',
  operationId: 'listModelDeploymentsV2',
  tags: ['v2 Model Deployments'],
  request: { query: ModelDeploymentPageRequestV2Schema },
  responses: {
    200: jsonResponseV2(ModelDeploymentPageV2Schema, 'Registered Model Deployments'),
    ...V2_MODEL_DEPLOYMENT_LIST_ERROR_RESPONSES,
  },
})

const getDeploymentRoute = createRoute({
  method: 'get',
  path: '/v2/model-deployments/{deployment_id}',
  operationId: 'getModelDeploymentV2',
  tags: ['v2 Model Deployments'],
  request: { params: ModelDeploymentParamsV2Schema },
  responses: {
    200: jsonResponseV2(ModelDeploymentV2Schema, 'Registered Model Deployment'),
    ...V2_MODEL_DEPLOYMENT_SHOW_ERROR_RESPONSES,
  },
})

function actionRoute(suffix: 'disable' | 'check') {
  const schema =
    suffix === 'disable'
      ? DisableModelDeploymentRequestV2Schema
      : CheckModelDeploymentRequestV2Schema
  return createRoute({
    method: 'post',
    path: `/v2/model-deployments/{deployment_id}:${suffix}`,
    operationId: `${suffix}ModelDeploymentV2`,
    security: OPERATOR_SECURITY,
    tags: ['v2 Model Deployments'],
    request: {
      params: ModelDeploymentParamsV2Schema,
      body: { required: true, content: { 'application/json': { schema } } },
    },
    responses: {
      200: jsonResponseV2(ModelDeploymentV2Schema, `${suffix} Model Deployment`),
      ...V2_MODEL_DEPLOYMENT_ACTION_ERROR_RESPONSES,
    },
  })
}

const disableDeploymentRoute = actionRoute('disable')
const checkDeploymentRoute = actionRoute('check')

export function registerV2ModelDeploymentRoutes(
  app: OpenAPIHono<ApiEnv>,
  options: RegisterV2ModelDeploymentRoutesOptions,
): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'ModelDeploymentOperatorBearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'opaque operator token',
  })
  for (const route of [
    createDeploymentRoute,
    listDeploymentsRoute,
    getDeploymentRoute,
    disableDeploymentRoute,
    checkDeploymentRoute,
  ]) {
    app.openAPIRegistry.registerPath(route)
  }

  app.post(createDeploymentRoute.getRoutingPath(), async (context) => {
    assertNoQuery(context.req.url)
    requireModelDeploymentBearer(context, options.modelDeploymentOperatorToken, 'operator')
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(context, CreateModelDeploymentRequestV2Schema, {
      maxBytes: CREATE_MAX_BYTES,
      maxDepth: 4,
    })
    const deployment = await getV2Workspace(context).createModelDeployment(request, {
      signal: context.req.raw.signal,
    })
    return context.json(deployment, 201)
  })

  app.get(listDeploymentsRoute.getRoutingPath(), async (context) => {
    const request = ModelDeploymentPageRequestV2Schema.parse(context.req.query())
    const page = await getV2Workspace(context).listModelDeployments(request, {
      signal: context.req.raw.signal,
    })
    return context.json(page, 200)
  })

  app.get(getDeploymentRoute.getRoutingPath(), async (context) => {
    const { deployment_id } = ModelDeploymentParamsV2Schema.parse(context.req.param())
    const deployment = await getV2Workspace(context).getModelDeployment(deployment_id, {
      signal: context.req.raw.signal,
    })
    if (deployment === null) {
      throw new NotFoundError('Model Deployment was not found', { deployment_id })
    }
    return context.json(deployment, 200)
  })

  app.post('/v2/model-deployments/:target{[^/]+:disable}', async (context) => {
    assertNoQuery(context.req.url)
    requireModelDeploymentBearer(context, options.modelDeploymentOperatorToken, 'operator')
    const deploymentId = actionTarget(context.req.param('target'), ':disable')
    ModelDeploymentParamsV2Schema.parse({ deployment_id: deploymentId })
    assertJsonContentTypeV2(context.req.raw)
    await readRawJsonRequestV2(context, DisableModelDeploymentRequestV2Schema, {
      maxBytes: ACTION_MAX_BYTES,
      maxDepth: 2,
    })
    const deployment = await getV2Workspace(context).disableModelDeployment(deploymentId, {
      signal: context.req.raw.signal,
    })
    return context.json(deployment, 200)
  })

  app.post('/v2/model-deployments/:target{[^/]+:check}', async (context) => {
    assertNoQuery(context.req.url)
    requireModelDeploymentBearer(context, options.modelDeploymentOperatorToken, 'operator')
    const deploymentId = actionTarget(context.req.param('target'), ':check')
    ModelDeploymentParamsV2Schema.parse({ deployment_id: deploymentId })
    assertJsonContentTypeV2(context.req.raw)
    await readRawJsonRequestV2(context, CheckModelDeploymentRequestV2Schema, {
      maxBytes: ACTION_MAX_BYTES,
      maxDepth: 2,
    })
    const deployment = await getV2Workspace(context).checkModelDeployment(deploymentId, {
      signal: context.req.raw.signal,
    })
    return context.json(deployment, 200)
  })

  app.get('/internal/v1/model-deployments/:target{[^/]+:resolve}', async (context) => {
    assertNoQuery(context.req.url)
    requireModelDeploymentBearer(context, options.modelDeploymentServiceCredential, 'service')
    const deploymentId = actionTarget(context.req.param('target'), ':resolve')
    ModelDeploymentParamsV2Schema.parse({ deployment_id: deploymentId })
    const deployment = await getV2Workspace(context).resolveModelDeployment(deploymentId, {
      signal: context.req.raw.signal,
    })
    return context.json(deployment, 200)
  })
}

function assertNoQuery(url: string): void {
  if (new URL(url).search === '') return
  throw new ValidationError('Model Deployment route does not accept query parameters', {
    issues: [
      {
        path: '/query',
        line: null,
        code: 'query_not_allowed',
        message: 'Query parameters are not allowed',
      },
    ],
  })
}

function actionTarget(value: string | undefined, suffix: `:${string}`): string {
  if (value === undefined || !value.endsWith(suffix)) return ''
  return value.slice(0, -suffix.length)
}
