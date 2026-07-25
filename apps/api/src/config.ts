import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type V2WorkspaceOpenOptions, v2ObjectStoreConfigFromEnv } from '@databench/workspace'
import { z } from 'zod'
import { type McpRuntimeConfig, mcpConfigFromEnv } from './mcp/config.js'

// Read the service version from the monorepo root package.json rather than
// hard-coding it, so a single bump there propagates to /health and /version.
function readVersion(): string {
  const packageJsonUrl = new URL('../../../package.json', import.meta.url)
  const parsed = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), 'utf8')) as {
    version?: string
  }

  return parsed.version ?? '0.0.0'
}

// Object-store env (OSS_* or S3_*, selected by DATABENCH_OBJECT_STORE) is parsed
// by v2ObjectStoreConfigFromEnv, the single source shared with @databench/workspace so
// the two adapters can't drift.
const EnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
  DATABENCH_CORS_ORIGINS: z.string().default(''),
  DATABENCH_OPENAPI_SERVER_URL: z.string().trim().min(1).optional(),
  DATABENCH_ROOT: z.string().default('./bench'),
  DATABENCH_V2_CURSOR_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().positive().default(8000),
})

export interface ApiConfig {
  readonly corsOrigins: readonly string[]
  readonly databaseUrl?: string
  readonly mcp: McpRuntimeConfig
  readonly openApiServerUrl?: string
  readonly port: number
  readonly storeConfig: NonNullable<V2WorkspaceOpenOptions['storeConfig']>
  readonly v2CursorSecret: string
  readonly version: string
  readonly workspaceRoot: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = EnvSchema.parse(env)

  const config: ApiConfig = {
    corsOrigins: parsed.DATABENCH_CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    mcp: mcpConfigFromEnv(env),
    port: parsed.PORT,
    storeConfig: v2ObjectStoreConfigFromEnv(env),
    v2CursorSecret: parsed.DATABENCH_V2_CURSOR_SECRET,
    version: readVersion(),
    workspaceRoot: parsed.DATABENCH_ROOT,
  }

  const configured =
    parsed.DATABENCH_OPENAPI_SERVER_URL === undefined
      ? config
      : { ...config, openApiServerUrl: parsed.DATABENCH_OPENAPI_SERVER_URL }

  if (parsed.DATABASE_URL !== undefined) {
    return {
      ...configured,
      databaseUrl: parsed.DATABASE_URL,
    }
  }

  return configured
}
