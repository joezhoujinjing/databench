import {
  AdoptModelDeploymentParamsV2Schema,
  AdoptModelDeploymentRequestV2Schema,
  ArchiveModelV2Schema,
  CandidateModelAliasParamsV2Schema,
  CommitModelRegistryRegistrationRequestV2Schema,
  ModelAliasPageV2Schema,
  ModelAliasV2Schema,
  ModelDeploymentAdoptionPageRequestV2Schema,
  ModelDeploymentAdoptionPageV2Schema,
  ModelDeploymentAdoptionV2Schema,
  ModelPageRequestV2Schema,
  ModelPageV2Schema,
  ModelParamsV2Schema,
  ModelRegistrationCommitResultV2Schema,
  ModelRegistryRegistrationPlanV2Schema,
  ModelRegistryRegistrationRequestV2Schema,
  ModelV2Schema,
  ModelVersionPageRequestV2Schema,
  ModelVersionPageV2Schema,
  ModelVersionParamsV2Schema,
  ModelVersionV2Schema,
  MoveCandidateModelAliasV2Schema,
  NotFoundError,
  RefreshModelSourceEvidenceRequestV2Schema,
  RestoreModelV2Schema,
  UpdateModelMetadataV2Schema,
  ValidationError,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { getV2Workspace } from '../../context.js'
import { requireModelDeploymentBearer } from '../model-deployment-auth.js'
import type { RegisterV2RoutesOptions } from './index.js'
import {
  jsonResponseV2,
  V2_MODEL_ACTION_ERROR_RESPONSES,
  V2_MODEL_LIST_ERROR_RESPONSES,
  V2_MODEL_REGISTRATION_COMMIT_ERROR_RESPONSES,
  V2_MODEL_REGISTRATION_INSPECT_ERROR_RESPONSES,
  V2_MODEL_SHOW_ERROR_RESPONSES,
} from './openapi.js'
import { assertJsonContentTypeV2, readRawJsonRequestV2 } from './transport.js'

const REGISTRATION_MAX_BYTES = 128 * 1024
const ACTION_MAX_BYTES = 32 * 1024
const OPERATOR_SECURITY = [{ ModelDeploymentOperatorBearer: [] }]
const MODEL_TAG = ['v2 Models']

const inspectRegistrationRoute = createRoute({
  method: 'post',
  path: '/v2/model-registrations:inspect',
  operationId: 'inspectModelRegistrationV2',
  security: OPERATOR_SECURITY,
  tags: MODEL_TAG,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: ModelRegistryRegistrationRequestV2Schema } },
    },
  },
  responses: {
    200: jsonResponseV2(ModelRegistryRegistrationPlanV2Schema, 'Inspected Model registration'),
    ...V2_MODEL_REGISTRATION_INSPECT_ERROR_RESPONSES,
  },
})

const registerModelRoute = createRoute({
  method: 'post',
  path: '/v2/models:register',
  operationId: 'registerModelV2',
  security: OPERATOR_SECURITY,
  tags: MODEL_TAG,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CommitModelRegistryRegistrationRequestV2Schema } },
    },
  },
  responses: {
    201: jsonResponseV2(ModelRegistrationCommitResultV2Schema, 'Committed Model'),
    ...V2_MODEL_REGISTRATION_COMMIT_ERROR_RESPONSES,
  },
})

const listModelsRoute = createRoute({
  method: 'get',
  path: '/v2/models',
  operationId: 'listModelsV2',
  tags: MODEL_TAG,
  request: { query: ModelPageRequestV2Schema },
  responses: {
    200: jsonResponseV2(ModelPageV2Schema, 'Logical Model registry'),
    ...V2_MODEL_LIST_ERROR_RESPONSES,
  },
})

const getModelRoute = createRoute({
  method: 'get',
  path: '/v2/models/{model_id}',
  operationId: 'getModelV2',
  tags: MODEL_TAG,
  request: { params: ModelParamsV2Schema },
  responses: {
    200: jsonResponseV2(ModelV2Schema, 'Logical Model'),
    ...V2_MODEL_SHOW_ERROR_RESPONSES,
  },
})

function modelActionRoute(suffix: 'update' | 'archive' | 'restore') {
  const schema =
    suffix === 'update'
      ? UpdateModelMetadataV2Schema
      : suffix === 'archive'
        ? ArchiveModelV2Schema
        : RestoreModelV2Schema
  return createRoute({
    method: 'post',
    path: `/v2/models/{model_id}:${suffix}`,
    operationId: `${suffix}ModelV2`,
    security: OPERATOR_SECURITY,
    tags: MODEL_TAG,
    request: {
      params: ModelParamsV2Schema,
      body: { required: true, content: { 'application/json': { schema } } },
    },
    responses: {
      200: jsonResponseV2(ModelV2Schema, `${suffix} Model`),
      ...V2_MODEL_ACTION_ERROR_RESPONSES,
    },
  })
}

