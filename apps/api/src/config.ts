import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { WorkspaceOpenOptions } from '@databench/workspace'
import { z } from 'zod'

// Read the service version from the monorepo root package.json rather than
// hard-coding it, so a single bump there propagates to /health and /version.
function readVersion(): string {
  const packageJsonUrl = new URL('../../../package.json', import.meta.url)
  const parsed = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), 'utf8')) as {
    version?: string
  }

  return parsed.version ?? '0.0.0'
}

const EnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('databench'),
  S3_ACCESS_KEY_ID: z.string().default('databench'),
  S3_SECRET_ACCESS_KEY: z.string().default('databench-secret'),
  DATABENCH_CORS_ORIGINS: z.string().default(''),
  DATABENCH_ROOT: z.string().default('./bench'),
  PORT: z.coerce.number().int().positive().default(8000),
})

export interface ApiConfig {
  readonly corsOrigins: readonly string[]
  readonly databaseUrl?: string
  readonly port: number
  readonly storeConfig: NonNullable<WorkspaceOpenOptions['storeConfig']>
  readonly version: string
  readonly workspaceRoot: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = EnvSchema.parse(env)

  const config: ApiConfig = {
    corsOrigins: parsed.DATABENCH_CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    port: parsed.PORT,
    storeConfig: {
      bucket: parsed.S3_BUCKET,
      region: parsed.S3_REGION,
      endpoint: parsed.S3_ENDPOINT,
      accessKeyId: parsed.S3_ACCESS_KEY_ID,
      secretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
      forcePathStyle: true,
    },
    version: readVersion(),
    workspaceRoot: parsed.DATABENCH_ROOT,
  }

  if (parsed.DATABASE_URL !== undefined) {
    return {
      ...config,
      databaseUrl: parsed.DATABASE_URL,
    }
  }

  return config
}
