import type { V2WorkspaceOpenOptions } from '@databench/workspace'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv, ApiV2Workspace } from './context.js'
import type { EvalScopeGatewayConfig } from './evalscope/config.js'
import { registerEvalScopeGateway } from './evalscope/gateway.js'
import type { McpRuntimeConfig } from './mcp/config.js'
import { registerMcpFileRoutes } from './mcp/file-routes.js'
import { McpFileTokenRegistry } from './mcp/file-tokens.js'
import { createMcpOriginMiddleware } from './mcp/origin.js'
import { registerMcpRoutes } from './mcp/register.js'
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
import {
  DISABLED_SWIFT_STUDIO_GATEWAY_CONFIG,
  MS_SWIFT_UPSTREAM_COMMIT,
  SWIFT_STUDIO_CAPABILITY_DIGEST,
  type SwiftStudioGatewayConfig,
} from './swift-studio/config.js'
import { registerSwiftStudioGateway } from './swift-studio/gateway.js'

export interface CreateAppOptions {
  readonly version?: string
  readonly corsOrigins?: readonly string[]
  readonly databaseUrl?: string
  readonly evalscope?: EvalScopeGatewayConfig
  readonly evalscopeFetch?: typeof fetch
  readonly mcp?: McpRuntimeConfig
  readonly modelDeploymentOperatorToken?: string
  readonly modelDeploymentServiceCredential?: string
  readonly openApiServerUrl?: string
  readonly storeConfig?: V2WorkspaceOpenOptions['storeConfig']
  readonly swiftStudio?: SwiftStudioGatewayConfig
  readonly swiftStudioFetch?: typeof fetch
  readonly v2CursorSecret?: Uint8Array | string
  readonly v2Workspace?: ApiV2Workspace
  readonly workspaceRoot?: string
  readonly workerJobsAvailable?: boolean
  readonly evaluationArchiveMaxBytes?: number
  readonly evaluationArchiveSignedUrlTtlMs?: number
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
  const mcpConfig = options.mcp ?? { enabled: false }
  const mcpRuntime =
    mcpConfig.enabled && v2Runtime !== undefined
      ? {
          config: mcpConfig,
          tokens: new McpFileTokenRegistry({
            maxEntries: mcpConfig.maxTokens,
            maxActive: mcpConfig.maxActiveFileOperations,
            ttlMs: mcpConfig.tokenTtlMs,
          }),
          version: options.version ?? '0.0.0',
        }
      : undefined
  if (mcpRuntime !== undefined) {
    const originMiddleware = createMcpOriginMiddleware(mcpRuntime.config)
    app.use('/mcp', createV2PrivateResponseMiddleware())
    app.use('/mcp-files/*', createV2PrivateResponseMiddleware())
    app.use('/mcp', originMiddleware)
    app.use('/mcp-files/*', originMiddleware)
  }
  app.use('*', createCorsMiddleware({ origins: options.corsOrigins ?? [] }))
  app.use('/v2/*', createV2PrivateResponseMiddleware())
  app.use('/internal/v1/*', createV2PrivateResponseMiddleware())
  if (v2Runtime !== undefined) {
    const workspaceMiddleware = createV2WorkspaceMiddleware(v2Runtime)
    app.use('/v2/*', workspaceMiddleware)
    app.use('/internal/v1/*', workspaceMiddleware)
    if (mcpRuntime !== undefined) {
      app.use('/mcp', async (context, next) => {
        if (context.req.method !== 'POST') return next()
        return workspaceMiddleware(context, next)
      })
      app.use('/mcp-files/*', workspaceMiddleware)
    }
  }
  registerMetaRoutes(app, options)
  registerV2Routes(app, {
    workerJobsAvailable: options.workerJobsAvailable ?? false,
    ...(options.modelDeploymentOperatorToken === undefined
      ? {}
      : { modelDeploymentOperatorToken: options.modelDeploymentOperatorToken }),
    ...(options.modelDeploymentServiceCredential === undefined
      ? {}
      : { modelDeploymentServiceCredential: options.modelDeploymentServiceCredential }),
  })
  registerEvalScopeGateway(app, {
    config: options.evalscope ?? {
      enabled: false,
      invokeTimeoutMs: 86_400_000,
      proxyPrefix: '/evalscope-api',
      requestMaxBytes: 1024 * 1024,
      responseMaxBytes: 16 * 1024 * 1024,
      timeoutMs: 30_000,
    },
    ...(options.evalscopeFetch === undefined ? {} : { fetch: options.evalscopeFetch }),
  })
  registerSwiftStudioGateway(app, {
    config: options.swiftStudio ?? DISABLED_SWIFT_STUDIO_GATEWAY_CONFIG,
    ...(options.swiftStudioFetch === undefined ? {} : { fetch: options.swiftStudioFetch }),
  })
  if (mcpRuntime !== undefined) {
    registerMcpRoutes(app, mcpRuntime)
    registerMcpFileRoutes(app, mcpRuntime)
  }

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
      ...swiftStudioWorkspaceOpenOptions(options.swiftStudio),
      ...(options.evaluationArchiveMaxBytes === undefined
        ? {}
        : { evaluationArchiveMaxBytes: options.evaluationArchiveMaxBytes }),
      ...(options.evaluationArchiveSignedUrlTtlMs === undefined
        ? {}
        : { evaluationArchiveSignedUrlTtlMs: options.evaluationArchiveSignedUrlTtlMs }),
    },
  }
}

function swiftStudioWorkspaceOpenOptions(
  config: SwiftStudioGatewayConfig | undefined,
): Pick<V2WorkspaceOpenOptions, 'swiftStudio'> {
  if (
    config?.enabled !== true ||
    config.providerBaseUrl === undefined ||
    config.databenchBaseUrl === undefined
  ) {
    return {}
  }
  return {
    swiftStudio: {
      providerBaseUrl: config.providerBaseUrl,
      datasetExportBaseUrl: config.databenchBaseUrl,
      upstreamCommit: MS_SWIFT_UPSTREAM_COMMIT,
      imageDigest: config.imageDigest,
      runtimeCapabilityDigest: SWIFT_STUDIO_CAPABILITY_DIGEST,
      timeoutMs: config.timeoutMs,
      ...(config.providerCredential === undefined ? {} : { credential: config.providerCredential }),
    },
  }
}