const updateModelRoute = modelActionRoute('update')
const archiveModelRoute = modelActionRoute('archive')
const restoreModelRoute = modelActionRoute('restore')

const registerVersionRoute = createRoute({
  method: 'post',
  path: '/v2/models/{model_id}/versions:register',
  operationId: 'registerModelVersionV2',
  security: OPERATOR_SECURITY,
  tags: MODEL_TAG,
  request: {
    params: ModelParamsV2Schema,
    body: {
      required: true,
      content: { 'application/json': { schema: CommitModelRegistryRegistrationRequestV2Schema } },
    },
  },
  responses: {
    201: jsonResponseV2(ModelRegistrationCommitResultV2Schema, 'Committed Model Version'),
    ...V2_MODEL_REGISTRATION_COMMIT_ERROR_RESPONSES,
  },
})

const listVersionsRoute = createRoute({
  method: 'get',
  path: '/v2/models/{model_id}/versions',
  operationId: 'listModelVersionsV2',
  tags: MODEL_TAG,
  request: { params: ModelParamsV2Schema, query: ModelVersionPageRequestV2Schema },
  responses: {
    200: jsonResponseV2(ModelVersionPageV2Schema, 'Model Versions'),
    ...V2_MODEL_SHOW_ERROR_RESPONSES,
  },
})

const getVersionRoute = createRoute({
  method: 'get',
  path: '/v2/model-versions/{version_id}',
  operationId: 'getModelVersionV2',
  tags: MODEL_TAG,
  request: { params: ModelVersionParamsV2Schema },
  responses: {
    200: jsonResponseV2(ModelVersionV2Schema, 'Model Version'),
    ...V2_MODEL_SHOW_ERROR_RESPONSES,
  },
})

const refreshSourceEvidenceRoute = createRoute({
  method: 'post',
  path: '/v2/model-versions/{version_id}:refresh-source-evidence',
  operationId: 'refreshModelSourceEvidenceV2',
  security: OPERATOR_SECURITY,
  tags: MODEL_TAG,
  request: {
    params: ModelVersionParamsV2Schema,
    body: {
      required: true,
      content: { 'application/json': { schema: RefreshModelSourceEvidenceRequestV2Schema } },
    },
  },
  responses: {
    200: jsonResponseV2(ModelVersionV2Schema, 'Refreshed Repository source evidence'),
    ...V2_MODEL_ACTION_ERROR_RESPONSES,
  },
})

const listAliasesRoute = createRoute({
  method: 'get',
  path: '/v2/models/{model_id}/aliases',
  operationId: 'listModelAliasesV2',
  tags: MODEL_TAG,
  request: { params: ModelParamsV2Schema },
  responses: {
    200: jsonResponseV2(ModelAliasPageV2Schema, 'Model Aliases'),
    ...V2_MODEL_SHOW_ERROR_RESPONSES,
  },
})

const moveCandidateRoute = createRoute({
  method: 'post',
  path: '/v2/models/{model_id}/aliases/{alias}:move',
  operationId: 'moveCandidateModelAliasV2',
  security: OPERATOR_SECURITY,
  tags: MODEL_TAG,
  request: {
    params: CandidateModelAliasParamsV2Schema,
    body: {
      required: true,
      content: { 'application/json': { schema: MoveCandidateModelAliasV2Schema } },
    },
  },
  responses: {
    200: jsonResponseV2(ModelAliasV2Schema, 'Moved candidate Model Alias'),
    ...V2_MODEL_ACTION_ERROR_RESPONSES,
  },
})

const adoptDeploymentRoute = createRoute({
  method: 'post',
  path: '/v2/model-versions/{version_id}/deployments/{deployment_id}:adopt',
  operationId: 'adoptModelDeploymentV2',
  security: OPERATOR_SECURITY,
  tags: MODEL_TAG,
  request: {
    params: AdoptModelDeploymentParamsV2Schema,
    body: {
      required: true,
      content: { 'application/json': { schema: AdoptModelDeploymentRequestV2Schema } },
    },
  },
  responses: {
    200: jsonResponseV2(ModelDeploymentAdoptionV2Schema, 'Adopted legacy Model Deployment'),
    ...V2_MODEL_ACTION_ERROR_RESPONSES,
  },
})

const listDeploymentAdoptionsRoute = createRoute({
  method: 'get',
  path: '/v2/model-versions/{version_id}/deployment-adoptions',
  operationId: 'listModelDeploymentAdoptionsV2',
  tags: MODEL_TAG,
  request: {
    params: ModelVersionParamsV2Schema,
    query: ModelDeploymentAdoptionPageRequestV2Schema,
  },
  responses: {
    200: jsonResponseV2(ModelDeploymentAdoptionPageV2Schema, 'Historical Deployment adoptions'),
    ...V2_MODEL_SHOW_ERROR_RESPONSES,
  },
})

