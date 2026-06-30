import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp, createOpenApiDocument } from './app.js'
import { type ApiConfig, loadConfig } from './config.js'

export { createApp, createOpenApiDocument, loadConfig }

export function createAppFromConfig(config: ApiConfig) {
  return createApp({
    ...(config.databaseUrl !== undefined ? { databaseUrl: config.databaseUrl } : {}),
    corsOrigins: config.corsOrigins,
    storeConfig: config.storeConfig,
    version: config.version,
    workspaceRoot: config.workspaceRoot,
  })
}

function isEntrypoint(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

if (isEntrypoint()) {
  const config = loadConfig()
  const app = createAppFromConfig(config)

  serve({
    fetch: app.fetch,
    port: config.port,
  })

  console.log(`databench api listening on :${config.port}`)
}
