import type { OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { registerV2DatasetRoutes } from './datasets.js'
import { registerV2EvaluationRunRoutes } from './evaluations.js'
import { registerV2RefRoutes } from './refs.js'
import { registerV2RegistryRoutes } from './registries.js'
import { registerV2TransformJobRoutes } from './transform-jobs.js'

export interface RegisterV2RoutesOptions {
  readonly workerJobsAvailable: boolean
}

export function registerV2Routes(app: OpenAPIHono<ApiEnv>, options: RegisterV2RoutesOptions): void {
  registerV2DatasetRoutes(app)
  registerV2EvaluationRunRoutes(app)
  registerV2RegistryRoutes(app)
  registerV2RefRoutes(app)
  registerV2TransformJobRoutes(app, options)
}
