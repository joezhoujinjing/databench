import {
  ActivateModelVersionDeploymentRequestV2Schema,
  CheckModelVersionDeploymentRequestV2Schema,
  CreateModelVersionDeploymentRequestV2Schema,
  DisableModelVersionDeploymentRequestV2Schema,
  ModelEvaluationDeploymentSelectorRequestV2Schema,
  ModelEvaluationDeploymentSelectorV2Schema,
  ModelVersionDeploymentPageRequestV2Schema,
  ModelVersionDeploymentPageV2Schema,
  ModelVersionDeploymentParamsV2Schema,
  ModelVersionDeploymentV2Schema,
  ModelVersionParamsV2Schema,
  ResolvedModelVersionDeploymentV2Schema,
  ValidationError,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { getV2Workspace } from '../../context.js'
import { requireModelDeploymentBearer } from '../model-deployment-auth.js'
import type { RegisterV2RoutesOptions } from './index.js'
import {
  jsonResponseV2,
  V2_MODEL_DEPLOYMENT_ACTION_ERROR_RESPONSES,
  V2_MODEL_DEPLOYMENT_CREATE_ERROR_RESPONSES,
  V2_MODEL_DEPLOYMENT_LIST_ERROR_RESPONSES,
  V2_MODEL_EVALUATION_DEPLOYMENT_LIST_ERROR_RESPONSES,
} from './openapi.js'
import { assertJsonContentTypeV2, readRawJsonRequestV2 } from './transport.js'

const CREATE_MAX_BYTES = 16 * 1024
const ACTION_MAX_BYTES = 1024
const OPERATOR_SECURITY = [{ ModelDeploymentOperatorBearer: [] }]
const TAGS = ['v2 Model Version Deployments']

const createDeploymentRoute = createRoute({
  method: 'post',
  path: '/v2/model-versions/{version_id}/deployments',
  operationId: 'createModelVersionDeploymentV2',
  security: OPERATOR_SECURITY,
  tags: TAGS,
  request: {
    params: ModelVersionParamsV2Schema,
    body: {
      required: true,
      content: { 'application/json': { schema: CreateModelVersionDeploymentRequestV2Schema } },
    },
  },
  responses: {
    201: jsonResponseV2(
      ModelVersionDeploymentV2Schema,
      'Created or replayed Model Version Deployment',
    ),
    ...V2_MODEL_DEPLOYMENT_CREATE_ERROR_RESPONSES,
  },
})

const listDeploymentsRoute = createRoute({
  method: 'get',
  path: '/v2/model-versions/{version_id}/deployments',
  operationId: 'listModelVersionDeploymentsV2',
  tags: TAGS,
  request: {
    params: ModelVersionParamsV2Schema,
    query: ModelVersionDeploymentPageRequestV2Schema,
  },
  responses: {
    200: jsonResponseV2(ModelVersionDeploymentPageV2Schema, 'Model Version Deployments'),
    ...V2_MODEL_DEPLOYMENT_LIST_ERROR_RESPONSES,
  },
})

const listEvaluationCandidatesRoute = createRoute({
  method: 'get',
  path: '/v2/model-versions/{version_id}/evaluation-deployments',
  operationId: 'listModelEvaluationDeploymentCandidatesV2',
  tags: TAGS,
  request: {
    params: ModelVersionParamsV2Schema,
    query: ModelEvaluationDeploymentSelectorRequestV2Schema,
  },
  responses: {
    200: jsonResponseV2(
      ModelEvaluationDeploymentSelectorV2Schema,
      'Evaluation Deployment candidates and exclusions',
    ),
    ...V2_MODEL_EVALUATION_DEPLOYMENT_LIST_ERROR_RESPONSES,
  },
})

function actionRoute(suffix: 'activate' | 'check' | 'disable') {
  const schema =
    suffix === 'activate'
      ? ActivateModelVersionDeploymentRequestV2Schema
      : suffix === 'check'
        ? CheckModelVersionDeploymentRequestV2Schema
        : DisableModelVersionDeploymentRequestV2Schema
  return createRoute({
    method: 'post',
    path: `/v2/model-versions/{version_id}/deployments/{deployment_id}:${suffix}`,
    operationId: `${suffix}ModelVersionDeploymentV2`,
    security: OPERATOR_SECURITY,
    tags: TAGS,
    request: {
      params: ModelVersionDeploymentParamsV2Schema,
      body: { required: true, content: { 'application/json': { schema } } },
    },
    responses: {
      200: jsonResponseV2(ModelVersionDeploymentV2Schema, `${suffix} Model Deployment`),
      ...V2_MODEL_DEPLOYMENT_ACTION_ERROR_RESPONSES,
    },
  })
}

const activateDeploymentRoute = actionRoute('activate')
const checkDeploymentRoute = actionRoute('check')
const disableDeploymentRoute = actionRoute('disable')

export function registerV2ModelVersionDeploymentRoutes(
  app: OpenAPIHono<ApiEnv>,
  options: RegisterV2RoutesOptions,
): void {
  for (const route of [
    createDeploymentRoute,
    listDeploymentsRoute,
    listEvaluationCandidatesRoute,
    activateDeploymentRoute,
    checkDeploymentRoute,
    disableDeploymentRoute,
  ]) {
    app.openAPIRegistry.registerPath(route)
  }

  app.post(createDeploymentRoute.getRoutingPath(), async (context) => {
    authorizeOperatorWrite(context, options)
    const { version_id } = ModelVersionParamsV2Schema.parse(context.req.param())
    const request = await readRawJsonRequestV2(
      context,
      CreateModelVersionDeploymentRequestV2Schema,
      { maxBytes: CREATE_MAX_BYTES, maxDepth: 5 },
    )
    return context.json(
      await getV2Workspace(context).createModelVersionDeployment(
        version_id,
        request,
        operationContext(context),
      ),
      201,
    )
  })

  app.get(listDeploymentsRoute.getRoutingPath(), async (context) => {
    const { version_id } = ModelVersionParamsV2Schema.parse(context.req.param())
    const request = ModelVersionDeploymentPageRequestV2Schema.parse(context.req.query())
    return context.json(
      await getV2Workspace(context).listModelVersionDeployments(
        version_id,
        request,
        operationContext(context),
      ),
      200,
    )
  })

  app.get(listEvaluationCandidatesRoute.getRoutingPath(), async (context) => {
    const { version_id } = ModelVersionParamsV2Schema.parse(context.req.param())
    const request = ModelEvaluationDeploymentSelectorRequestV2Schema.parse(context.req.query())
    return context.json(
      await getV2Workspace(context).listModelEvaluationDeploymentCandidates(
        version_id,
        request,
        operationContext(context),
      ),
      200,
    )
  })

  for (const suffix of ['activate', 'check', 'disable'] as const) {
    app.post(
      `/v2/model-versions/:versionId/deployments/:target{[^/]+:${suffix}}`,
      async (context) => {
        authorizeOperatorWrite(context, options)
        const version_id = context.req.param('versionId')
        const deployment_id = actionTarget(context.req.param('target'), `:${suffix}`)
        ModelVersionDeploymentParamsV2Schema.parse({ version_id, deployment_id })
        const schema =
          suffix === 'activate'
            ? ActivateModelVersionDeploymentRequestV2Schema
            : suffix === 'check'
              ? CheckModelVersionDeploymentRequestV2Schema
              : DisableModelVersionDeploymentRequestV2Schema
        await readRawJsonRequestV2(context, schema, {
          maxBytes: ACTION_MAX_BYTES,
          maxDepth: 2,
        })
        const workspace = getV2Workspace(context)
        const deployment =
          suffix === 'activate'
            ? await workspace.activateModelVersionDeployment(
                version_id,
                deployment_id,
                operationContext(context),
              )
            : suffix === 'check'
              ? await workspace.checkModelVersionDeployment(
                  version_id,
                  deployment_id,
                  operationContext(context),
                )
              : await workspace.disableModelVersionDeployment(
                  version_id,
                  deployment_id,
                  operationContext(context),
                )
        return context.json(deployment, 200)
      },
    )
  }

  app.get('/internal/v2/model-deployments/:target{[^/]+:resolve}', async (context) => {
    assertNoQuery(context.req.url)
    requireModelDeploymentBearer(context, options.modelDeploymentServiceCredential, 'service')
    const deployment_id = actionTarget(context.req.param('target'), ':resolve')
    ModelVersionDeploymentParamsV2Schema.shape.deployment_id.parse(deployment_id)
    const deployment = await getV2Workspace(context).resolveModelVersionDeployment(
      deployment_id,
      operationContext(context),
    )
    return context.json(ResolvedModelVersionDeploymentV2Schema.parse(deployment), 200)
  })
}

function authorizeOperatorWrite(
  context: Parameters<typeof requireModelDeploymentBearer>[0],
  options: RegisterV2RoutesOptions,
): void {
  assertNoQuery(context.req.url)
  requireModelDeploymentBearer(context, options.modelDeploymentOperatorToken, 'operator')
  assertJsonContentTypeV2(context.req.raw)
}

function operationContext(context: Parameters<typeof requireModelDeploymentBearer>[0]) {
  return { signal: context.req.raw.signal }
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