export function registerV2ModelRoutes(
  app: OpenAPIHono<ApiEnv>,
  options: RegisterV2RoutesOptions,
): void {
  for (const route of [
    inspectRegistrationRoute,
    registerModelRoute,
    listModelsRoute,
    getModelRoute,
    updateModelRoute,
    archiveModelRoute,
    restoreModelRoute,
    registerVersionRoute,
    listVersionsRoute,
    getVersionRoute,
    refreshSourceEvidenceRoute,
    listAliasesRoute,
    moveCandidateRoute,
    adoptDeploymentRoute,
    listDeploymentAdoptionsRoute,
  ]) {
    app.openAPIRegistry.registerPath(route)
  }

  app.post(inspectRegistrationRoute.getRoutingPath(), async (context) => {
    authorizeWrite(context, options)
    const request = await readRawJsonRequestV2(context, ModelRegistryRegistrationRequestV2Schema, {
      maxBytes: REGISTRATION_MAX_BYTES,
      maxDepth: 8,
    })
    return context.json(
      await getV2Workspace(context).inspectModelRegistration(request, operationContext(context)),
      200,
    )
  })

  app.post(registerModelRoute.getRoutingPath(), async (context) => {
    authorizeWrite(context, options)
    const request = await readRawJsonRequestV2(
      context,
      CommitModelRegistryRegistrationRequestV2Schema,
      { maxBytes: REGISTRATION_MAX_BYTES, maxDepth: 9 },
    )
    assertRegistrationTarget(request.request.target, 'create_model')
    return context.json(
      await getV2Workspace(context).commitModelRegistration(request, operationContext(context)),
      201,
    )
  })

  app.get(listModelsRoute.getRoutingPath(), async (context) => {
    const request = ModelPageRequestV2Schema.parse(context.req.query())
    return context.json(
      await getV2Workspace(context).listModels(request, operationContext(context)),
      200,
    )
  })

  app.get(getModelRoute.getRoutingPath(), async (context) => {
    const { model_id } = ModelParamsV2Schema.parse(context.req.param())
    const model = await getV2Workspace(context).getModel(model_id, operationContext(context))
    if (model === null) throw new NotFoundError('Model was not found', { model_id })
    return context.json(model, 200)
  })

  app.post('/v2/models/:target{[^/]+:update}', async (context) => {
    authorizeWrite(context, options)
    const model_id = actionTarget(context.req.param('target'), ':update')
    ModelParamsV2Schema.parse({ model_id })
    const request = await readRawJsonRequestV2(context, UpdateModelMetadataV2Schema, {
      maxBytes: ACTION_MAX_BYTES,
      maxDepth: 5,
    })
    return context.json(
      await getV2Workspace(context).updateModel(model_id, request, operationContext(context)),
      200,
    )
  })

  app.post('/v2/models/:target{[^/]+:archive}', async (context) => {
    authorizeWrite(context, options)
    const model_id = actionTarget(context.req.param('target'), ':archive')
    ModelParamsV2Schema.parse({ model_id })
    const request = await readRawJsonRequestV2(context, ArchiveModelV2Schema, {
      maxBytes: ACTION_MAX_BYTES,
      maxDepth: 3,
    })
    return context.json(
      await getV2Workspace(context).archiveModel(model_id, request, operationContext(context)),
      200,
    )
  })

  app.post('/v2/models/:target{[^/]+:restore}', async (context) => {
    authorizeWrite(context, options)
    const model_id = actionTarget(context.req.param('target'), ':restore')
    ModelParamsV2Schema.parse({ model_id })
    const request = await readRawJsonRequestV2(context, RestoreModelV2Schema, {
      maxBytes: ACTION_MAX_BYTES,
      maxDepth: 3,
    })
    return context.json(
      await getV2Workspace(context).restoreModel(model_id, request, operationContext(context)),
      200,
    )
  })

  app.post(registerVersionRoute.getRoutingPath(), async (context) => {
    authorizeWrite(context, options)
    const { model_id } = ModelParamsV2Schema.parse(context.req.param())
    const request = await readRawJsonRequestV2(
      context,
      CommitModelRegistryRegistrationRequestV2Schema,
      { maxBytes: REGISTRATION_MAX_BYTES, maxDepth: 9 },
    )
    assertRegistrationTarget(request.request.target, 'existing_model', model_id)
    return context.json(
      await getV2Workspace(context).commitModelRegistration(request, operationContext(context)),
      201,
    )
  })

  app.get(listVersionsRoute.getRoutingPath(), async (context) => {
    const { model_id } = ModelParamsV2Schema.parse(context.req.param())
    const request = ModelVersionPageRequestV2Schema.parse(context.req.query())
    return context.json(
      await getV2Workspace(context).listModelVersions(model_id, request, operationContext(context)),
      200,
    )
  })

  app.get(getVersionRoute.getRoutingPath(), async (context) => {
    const { version_id } = ModelVersionParamsV2Schema.parse(context.req.param())
    const version = await getV2Workspace(context).getModelVersion(
      version_id,
      operationContext(context),
    )
    if (version === null) throw new NotFoundError('Model Version was not found', { version_id })
    return context.json(version, 200)
  })

  app.post('/v2/model-versions/:target{[^/]+:refresh-source-evidence}', async (context) => {
    authorizeWrite(context, options)
    const version_id = actionTarget(context.req.param('target'), ':refresh-source-evidence')
    ModelVersionParamsV2Schema.parse({ version_id })
    await readRawJsonRequestV2(context, RefreshModelSourceEvidenceRequestV2Schema, {
      maxBytes: ACTION_MAX_BYTES,
      maxDepth: 2,
    })
    return context.json(
      await getV2Workspace(context).refreshModelSourceEvidence(
        version_id,
        operationContext(context),
      ),
      200,
    )
  })

  app.get(listAliasesRoute.getRoutingPath(), async (context) => {
    const { model_id } = ModelParamsV2Schema.parse(context.req.param())
    return context.json(
      await getV2Workspace(context).listModelAliases(model_id, operationContext(context)),
      200,
    )
  })

  app.post('/v2/models/:modelId/aliases/:target{[^/]+:move}', async (context) => {
    authorizeWrite(context, options)
    const model_id = context.req.param('modelId')
    const alias = actionTarget(context.req.param('target'), ':move')
    CandidateModelAliasParamsV2Schema.parse({ model_id, alias })
    const request = await readRawJsonRequestV2(context, MoveCandidateModelAliasV2Schema, {
      maxBytes: ACTION_MAX_BYTES,
      maxDepth: 3,
    })
    return context.json(
      await getV2Workspace(context).moveCandidateModelAlias(
        model_id,
        request,
        operationContext(context),
      ),
      200,
    )
  })

  app.post('/v2/model-versions/:versionId/deployments/:target{[^/]+:adopt}', async (context) => {
    authorizeWrite(context, options)
    const version_id = context.req.param('versionId')
    const deployment_id = actionTarget(context.req.param('target'), ':adopt')
    AdoptModelDeploymentParamsV2Schema.parse({ version_id, deployment_id })
    const request = await readRawJsonRequestV2(context, AdoptModelDeploymentRequestV2Schema, {
      maxBytes: ACTION_MAX_BYTES,
      maxDepth: 3,
    })
    return context.json(
      await getV2Workspace(context).adoptModelDeployment(
        version_id,
        deployment_id,
        request,
        operationContext(context),
      ),
      200,
    )
  })

  app.get(listDeploymentAdoptionsRoute.getRoutingPath(), async (context) => {
    const { version_id } = ModelVersionParamsV2Schema.parse(context.req.param())
    const request = ModelDeploymentAdoptionPageRequestV2Schema.parse(context.req.query())
    return context.json(
      await getV2Workspace(context).listModelDeploymentAdoptions(
        version_id,
        request,
        operationContext(context),
      ),
      200,
    )
  })
}

