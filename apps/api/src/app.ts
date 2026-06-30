import type { Workspace, WorkspaceOpenOptions } from '@databench/workspace'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from './context.js'
import { createCorsMiddleware } from './middleware/cors.js'
import { installErrorHandlers, validationErrorResponse } from './middleware/error.js'
import { createWorkspaceMiddleware } from './middleware/workspace.js'
import { openApiConfig } from './openapi.js'
import { registerV1Routes } from './routes/index.js'
import { registerMetaRoutes } from './routes/meta.js'

export interface CreateAppOptions {
  readonly version?: string
  readonly corsOrigins?: readonly string[]
  readonly databaseUrl?: string
  readonly storeConfig?: WorkspaceOpenOptions['storeConfig']
  readonly workspace?: Workspace
  readonly workspaceRoot?: string
}

export function createApp(options: CreateAppOptions = {}) {
  const app = createRoutedApp(options)
  app.doc('/openapi.json', () => openApiConfig(options))

  return app
}

function createRoutedApp(options: CreateAppOptions): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>({
    defaultHook: (result, context) => {
      if (!result.success) {
        return validationErrorResponse(context, 'request validation failed', result.error)
      }
    },
  })

  installErrorHandlers(app)
  app.use('*', createCorsMiddleware({ origins: options.corsOrigins ?? [] }))
  app.use(
    '/v1/*',
    createWorkspaceMiddleware({
      ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
      workspaceOptions: workspaceOptions(options),
    }),
  )

  registerMetaRoutes(app, options)
  registerV1Routes(app)

  return app
}

export function createOpenApiDocument(options: CreateAppOptions = {}): object {
  return createRoutedApp(options).getOpenAPIDocument(openApiConfig(options))
}

function workspaceOptions(options: CreateAppOptions): WorkspaceOpenOptions {
  return {
    root: options.workspaceRoot ?? './bench',
    ...(options.databaseUrl !== undefined ? { databaseUrl: options.databaseUrl } : {}),
    ...(options.storeConfig !== undefined ? { storeConfig: options.storeConfig } : {}),
  }
}
