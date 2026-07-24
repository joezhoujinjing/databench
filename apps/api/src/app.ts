import type { V2WorkspaceOpenOptions } from '@databench/workspace'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv, ApiV2Workspace } from './context.js'
import { createCorsMiddleware } from './middleware/cors.js'
import { installErrorHandlers, validationErrorResponse } from './middleware/error.js'
import {
  createRequestIdMiddleware,
  createV2PrivateResponseMiddleware,
} from './middleware/request.js'
import {
  createV2WorkspaceMiddleware,
  type V2WorkspaceMiddlewareOptions,
} from './middleware/v2-workspace.js'
import { openApiConfig } from './openapi.js'
import { registerMetaRoutes } from './routes/meta.js'
import { registerV2Routes } from './routes/v2/index.js'

export interface CreateAppOptions {
  readonly version?: string
  readonly corsOrigins?: readonly string[]
  readonly databaseUrl?: string
  readonly openApiServerUrl?: string
  readonly storeConfig?: V2WorkspaceOpenOptions['storeConfig']
  readonly v2CursorSecret?: Uint8Array | string
  readonly v2Workspace?: ApiV2Workspace
  readonly workspaceRoot?: string
}

export function createApp(options: CreateAppOptions = {}) {
  const app = createRoutedApp(options, v2RuntimeOptions(options))
  app.doc('/openapi.json', () => openApiConfig(options))

  return app
}

function createRoutedApp(
  options: CreateAppOptions,
  v2Runtime?: V2WorkspaceMiddlewareOptions,
): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>({
    defaultHook: (result, context) => {
      if (!result.success) {
        return validationErrorResponse(context, 'request validation failed', result.error)
      }
    },
  })

  installErrorHandlers(app)
  app.use('*', createRequestIdMiddleware())
  app.use('*', createCorsMiddleware({ origins: options.corsOrigins ?? [] }))
  app.use('/v2/*', createV2PrivateResponseMiddleware())
  if (v2Runtime !== undefined) {
    app.use('/v2/*', createV2WorkspaceMiddleware(v2Runtime))
  }
  registerMetaRoutes(app, options)
  registerV2Routes(app)

  return app
}

export function createOpenApiDocument(options: CreateAppOptions = {}): object {
  return createRoutedApp(options).getOpenAPIDocument(openApiConfig(options))
}

function v2RuntimeOptions(options: CreateAppOptions): V2WorkspaceMiddlewareOptions {
  if (options.v2Workspace !== undefined) {
    return { workspace: options.v2Workspace }
  }
  if (options.v2CursorSecret === undefined) {
    throw new TypeError('createApp requires v2CursorSecret when a V2 Workspace is not injected')
  }
  return {
    workspaceOptions: {
      root: options.workspaceRoot ?? './bench',
      cursorSecret: options.v2CursorSecret,
      ...(options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl }),
      ...(options.storeConfig === undefined ? {} : { storeConfig: options.storeConfig }),
    },
  }
}
