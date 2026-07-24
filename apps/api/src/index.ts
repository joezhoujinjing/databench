import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp, createOpenApiDocument } from './app.js'
import { type ApiConfig, loadConfig } from './config.js'

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
    storeConfig: config.storeConfig,
    v2CursorSecret: config.v2CursorSecret,
    version: config.version,
    workspaceRoot: config.workspaceRoot,
  })
}

function isEntrypoint(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

if (isEntrypoint()) {
  loadRootEnv()
  const config = loadConfig()
  const app = createAppFromConfig(config)

  serve({
    fetch: app.fetch,
    port: config.port,
  })

  console.log(`databench api listening on :${config.port}`)
}
