import {
  DatasetResponseSchema,
  PaginationQuerySchema,
  TransformRunRequestSchema,
  TransformsPageSchema,
} from '@databench/schema'
import { getTransform, listTransforms } from '@databench/workspace'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { ApiEnv } from '../context.js'
import { getWorkspace } from '../context.js'
import { DEFAULT_ERROR_RESPONSES, jsonResponse } from '../openapi.js'

const listTransformsRoute = createRoute({
  method: 'get',
  path: '/v1/transforms',
  request: {
    query: PaginationQuerySchema,
  },
  responses: {
    200: jsonResponse(TransformsPageSchema, 'Paginated transforms'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const runTransformRoute = createRoute({
  method: 'post',
  path: '/v1/transforms/{name}/run',
  request: {
    body: {
      content: {
        'application/json': {
          schema: TransformRunRequestSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse(DatasetResponseSchema, 'Dataset manifest'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

export function registerTransformRoutes(app: OpenAPIHono<ApiEnv>): void {
  app.openapi(listTransformsRoute, (context) => {
    const { limit, offset } = context.req.valid('query')
    const transforms = listTransforms().sort((left, right) => left.name.localeCompare(right.name))
    const items = transforms.slice(offset, offset + limit).map((transform) => ({
      name: transform.name,
      version: transform.version,
      params_schema:
        transform.paramsSchema === null
          ? null
          : (z.toJSONSchema(transform.paramsSchema) as Record<string, unknown>),
    }))

    return context.json(
      {
        total: transforms.length,
        limit,
        offset,
        items,
      },
      200,
    )
  })

  app.openapi(runTransformRoute, async (context) => {
    const transformName = context.req.param('name')
    const transform = getTransform(transformName)

    if (transform === null) {
      throw new HTTPException(404, { message: `unknown transform: ${transformName}` })
    }

    const body = context.req.valid('json')
    const output = await getWorkspace(context).run(transform, body.inputs, {
      params: body.params,
      ref: body.ref,
    })

    return context.json(output.manifest, 200)
  })
}
