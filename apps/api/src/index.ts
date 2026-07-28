import { existsSync } from 'node:fs'
import { Server as HttpServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DATA_JUICER_BATCH_CAPABILITY_V1,
  openWorkerRuntime,
  V2Workspace,
  type WorkerRuntime,
} from '@databench/workspace'
import { serve } from '@hono/node-server'
import { createApp, createOpenApiDocument } from './app.js'
import { type ApiConfig, loadConfig } from './config.js'
import { mcpHttpRequestTimeoutMs } from './mcp/config.js'
import {
  DISABLED_SWIFT_STUDIO_GATEWAY_CONFIG,
  type SwiftStudioGatewayConfig,
} from './swift-studio/config.js'
import {
  attachSwiftStudioUpgradeProxy,
  type SwiftStudioUpgradeProxy,
} from './swift-studio/upgrade.js'

export { createApp, createOpenApiDocument, loadConfig }

// Load the monorepo-root .env (if present) so local dev picks up DATABASE_URL /
// OSS_* without exporting them. Resolved by file location, not cwd; a no-op when
// absent (deployed envs set variables directly). Only runs when this module is
// the entrypoint, so test imports are unaffected.
function loadRootEnv(): void {
  const envFile = fileURLToPath(new URL('../../../.env', import.meta.url))
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile)
  }
}

export function createAppFromConfig(config: ApiConfig) {
  return createApp({
    ...(config.databaseUrl !== undefined ? { databaseUrl: config.databaseUrl } : {}),
    ...(config.openApiServerUrl !== undefined ? { openApiServerUrl: config.openApiServerUrl } : {}),
    corsOrigins: config.corsOrigins,
    ...(config.evalscope === undefined ? {} : { evalscope: config.evalscope }),
    mcp: config.mcp,
    storeConfig: config.storeConfig,
    ...(config.swiftStudio === undefined ? {} : { swiftStudio: config.swiftStudio }),
    v2CursorSecret: config.v2CursorSecret,
    version: config.version,
    workspaceRoot: config.workspaceRoot,
  })
}

export interface ApiRuntime {
  readonly server: ReturnType<typeof serve>
  close(): Promise<void>
}

interface ApiRuntimeDependencies {
  readonly openWorkspace: typeof V2Workspace.open
  readonly openWorkerRuntime: typeof openWorkerRuntime
  readonly serve: typeof serve
}

const DEFAULT_RUNTIME_DEPENDENCIES: ApiRuntimeDependencies = {
  openWorkspace: V2Workspace.open,
  openWorkerRuntime,
  serve,
}

export async function startApiRuntime(
  config: ApiConfig,
  dependencies: ApiRuntimeDependencies = DEFAULT_RUNTIME_DEPENDENCIES,
): Promise<ApiRuntime> {
  const mcpConfig = config.mcp ?? { enabled: false }
  const swiftStudioConfig: SwiftStudioGatewayConfig =
    config.swiftStudio ?? DISABLED_SWIFT_STUDIO_GATEWAY_CONFIG
  const workspace = await dependencies.openWorkspace({
    root: config.workspaceRoot,
    cursorSecret: config.v2CursorSecret,
    storeConfig: config.storeConfig,
    ...(config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl }),
  })
  let workerRuntime: WorkerRuntime | null = null
  let server: ReturnType<typeof serve> | null = null
  let swiftStudioUpgradeProxy: SwiftStudioUpgradeProxy | null = null
  try {
    if (config.worker?.enabled === true) {
      workerRuntime = await dependencies.openWorkerRuntime({
        workspace,
        target: config.worker.target,
        storeConfig: config.storeConfig,
        workspaceRoot: config.workspaceRoot,
        signedUrlTtlMs: config.worker.signedUrlTtlMs,
        jobDeadlineMs: config.worker.jobDeadlineMs,
        leaseMs: config.worker.leaseMs,
        heartbeatMs: config.worker.heartbeatMs,
        terminalEofMs: config.worker.terminalEofMs,
      })
      await workerRuntime.start()
    }
    const app = createApp({
      v2Workspace: workspace,
      ...(config.openApiServerUrl === undefined
        ? {}
        : { openApiServerUrl: config.openApiServerUrl }),
      corsOrigins: config.corsOrigins,
      ...(config.evalscope === undefined ? {} : { evalscope: config.evalscope }),
      mcp: mcpConfig,
      swiftStudio: swiftStudioConfig,
      version: config.version,
      workspaceRoot: config.workspaceRoot,
      workerJobsAvailable:
        workerRuntime?.supportsCapability(DATA_JUICER_BATCH_CAPABILITY_V1, '1') ?? false,
    })
    server = dependencies.serve({ fetch: app.fetch, port: config.port })
    if (swiftStudioConfig.enabled) {
      if (!(server instanceof HttpServer)) {
        throw new TypeError('Swift Studio requires the Node HTTP/1 server WebSocket boundary')
      }
      swiftStudioUpgradeProxy = attachSwiftStudioUpgradeProxy(server, swiftStudioConfig)
    }
    const mcpRequestTimeoutMs = mcpHttpRequestTimeoutMs(mcpConfig)
    const swiftRequestTimeoutMs = swiftStudioConfig.enabled
      ? swiftStudioConfig.streamTimeoutMs
      : undefined
    const requestTimeoutMs = [mcpRequestTimeoutMs, swiftRequestTimeoutMs].reduce<
      number | undefined
    >(
      (maximum, candidate) =>
        candidate === undefined ? maximum : Math.max(maximum ?? 0, candidate),
      undefined,
    )
    if (requestTimeoutMs !== undefined) {
      if (!(server instanceof HttpServer)) {
        throw new TypeError('Long-lived routes require the Node HTTP/1 request timeout boundary')
      }
      server.requestTimeout = requestTimeoutMs
    }
  } catch (error) {
    swiftStudioUpgradeProxy?.close()
    if (server !== null) await closeServer(server).catch(() => undefined)
    await workerRuntime?.stop().catch(() => undefined)
    await workspace.close().catch(() => undefined)
    throw error
  }

  const openedServer = server
  if (openedServer === null) throw new Error('API server did not start')
  let closePromise: Promise<void> | null = null
  return {
    server: openedServer,
    async close() {
      closePromise ??= (async () => {
        swiftStudioUpgradeProxy?.close()
        const serverClosed = closeServer(openedServer)
        await workerRuntime?.stop()
        await workspace.close()
        await serverClosed
      })()
      await closePromise
    },
  }
}

async function closeServer(server: ReturnType<typeof serve>): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function isEntrypoint(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

if (isEntrypoint()) {
  loadRootEnv()
  void startEntrypoint().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}

async function startEntrypoint(): Promise<void> {
  const config = loadConfig()
  const runtime = await startApiRuntime(config)
  const shutdown = async () => {
    await withDeadline(runtime.close(), config.worker?.shutdownMs ?? 30_000)
  }
  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())
  console.log(`databench api listening on :${config.port}`)
  if (config.mcp.enabled) {
    console.warn(
      'WARNING: Databench MCP is anonymous with full access; use only on a trusted network',
    )
  }
}

async function withDeadline(operation: Promise<void>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('API shutdown deadline exceeded')), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
