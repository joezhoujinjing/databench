import {
  API_VERSION,
  CapabilitiesSchema,
  type HealthInfo,
  HealthInfoSchema,
  V2_RECORD_SCHEMA_VERSIONS,
  type VersionInfo,
  VersionInfoSchema,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { CreateAppOptions } from '../app.js'
import { getCapabilities } from '../capabilities.js'
import type { ApiEnv } from '../context.js'
import { DEFAULT_ERROR_RESPONSES, jsonResponse } from '../openapi.js'

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: {
    200: jsonResponse(HealthInfoSchema, 'Service health'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const versionRoute = createRoute({
  method: 'get',
  path: '/version',
  responses: {
    200: jsonResponse(VersionInfoSchema, 'Service version and schema compatibility'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const capabilitiesRoute = createRoute({
  method: 'get',
  path: '/capabilities',
  responses: {
    200: jsonResponse(CapabilitiesSchema, 'Runtime capabilities'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

export function registerMetaRoutes(app: OpenAPIHono<ApiEnv>, options: CreateAppOptions = {}): void {
  app.openapi(healthRoute, (context) => {
    const response: HealthInfo = {
      status: 'ok',
      workspace_root: options.workspaceRoot ?? './bench',
      version: options.version ?? '0.0.0',
    }

    return context.json(response, 200)
  })

  app.openapi(versionRoute, (context) => {
    const response: VersionInfo = {
      api_version: API_VERSION,
      service_version: options.version ?? '0.0.0',
      schema_version: V2_RECORD_SCHEMA_VERSIONS[0],
    }

    return context.json(response, 200)
  })

  app.openapi(capabilitiesRoute, (context) =>
    context.json(getCapabilities(options.v2Workspace?.postTrainingV2Capability()), 200),
  )
}
