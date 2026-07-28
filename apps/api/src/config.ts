import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { type V2WorkspaceOpenOptions, v2ObjectStoreConfigFromEnv } from '@databench/workspace'
import { z } from 'zod'
import { type EvalScopeGatewayConfig, evalScopeGatewayConfigFromEnv } from './evalscope/config.js'
import { type McpRuntimeConfig, mcpConfigFromEnv } from './mcp/config.js'
import {
  type SwiftStudioGatewayConfig,
  swiftStudioGatewayConfigFromEnv,
} from './swift-studio/config.js'

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
const EnvSchema = z
  .object({
    DATABASE_URL: z.string().optional(),
    DATABENCH_CORS_ORIGINS: z.string().default(''),
    DATABENCH_OPENAPI_SERVER_URL: z.string().trim().min(1).optional(),
    DATABENCH_ROOT: z.string().default('./bench'),
    DATABENCH_V2_CURSOR_SECRET: z.string().min(16),
    DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN: optionalServiceToken(),
    DATABENCH_SERVICE_CREDENTIAL: optionalServiceToken(),
    DATABENCH_WORKER_ENABLED: z.enum(['true', 'false']).default('false'),
    DATABENCH_WORKER_TARGET: z.string().default('127.0.0.1:50051'),
    DATABENCH_WORKER_JOB_DEADLINE_MS: z.coerce.number().int().positive().default(900_000),
    DATABENCH_WORKER_LEASE_MS: z.coerce.number().int().positive().default(30_000),
    DATABENCH_WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),
    DATABENCH_WORKER_TERMINAL_EOF_MS: z.coerce.number().int().positive().default(5_000),
    DATABENCH_WORKER_SIGNED_URL_TTL_MS: z.coerce.number().int().positive().default(1_200_000),
    DATABENCH_WORKER_SHUTDOWN_MS: z.coerce.number().int().positive().default(30_000),
    PORT: z.coerce.number().int().positive().default(8000),
  })
  .superRefine((value, context) => {
    if (
      value.DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN !== undefined &&
      value.DATABENCH_SERVICE_CREDENTIAL !== undefined &&
      value.DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN === value.DATABENCH_SERVICE_CREDENTIAL
    ) {
      context.addIssue({
        code: 'custom',
        path: ['DATABENCH_SERVICE_CREDENTIAL'],
        message: 'Model Deployment operator and service credentials must be distinct',
      })
    }
    if (value.DATABENCH_WORKER_ENABLED !== 'true') return
    if (value.DATABENCH_WORKER_LEASE_MS <= 2 * value.DATABENCH_WORKER_HEARTBEAT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['DATABENCH_WORKER_LEASE_MS'],
        message: 'Worker lease must be greater than two heartbeat intervals',
      })
    }
    if (value.DATABENCH_WORKER_TERMINAL_EOF_MS >= value.DATABENCH_WORKER_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        path: ['DATABENCH_WORKER_TERMINAL_EOF_MS'],
        message: 'Worker terminal EOF timeout must be shorter than the lease',
      })
    }
    if (
      value.DATABENCH_WORKER_SIGNED_URL_TTL_MS <=
      value.DATABENCH_WORKER_JOB_DEADLINE_MS + value.DATABENCH_WORKER_LEASE_MS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['DATABENCH_WORKER_SIGNED_URL_TTL_MS'],
        message: 'Worker signed URL TTL must exceed the job deadline plus finalization buffer',
      })
    }
    if (!isPrivateWorkerTarget(value.DATABENCH_WORKER_TARGET)) {
      context.addIssue({
        code: 'custom',
        path: ['DATABENCH_WORKER_TARGET'],
        message: 'Worker target must be localhost, the offline worker service, or a private IP',
      })
    }
  })

export interface WorkerApiConfig {
  readonly enabled: boolean
  readonly target: string
  readonly jobDeadlineMs: number
  readonly leaseMs: number
  readonly heartbeatMs: number
  readonly terminalEofMs: number
  readonly signedUrlTtlMs: number
  readonly shutdownMs: number
}

export interface ApiConfig {
  readonly corsOrigins: readonly string[]
  readonly databaseUrl?: string
  readonly evalscope?: EvalScopeGatewayConfig
  readonly mcp: McpRuntimeConfig
  readonly modelDeploymentOperatorToken?: string
  readonly modelDeploymentServiceCredential?: string
  readonly openApiServerUrl?: string
  readonly port: number
  readonly storeConfig: NonNullable<V2WorkspaceOpenOptions['storeConfig']>
  readonly swiftStudio?: SwiftStudioGatewayConfig
  readonly v2CursorSecret: string
  readonly version: string
  readonly workspaceRoot: string
  readonly worker?: WorkerApiConfig
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = EnvSchema.parse(env)

  const config: ApiConfig = {
    corsOrigins: parsed.DATABENCH_CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    evalscope: evalScopeGatewayConfigFromEnv(env),
    mcp: mcpConfigFromEnv(env),
    ...(parsed.DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN === undefined
      ? {}
      : {
          modelDeploymentOperatorToken: parsed.DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN,
        }),
    ...(parsed.DATABENCH_SERVICE_CREDENTIAL === undefined
      ? {}
      : { modelDeploymentServiceCredential: parsed.DATABENCH_SERVICE_CREDENTIAL }),
    port: parsed.PORT,
    storeConfig: v2ObjectStoreConfigFromEnv(env),
    swiftStudio: swiftStudioGatewayConfigFromEnv(env),
    v2CursorSecret: parsed.DATABENCH_V2_CURSOR_SECRET,
    version: readVersion(),
    workspaceRoot: parsed.DATABENCH_ROOT,
    worker: {
      enabled: parsed.DATABENCH_WORKER_ENABLED === 'true',
      target: parsed.DATABENCH_WORKER_TARGET,
      jobDeadlineMs: parsed.DATABENCH_WORKER_JOB_DEADLINE_MS,
      leaseMs: parsed.DATABENCH_WORKER_LEASE_MS,
      heartbeatMs: parsed.DATABENCH_WORKER_HEARTBEAT_MS,
      terminalEofMs: parsed.DATABENCH_WORKER_TERMINAL_EOF_MS,
      signedUrlTtlMs: parsed.DATABENCH_WORKER_SIGNED_URL_TTL_MS,
      shutdownMs: parsed.DATABENCH_WORKER_SHUTDOWN_MS,
    },
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

function optionalServiceToken() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .min(32)
      .max(512)
      .refine((value) => !/\s/u.test(value) && !hasControlCharacter(value), {
        message: 'Service token must not contain whitespace or control characters',
      })
      .optional(),
  )
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}

function isPrivateWorkerTarget(value: string): boolean {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value)
  if (!match) return false
  const host = (match[1] ?? match[2] ?? '').toLowerCase()
  const port = Number(match[3])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false
  if (host === 'worker') return port === 50_051
  if (host === 'localhost' || host === '::1') return true
  if (isIP(host) === 6) return host.startsWith('fc') || host.startsWith('fd')
  if (isIP(host) !== 4) return false
  const octets = host.split('.').map(Number)
  const [first, second] = octets
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}
