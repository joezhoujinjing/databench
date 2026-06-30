import type { MiddlewareHandler } from 'hono'
import type { ApiEnv } from '../context.js'

const LOCAL_DEV_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1):5173$/
const ALLOW_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS'

export interface CorsOptions {
  readonly origins?: readonly string[]
}

export function createCorsMiddleware(options: CorsOptions = {}): MiddlewareHandler<ApiEnv> {
  const configuredOrigins = new Set(options.origins ?? [])

  return async (context, next) => {
    const origin = context.req.header('origin')
    const allowed = origin !== undefined && isAllowedOrigin(origin, configuredOrigins)

    if (allowed) {
      context.header('access-control-allow-origin', origin)
      context.header('vary', 'Origin')
    }

    if (context.req.method === 'OPTIONS') {
      if (allowed) {
        context.header('access-control-allow-methods', ALLOW_METHODS)
        context.header(
          'access-control-allow-headers',
          context.req.header('access-control-request-headers') ?? '*',
        )

        if (context.req.header('access-control-request-private-network') === 'true') {
          context.header('access-control-allow-private-network', 'true')
        }
      }

      return context.body(null, 204)
    }

    await next()
  }
}

export function isAllowedOrigin(origin: string, configuredOrigins: ReadonlySet<string>): boolean {
  return LOCAL_DEV_ORIGIN.test(origin) || configuredOrigins.has(origin)
}
