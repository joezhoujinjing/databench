import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { z } from 'zod'
import { EVALSCOPE_PROXY_ROUTE_KEYS } from './routes.js'

const EvalScopeEnvSchema = z
  .object({
    DATABENCH_EVALSCOPE_ACCESS_TOKEN: z.string().trim().min(32).max(4096).optional(),
    DATABENCH_EVALSCOPE_ALLOWED_ROUTES_MANIFEST: z.string().trim().min(1).optional(),
    DATABENCH_EVALSCOPE_ENABLED: z.enum(['true', 'false']).default('false'),
    DATABENCH_EVALSCOPE_INTRANET_HTTP_DOCUMENTS: z.enum(['true', 'false']).default('false'),
    DATABENCH_EVALSCOPE_INTERNAL_BASE_URL: z.string().trim().min(1).optional(),
    DATABENCH_EVALSCOPE_INVOKE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(86_400_000),
    DATABENCH_EVALSCOPE_PROXY_PREFIX: z.literal('/evalscope-api').default('/evalscope-api'),
    DATABENCH_EVALSCOPE_REQUEST_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024)
      .default(1024 * 1024),
    DATABENCH_EVALSCOPE_RESPONSE_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    DATABENCH_EVALSCOPE_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    DATABENCH_EVALSCOPE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  })
  .superRefine((value, context) => {
    if (value.DATABENCH_EVALSCOPE_ENABLED !== 'true') return
    if (value.DATABENCH_EVALSCOPE_INTERNAL_BASE_URL === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['DATABENCH_EVALSCOPE_INTERNAL_BASE_URL'],
        message: 'EvalScope internal base URL is required while enabled',
      })
    }
    if (value.DATABENCH_EVALSCOPE_ALLOWED_ROUTES_MANIFEST === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['DATABENCH_EVALSCOPE_ALLOWED_ROUTES_MANIFEST'],
        message: 'EvalScope route manifest is required while enabled',
      })
    }
  })

export interface EvalScopeGatewayConfig {
  readonly accessToken?: string
  readonly enabled: boolean
  readonly intranetHttpDocuments: boolean
  readonly internalBaseUrl?: string
  readonly invokeTimeoutMs: number
  readonly proxyPrefix: '/evalscope-api'
  readonly requestMaxBytes: number
  readonly responseMaxBytes: number
  readonly routeManifestPath?: string
  readonly sessionTtlSeconds: number
  readonly timeoutMs: number
}

export function evalScopeGatewayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EvalScopeGatewayConfig {
  const parsed = EvalScopeEnvSchema.parse(env)
  if (parsed.DATABENCH_EVALSCOPE_ENABLED !== 'true') {
    return {
      ...(parsed.DATABENCH_EVALSCOPE_ACCESS_TOKEN === undefined
        ? {}
        : { accessToken: parsed.DATABENCH_EVALSCOPE_ACCESS_TOKEN }),
      enabled: false,
      intranetHttpDocuments: parsed.DATABENCH_EVALSCOPE_INTRANET_HTTP_DOCUMENTS === 'true',
      invokeTimeoutMs: parsed.DATABENCH_EVALSCOPE_INVOKE_TIMEOUT_MS,
      proxyPrefix: parsed.DATABENCH_EVALSCOPE_PROXY_PREFIX,
      requestMaxBytes: parsed.DATABENCH_EVALSCOPE_REQUEST_MAX_BYTES,
      responseMaxBytes: parsed.DATABENCH_EVALSCOPE_RESPONSE_MAX_BYTES,
      sessionTtlSeconds: parsed.DATABENCH_EVALSCOPE_SESSION_TTL_SECONDS,
      timeoutMs: parsed.DATABENCH_EVALSCOPE_TIMEOUT_MS,
    }
  }

  const internalBaseUrl = parsePrivateHttpOrigin(
    parsed.DATABENCH_EVALSCOPE_INTERNAL_BASE_URL as string,
  )
  const routeManifestPath = parsed.DATABENCH_EVALSCOPE_ALLOWED_ROUTES_MANIFEST as string
  if (!routeManifestPath.startsWith('/')) {
    throw new TypeError('EvalScope route manifest path must be absolute')
  }
  assertRouteManifest(routeManifestPath)
  return {
    ...(parsed.DATABENCH_EVALSCOPE_ACCESS_TOKEN === undefined
      ? {}
      : { accessToken: parsed.DATABENCH_EVALSCOPE_ACCESS_TOKEN }),
    enabled: true,
    intranetHttpDocuments: parsed.DATABENCH_EVALSCOPE_INTRANET_HTTP_DOCUMENTS === 'true',
    internalBaseUrl,
    invokeTimeoutMs: parsed.DATABENCH_EVALSCOPE_INVOKE_TIMEOUT_MS,
    proxyPrefix: parsed.DATABENCH_EVALSCOPE_PROXY_PREFIX,
    requestMaxBytes: parsed.DATABENCH_EVALSCOPE_REQUEST_MAX_BYTES,
    responseMaxBytes: parsed.DATABENCH_EVALSCOPE_RESPONSE_MAX_BYTES,
    routeManifestPath,
    sessionTtlSeconds: parsed.DATABENCH_EVALSCOPE_SESSION_TTL_SECONDS,
    timeoutMs: parsed.DATABENCH_EVALSCOPE_TIMEOUT_MS,
  }
}

function parsePrivateHttpOrigin(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('EvalScope internal base URL must be a valid HTTP origin')
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !isPrivateHost(parsed.hostname)
  ) {
    throw new TypeError('EvalScope internal base URL must be a private HTTP origin')
  }
  return parsed.origin
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'evalscope' || host === 'localhost') return true
  if (isIP(host) === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd')
  }
  if (isIP(host) !== 4) return false
  const [first, second] = host.split('.').map(Number)
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

function assertRouteManifest(path: string): void {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new TypeError('EvalScope route manifest cannot be read')
  }
  const parsed = z
    .object({
      schema_version: z.literal(1),
      routes: z.array(
        z.object({
          method: z.string(),
          path: z.string(),
          classification: z.string(),
        }),
      ),
    })
    .parse(value)
  const allowed = parsed.routes
    .filter(
      (route) =>
        route.classification === 'allowed' ||
        route.classification === 'allowed-patched' ||
        route.classification === 'databench-generated',
    )
    .map((route) => `${route.method.toUpperCase()} ${route.path}`)
    .sort()
  const expected = [...EVALSCOPE_PROXY_ROUTE_KEYS].sort()
  if (JSON.stringify(allowed) !== JSON.stringify(expected)) {
    throw new TypeError('EvalScope route manifest does not match the compiled exact allowlist')
  }
}
