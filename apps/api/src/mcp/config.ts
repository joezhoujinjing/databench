import { z } from 'zod'

export const DEFAULT_MCP_MAX_JSON_BYTES = 1024 * 1024
export const DEFAULT_MCP_MAX_PREVIEW_RESPONSE_BYTES = 1024 * 1024
export const DEFAULT_MCP_MAX_TOKENS = 128
export const DEFAULT_MCP_MAX_ACTIVE_FILE_OPERATIONS = 2
export const DEFAULT_MCP_TOKEN_TTL_MS = 15 * 60 * 1000
export const DEFAULT_MCP_FILE_IDLE_TIMEOUT_MS = 60 * 1000
export const DEFAULT_MCP_FILE_TOTAL_TIMEOUT_MS = 30 * 60 * 1000

export interface McpDisabledConfig {
  readonly enabled: false
}

export interface McpEnabledConfig {
  readonly enabled: true
  readonly authMode: 'none'
  readonly publicBaseUrl: string
  readonly allowedOrigins: readonly string[]
  readonly maxJsonBytes: number
  readonly maxPreviewResponseBytes: number
  readonly maxTokens: number
  readonly maxActiveFileOperations: number
  readonly tokenTtlMs: number
  readonly fileIdleTimeoutMs: number
  readonly fileTotalTimeoutMs: number
}

export type McpRuntimeConfig = McpDisabledConfig | McpEnabledConfig

const McpEnvSchema = z.strictObject({
  DATABENCH_MCP_ENABLED: z.enum(['true', 'false']).default('false'),
  DATABENCH_MCP_AUTH_MODE: z.string().optional(),
  DATABENCH_MCP_PUBLIC_BASE_URL: z.string().optional(),
  DATABENCH_MCP_ORIGINS: z.string().default(''),
  DATABENCH_MCP_MAX_JSON_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(DEFAULT_MCP_MAX_JSON_BYTES),
  DATABENCH_MCP_MAX_PREVIEW_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(DEFAULT_MCP_MAX_PREVIEW_RESPONSE_BYTES),
  DATABENCH_MCP_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(1)
    .max(4096)
    .default(DEFAULT_MCP_MAX_TOKENS),
  DATABENCH_MCP_MAX_ACTIVE_FILE_OPERATIONS: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(DEFAULT_MCP_MAX_ACTIVE_FILE_OPERATIONS),
  DATABENCH_MCP_TOKEN_TTL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(24 * 60 * 60 * 1000)
    .default(DEFAULT_MCP_TOKEN_TTL_MS),
  DATABENCH_MCP_FILE_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60 * 60 * 1000)
    .default(DEFAULT_MCP_FILE_IDLE_TIMEOUT_MS),
  DATABENCH_MCP_FILE_TOTAL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(24 * 60 * 60 * 1000)
    .default(DEFAULT_MCP_FILE_TOTAL_TIMEOUT_MS),
})

export function mcpConfigFromEnv(env: NodeJS.ProcessEnv): McpRuntimeConfig {
  const input = Object.fromEntries(
    Object.keys(McpEnvSchema.shape)
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]),
  )
  const parsed = McpEnvSchema.parse(input)
  if (parsed.DATABENCH_MCP_ENABLED === 'false') return Object.freeze({ enabled: false })
  if (parsed.DATABENCH_MCP_AUTH_MODE !== 'none') {
    throw new TypeError(
      'DATABENCH_MCP_AUTH_MODE must be explicitly set to none when MCP is enabled',
    )
  }
  if (parsed.DATABENCH_MCP_PUBLIC_BASE_URL === undefined) {
    throw new TypeError('DATABENCH_MCP_PUBLIC_BASE_URL is required when MCP is enabled')
  }
  if (parsed.DATABENCH_MCP_FILE_TOTAL_TIMEOUT_MS < parsed.DATABENCH_MCP_FILE_IDLE_TIMEOUT_MS) {
    throw new TypeError('MCP total file timeout must be greater than or equal to the idle timeout')
  }
  const publicBaseUrl = parsePublicBaseUrl(parsed.DATABENCH_MCP_PUBLIC_BASE_URL)
  const allowedOrigins = parsed.DATABENCH_MCP_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(parseExactOrigin)

  return Object.freeze({
    enabled: true,
    authMode: 'none',
    publicBaseUrl,
    allowedOrigins: Object.freeze([...new Set(allowedOrigins)]),
    maxJsonBytes: parsed.DATABENCH_MCP_MAX_JSON_BYTES,
    maxPreviewResponseBytes: parsed.DATABENCH_MCP_MAX_PREVIEW_RESPONSE_BYTES,
    maxTokens: parsed.DATABENCH_MCP_MAX_TOKENS,
    maxActiveFileOperations: parsed.DATABENCH_MCP_MAX_ACTIVE_FILE_OPERATIONS,
    tokenTtlMs: parsed.DATABENCH_MCP_TOKEN_TTL_MS,
    fileIdleTimeoutMs: parsed.DATABENCH_MCP_FILE_IDLE_TIMEOUT_MS,
    fileTotalTimeoutMs: parsed.DATABENCH_MCP_FILE_TOTAL_TIMEOUT_MS,
  })
}

function parsePublicBaseUrl(input: string): string {
  if (input.endsWith('/')) {
    throw new TypeError('DATABENCH_MCP_PUBLIC_BASE_URL must not have a trailing slash')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new TypeError('DATABENCH_MCP_PUBLIC_BASE_URL must be an absolute HTTP(S) URL')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(
      'DATABENCH_MCP_PUBLIC_BASE_URL must be HTTP(S) without credentials, query, or fragment',
    )
  }
  const serialized = url.toString()
  return url.pathname === '/' ? serialized.slice(0, -1) : serialized
}

function parseExactOrigin(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new TypeError('DATABENCH_MCP_ORIGINS entries must be absolute HTTP(S) origins')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin !== input ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('DATABENCH_MCP_ORIGINS entries must be exact HTTP(S) origins')
  }
  return input
}
