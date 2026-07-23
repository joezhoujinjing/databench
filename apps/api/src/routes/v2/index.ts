import type { OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { registerV2DatasetRoutes } from './datasets.js'
import { registerV2RefRoutes } from './refs.js'
import { registerV2RegistryRoutes } from './registries.js'

export function registerV2Routes(app: OpenAPIHono<ApiEnv>): void {
  registerV2DatasetRoutes(app)
  registerV2RegistryRoutes(app)
  registerV2RefRoutes(app)
}
