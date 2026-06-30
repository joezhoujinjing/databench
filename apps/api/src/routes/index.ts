import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import type { ApiEnv } from '../context.js'
import { DEFAULT_ERROR_RESPONSES, jsonResponse } from '../openapi.js'
import { registerDatasetRoutes } from './datasets.js'
import { registerLineageRoutes } from './lineage.js'
import { registerRecipeRoutes } from './recipes.js'
import { registerRefRoutes } from './refs.js'
import { registerTransformRoutes } from './transforms.js'
import { registerVocabularyRoutes } from './vocabularies.js'

export const V1_PREFIX = '/v1'

const V1RootSchema = z.object({
  status: z.literal('not-implemented'),
  prefix: z.literal(V1_PREFIX),
})

const v1RootRoute = createRoute({
  method: 'get',
  path: V1_PREFIX,
  responses: {
    200: jsonResponse(V1RootSchema, 'Versioned API root placeholder'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

export function registerV1Routes(app: OpenAPIHono<ApiEnv>): void {
  app.openapi(v1RootRoute, (context) =>
    context.json(
      {
        status: 'not-implemented',
        prefix: V1_PREFIX,
      },
      200,
    ),
  )
  registerDatasetRoutes(app)
  registerTransformRoutes(app)
  registerRecipeRoutes(app)
  registerRefRoutes(app)
  registerLineageRoutes(app)
  registerVocabularyRoutes(app)
}
