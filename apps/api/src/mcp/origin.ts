import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ApiEnv } from '../context.js'
import type { McpEnabledConfig } from './config.js'

export function createMcpOriginMiddleware(config: McpEnabledConfig): MiddlewareHandler<ApiEnv> {
  const allowed = new Set([new URL(config.publicBaseUrl).origin, ...config.allowedOrigins])
  return async (context, next) => {
    const origin = context.req.header('origin')
    if (origin !== undefined && origin !== '' && !allowed.has(origin)) {
      throw new HTTPException(403, { message: 'MCP Origin is not allowed' })
    }
    if (origin !== undefined && origin !== '') {
      context.header('access-control-allow-origin', origin)
      context.header(
        'access-control-expose-headers',
        'Content-Disposition, Content-Length, Content-Type, Retry-After, X-Request-ID',
      )
      context.header('vary', 'Origin')
      if (context.req.method === 'OPTIONS') {
        context.header('access-control-allow-methods', 'GET,POST,PUT,OPTIONS')
        context.header(
          'access-control-allow-headers',
          context.req.header('access-control-request-headers') ?? '*',
        )
        if (context.req.header('access-control-request-private-network') === 'true') {
          context.header('access-control-allow-private-network', 'true')
        }
      }
    }
    await next()
  }
}
