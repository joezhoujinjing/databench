import { timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ApiEnv } from '../context.js'

export function requireModelDeploymentBearer(
  context: Context<ApiEnv>,
  expectedToken: string | undefined,
  role: 'operator' | 'service',
): void {
  if (expectedToken === undefined) {
    throw new HTTPException(503, {
      message: `Model Deployment ${role} route is disabled`,
    })
  }
  const authorization = context.req.header('authorization')
  const provided = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null
  if (provided === null || !sameToken(provided, expectedToken)) {
    throw new HTTPException(401, { message: 'Authentication required' })
  }
}

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}
