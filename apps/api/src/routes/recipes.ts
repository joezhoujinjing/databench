import {
  DatasetResponseSchema,
  MaterializeOpenApiRequestSchema,
  MaterializeRequestSchema,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../context.js'
import { getWorkspace } from '../context.js'
import { DEFAULT_ERROR_RESPONSES, jsonResponse } from '../openapi.js'

const materializeRecipeRoute = createRoute({
  method: 'post',
  path: '/v1/recipes:materialize',
  request: {
    body: {
      content: {
        'application/json': {
          schema: MaterializeOpenApiRequestSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse(DatasetResponseSchema, 'Dataset manifest'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

export function registerRecipeRoutes(app: OpenAPIHono<ApiEnv>): void {
  app.openapi(materializeRecipeRoute, async (context) => {
    // The route schema is a surrogate (RecipeSchema embeds the unrenderable
    // JSON-number lexeme), so validate the full body with the real schema here.
    const body = MaterializeRequestSchema.parse(await context.req.json())
    const output = await getWorkspace(context).materialize(body.recipe, { ref: body.ref })

    return context.json(output.manifest, 200)
  })
}
