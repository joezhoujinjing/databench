import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type V2ModelRepositoryOpenOptions,
  type V2WorkspaceOpenOptions,
  v2ObjectStoreConfigFromEnv,
} from '@databench/workspace'
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
    DATABENCH_MODEL_REPOSITORY_MODE: z.enum(['offline', 'connected']).default('offline'),
    DATABENCH_MODEL_REPOSITORY_CONFIG: optionalAbsolutePath(),
    DATABENCH_MODEL_REPOSITORY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000)
      .default(5_000),
    DATABENCH_MODEL_ENDPOINT_POLICY: optionalAbsolutePath(),
    DATABENCH_MODEL_CREDENTIALS: optionalAbsolutePath(),
    DATABENCH_MODEL_ENDPOINT_CONNECT_TIMEOUT_MS: endpointTimeout(2_000),
    DATABENCH_MODEL_ENDPOINT_HEADERS_TIMEOUT_MS: endpointTimeout(3_000),
    DATABENCH_MODEL_ENDPOINT_BODY_TIMEOUT_MS: endpointTimeout(3_000),
    DATABENCH_MODEL_ENDPOINT_TOTAL_TIMEOUT_MS: endpointTimeout(5_000),
    DATABENCH_SERVICE_CREDENTIAL: optionalServiceToken(),
    DATABENCH_EVALUATION_ARCHIVE_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024)
      .default(1024 * 1024 * 1024),
    DATABENCH_EVALUATION_ARCHIVE_SIGNED_URL_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(15 * 60 * 1000)
      .default(15 * 60 * 1000),
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
    for (const [field, timeout] of [
      [
        'DATABENCH_MODEL_ENDPOINT_CONNECT_TIMEOUT_MS',
        value.DATABENCH_MODEL_ENDPOINT_CONNECT_TIMEOUT_MS,
      ],
      [
        'DATABENCH_MODEL_ENDPOINT_HEADERS_TIMEOUT_MS',
        value.DATABENCH_MODEL_ENDPOINT_HEADERS_TIMEOUT_MS,
      ],
      ['DATABENCH_MODEL_ENDPOINT_BODY_TIMEOUT_MS', value.DATABENCH_MODEL_ENDPOINT_BODY_TIMEOUT_MS],
    ] as const) {
      if (timeout > value.DATABENCH_MODEL_ENDPOINT_TOTAL_TIMEOUT_MS) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Endpoint phase timeout must not exceed total timeout',
        })
      }
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
  readonly evaluationArchiveMaxBytes: number
  readonly evaluationArchiveSignedUrlTtlMs: number
  readonly corsOrigins: readonly string[]
  readonly databaseUrl?: string
  readonly evalscope?: EvalScopeGatewayConfig
  readonly mcp: McpRuntimeConfig
  readonly modelRepository: V2ModelRepositoryOpenOptions
  readonly modelEndpointSecurity: {
    readonly policyPath?: string
    readonly credentialProjectionPath?: string
    readonly connectTimeoutMs: number
    readonly headersTimeoutMs: number
    readonly bodyTimeoutMs: number
    readonly totalTimeoutMs: number
  }
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
    evaluationArchiveMaxBytes: parsed.DATABENCH_EVALUATION_ARCHIVE_MAX_BYTES,
    evaluationArchiveSignedUrlTtlMs: parsed.DATABENCH_EVALUATION_ARCHIVE_SIGNED_URL_TTL_MS,
    mcp: mcpConfigFromEnv(env),
    modelRepository: {
      mode: parsed.DATABENCH_MODEL_REPOSITORY_MODE,
      timeoutMs: parsed.DATABENCH_MODEL_REPOSITORY_TIMEOUT_MS,
      ...(parsed.DATABENCH_MODEL_REPOSITORY_CONFIG === undefined
        ? {}
        : { operatorConfigPath: parsed.DATABENCH_MODEL_REPOSITORY_CONFIG }),
    },
    modelEndpointSecurity: {
      ...(parsed.DATABENCH_MODEL_ENDPOINT_POLICY === undefined
        ? {}
        : { policyPath: parsed.DATABENCH_MODEL_ENDPOINT_POLICY }),
      ...(parsed.DATABENCH_MODEL_CREDENTIALS === undefined
        ? {}
        : { credentialProjectionPath: parsed.DATABENCH_MODEL_CREDENTIALS }),
      connectTimeoutMs: parsed.DATABENCH_MODEL_ENDPOINT_CONNECT_TIMEOUT_MS,
      headersTimeoutMs: parsed.DATABENCH_MODEL_ENDPOINT_HEADERS_TIMEOUT_MS,
      bodyTimeoutMs: parsed.DATABENCH_MODEL_ENDPOINT_BODY_TIMEOUT_MS,
      totalTimeoutMs: parsed.DATABENCH_MODEL_ENDPOINT_TOTAL_TIMEOUT_MS,
    },
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

function optionalAbsolutePath() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine(isAbsolute, { message: 'Path must be absolute' })
      .optional(),
  )
}

function endpointTimeout(defaultValue: number) {
  return z.coerce.number().int().min(100).max(60_000).default(defaultValue)
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