function authorizeWrite(
  context: Parameters<typeof requireModelDeploymentBearer>[0],
  options: RegisterV2RoutesOptions,
): void {
  assertNoQuery(context.req.url)
  requireModelDeploymentBearer(context, options.modelDeploymentOperatorToken, 'operator')
  assertJsonContentTypeV2(context.req.raw)
}

function assertRegistrationTarget(
  target:
    | { readonly kind: 'create_model' }
    | { readonly kind: 'existing_model'; readonly model_id: string },
  expectedKind: 'create_model' | 'existing_model',
  expectedModelId?: string,
): void {
  if (
    target.kind === expectedKind &&
    (expectedModelId === undefined ||
      (target.kind === 'existing_model' && target.model_id === expectedModelId))
  ) {
    return
  }
  throw new ValidationError('Model registration target does not match the route', {
    issues: [
      {
        path: '/request/target',
        line: null,
        code: 'model_registration_target_mismatch',
        message: 'Use models:register for a new Model and versions:register for this exact Model',
      },
    ],
  })
}

function operationContext(context: Parameters<typeof requireModelDeploymentBearer>[0]) {
  return { signal: context.req.raw.signal }
}

function assertNoQuery(url: string): void {
  if (new URL(url).search === '') return
  throw new ValidationError('Model action route does not accept query parameters', {
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
