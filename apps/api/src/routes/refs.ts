import { PaginationQuerySchema, RefInfoSchema, RefsPageSchema } from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import type { ApiEnv } from '../context.js'
import { getWorkspace } from '../context.js'
import { DEFAULT_ERROR_RESPONSES, jsonResponse } from '../openapi.js'

const listRefsRoute = createRoute({
  method: 'get',
  path: '/v1/refs',
  request: {
    query: PaginationQuerySchema,
  },
  responses: {
    200: jsonResponse(RefsPageSchema, 'Paginated refs'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const resolveRefRoute = createRoute({
  method: 'get',
  path: '/v1/refs/{name}',
  responses: {
    200: jsonResponse(RefInfoSchema, 'Resolved ref'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

export function registerRefRoutes(app: OpenAPIHono<ApiEnv>): void {
  app.openapi(listRefsRoute, async (context) => {
    const { limit, offset } = context.req.valid('query')
    const refs = Object.entries(await getWorkspace(context).listRefs()).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    const items = refs.slice(offset, offset + limit).map(([name, version]) => ({ name, version }))

    return context.json(
      {
        total: refs.length,
        limit,
        offset,
        items,
      },
      200,
    )
  })

  app.openapi(resolveRefRoute, async (context) => {
    const name = context.req.param('name')
    const version = await getWorkspace(context).getRef(name)

    if (version === null) {
      throw new HTTPException(404, { message: `unknown ref: ${name}` })
    }

    return context.json({ name, version }, 200)
  })
}
