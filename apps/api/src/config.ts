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
  // Aliyun OSS (object store / data plane). Credentials required for real use.
  OSS_REGION: z.string().default('oss-cn-hangzhou'),
  OSS_BUCKET: z.string().default('databench'),
  OSS_ACCESS_KEY_ID: z.string().default(''),
  OSS_ACCESS_KEY_SECRET: z.string().default(''),
  OSS_ENDPOINT: z.string().optional(),
  OSS_INTERNAL: z.coerce.boolean().optional(),
  OSS_SECURE: z.coerce.boolean().optional(),
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
      bucket: parsed.OSS_BUCKET,
      region: parsed.OSS_REGION,
      accessKeyId: parsed.OSS_ACCESS_KEY_ID,
      accessKeySecret: parsed.OSS_ACCESS_KEY_SECRET,
      ...(parsed.OSS_ENDPOINT !== undefined ? { endpoint: parsed.OSS_ENDPOINT } : {}),
      ...(parsed.OSS_INTERNAL !== undefined ? { internal: parsed.OSS_INTERNAL } : {}),
      ...(parsed.OSS_SECURE !== undefined ? { secure: parsed.OSS_SECURE } : {}),
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
