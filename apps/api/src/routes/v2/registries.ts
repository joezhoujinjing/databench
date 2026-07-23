import {
  ConverterDescriptorV2Schema,
  ConverterParamsV2Schema,
  ConverterRegistryPageV2Schema,
  NotFoundError,
  RunTransformRequestV2Schema,
  RunTransformResultV2Schema,
  TransformParamsV2Schema,
  TransformRegistryPageV2Schema,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { getV2Workspace } from '../../context.js'
import {
  jsonResponseV2,
  V2_REGISTRY_LIST_ERROR_RESPONSES,
  V2_REGISTRY_SHOW_ERROR_RESPONSES,
  V2_TRANSFORM_RUN_ERROR_RESPONSES,
} from './openapi.js'
import { assertJsonContentTypeV2, readRawJsonRequestV2 } from './transport.js'

const listConvertersRoute = createRoute({
  method: 'get',
  path: '/v2/converters',
  operationId: 'listConvertersV2',
  tags: ['v2 converters'],
  responses: {
    200: jsonResponseV2(ConverterRegistryPageV2Schema, 'Complete V2 converter registry'),
    ...V2_REGISTRY_LIST_ERROR_RESPONSES,
  },
})

const getConverterRoute = createRoute({
  method: 'get',
  path: '/v2/converters/{name}',
  operationId: 'getConverterV2',
  tags: ['v2 converters'],
  request: { params: ConverterParamsV2Schema },
  responses: {
    200: jsonResponseV2(ConverterDescriptorV2Schema, 'V2 converter descriptor'),
    ...V2_REGISTRY_SHOW_ERROR_RESPONSES,
  },
})

const listTransformsRoute = createRoute({
  method: 'get',
  path: '/v2/transforms',
  operationId: 'listTransformsV2',
  tags: ['v2 transforms'],
  responses: {
    200: jsonResponseV2(TransformRegistryPageV2Schema, 'Complete V2 transform registry'),
    ...V2_REGISTRY_LIST_ERROR_RESPONSES,
  },
})

const runTransformRoute = createRoute({
  method: 'post',
  path: '/v2/transforms/{name}/run',
  operationId: 'runTransformV2',
  tags: ['v2 transforms'],
  request: {
    params: TransformParamsV2Schema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: RunTransformRequestV2Schema,
        },
      },
    },
  },
  responses: {
    200: jsonResponseV2(RunTransformResultV2Schema, 'Committed deterministic V2 transform output'),
    ...V2_TRANSFORM_RUN_ERROR_RESPONSES,
  },
})

export function registerV2RegistryRoutes(app: OpenAPIHono<ApiEnv>): void {
  for (const route of [
    listConvertersRoute,
    getConverterRoute,
    listTransformsRoute,
    runTransformRoute,
  ]) {
    app.openAPIRegistry.registerPath(route)
  }

  app.get(listConvertersRoute.getRoutingPath(), (context) => {
    const items = [...getV2Workspace(context).listConverters()]
    return context.json(
      ConverterRegistryPageV2Schema.parse({
        items,
        total: items.length,
      }),
      200,
    )
  })

  app.get(getConverterRoute.getRoutingPath(), (context) => {
    const { name } = ConverterParamsV2Schema.parse(context.req.param())
    const descriptor = getV2Workspace(context).getConverter(name)
    if (descriptor === null) {
      throw new NotFoundError(`V2 converter was not found: ${name}`, { converter: name })
    }
    return context.json(descriptor, 200)
  })

  app.get(listTransformsRoute.getRoutingPath(), (context) => {
    const items = [...getV2Workspace(context).listTransforms()]
    return context.json(
      TransformRegistryPageV2Schema.parse({
        items,
        total: items.length,
      }),
      200,
    )
  })

  app.post(runTransformRoute.getRoutingPath(), async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const { name } = TransformParamsV2Schema.parse(context.req.param())
    const workspace = getV2Workspace(context)
    const limits = workspace.postTrainingV2Capability().limits
    const request = await readRawJsonRequestV2(context, RunTransformRequestV2Schema, {
      maxBytes: limits.max_record_bytes,
      maxDepth: limits.max_nesting_depth,
    })
    const result = await workspace.runTransform(name, request, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 200)
  })
}
