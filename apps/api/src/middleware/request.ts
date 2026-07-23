import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { ApiEnv } from '../context.js'

export function createRequestIdMiddleware(): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    const requestId = randomUUID()
    context.set('requestId', requestId)
    context.header('X-Request-ID', requestId)
    await next()
  }
}

export function createV2PrivateResponseMiddleware(): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    context.header('Cache-Control', 'private, no-store')
    context.header('X-Content-Type-Options', 'nosniff')
    await next()
  }
}
