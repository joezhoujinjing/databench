import { LineageNodeSchema } from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../context.js'
import { getWorkspace } from '../context.js'
import { DEFAULT_ERROR_RESPONSES, jsonResponse } from '../openapi.js'

const lineageRoute = createRoute({
  method: 'get',
  path: '/v1/lineage/{ref}',
  responses: {
    200: jsonResponse(LineageNodeSchema, 'Lineage DAG'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

export function registerLineageRoutes(app: OpenAPIHono<ApiEnv>): void {
  app.openapi(lineageRoute, async (context) => {
    const lineage = await getWorkspace(context).lineage(context.req.param('ref'))

    return context.json(lineage, 200)
  })
}
