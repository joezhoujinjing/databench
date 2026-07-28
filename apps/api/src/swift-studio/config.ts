import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { z } from 'zod'

export const SWIFT_STUDIO_PROXY_PREFIX = '/swift-studio' as const
export const SWIFT_STUDIO_RUNTIME_PREFIX = '/swift-studio-runtime' as const
export const MS_SWIFT_UPSTREAM_COMMIT = 'f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d' as const
export const SWIFT_STUDIO_IMAGE_DIGEST =
  '447eaea386367126efa833ea4e6b9f00546be7240cb2f3ec698ae45a58152908' as const
export const SWIFT_STUDIO_CAPABILITY_DIGEST =
  '01d259849837484b8ed00c013ed53d45548a525384317b856edebee02d5956b4' as const
export const SWIFT_STUDIO_GRADIO_VERSION = '5.50.0' as const
export const SWIFT_STUDIO_ROUTES_SHA256 =
  '2d9b3b0ca69acf53980140fbc9eeec6280239c018be3c431181309de53225635' as const

const SwiftStudioEnvSchema = z
  .object({
    DATABENCH_SWIFT_STUDIO_ENABLED: z.enum(['true', 'false']).default('false'),
    DATABENCH_SWIFT_STUDIO_DATABENCH_BASE_URL: z.string().trim().min(1).optional(),
    DATABENCH_SWIFT_STUDIO_INTERNAL_BASE_URL: z.string().trim().min(1).optional(),
    DATABENCH_SWIFT_STUDIO_MAX_CONCURRENT_REQUESTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1024)
      .default(64),
    DATABENCH_SWIFT_STUDIO_MAX_WEBSOCKET_CONNECTIONS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1024)
      .default(32),
    DATABENCH_SWIFT_STUDIO_PROVIDER_BASE_URL: z.string().trim().min(1).optional(),
    DATABENCH_SWIFT_STUDIO_PROVIDER_CREDENTIAL: z.string().min(16).max(4096).optional(),
    DATABENCH_SWIFT_STUDIO_REQUEST_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024 * 1024)
      .default(2 * 1024 * 1024 * 1024),
    DATABENCH_SWIFT_STUDIO_RESPONSE_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024 * 1024)
      .default(16 * 1024 * 1024 * 1024),
    DATABENCH_SWIFT_STUDIO_ROUTES_MANIFEST: z.string().trim().min(1).optional(),
    DATABENCH_SWIFT_STUDIO_STREAM_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(86_400_000),
    DATABENCH_SWIFT_STUDIO_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(600_000)
      .default(300_000),
  })
  .superRefine((value, context) => {
    if (value.DATABENCH_SWIFT_STUDIO_ENABLED !== 'true') return
    for (const field of [
      'DATABENCH_SWIFT_STUDIO_INTERNAL_BASE_URL',
      'DATABENCH_SWIFT_STUDIO_DATABENCH_BASE_URL',
      'DATABENCH_SWIFT_STUDIO_PROVIDER_BASE_URL',
      'DATABENCH_SWIFT_STUDIO_ROUTES_MANIFEST',
    ] as const) {
      if (value[field] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required while Swift Studio is enabled`,
        })
      }
    }
  })

export interface SwiftStudioManifestRoute {
  readonly classification: string
  readonly methods: readonly string[]
  readonly path: string
  readonly proxy_required: true
  readonly route_type: string
}

export interface SwiftStudioGatewayConfig {
  readonly databenchBaseUrl?: string
  readonly enabled: boolean
  readonly internalBaseUrl?: string
  readonly maxConcurrentRequests: number
  readonly maxWebSocketConnections: number
  readonly providerBaseUrl?: string
  readonly providerCredential?: string
  readonly proxyPrefix: typeof SWIFT_STUDIO_PROXY_PREFIX
  readonly requestMaxBytes: number
  readonly responseMaxBytes: number
  readonly routeManifestPath?: string
  readonly routes: readonly SwiftStudioManifestRoute[]
  readonly streamTimeoutMs: number
  readonly timeoutMs: number
}

export const DISABLED_SWIFT_STUDIO_GATEWAY_CONFIG: SwiftStudioGatewayConfig = {
  enabled: false,
  maxConcurrentRequests: 64,
  maxWebSocketConnections: 32,
  proxyPrefix: SWIFT_STUDIO_PROXY_PREFIX,
  requestMaxBytes: 2 * 1024 * 1024 * 1024,
  responseMaxBytes: 16 * 1024 * 1024 * 1024,
  routes: [],
  streamTimeoutMs: 86_400_000,
  timeoutMs: 300_000,
}

export function swiftStudioGatewayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SwiftStudioGatewayConfig {
  const parsed = SwiftStudioEnvSchema.parse(env)
  const common = {
    proxyPrefix: SWIFT_STUDIO_PROXY_PREFIX,
    maxConcurrentRequests: parsed.DATABENCH_SWIFT_STUDIO_MAX_CONCURRENT_REQUESTS,
    maxWebSocketConnections: parsed.DATABENCH_SWIFT_STUDIO_MAX_WEBSOCKET_CONNECTIONS,
    requestMaxBytes: parsed.DATABENCH_SWIFT_STUDIO_REQUEST_MAX_BYTES,
    responseMaxBytes: parsed.DATABENCH_SWIFT_STUDIO_RESPONSE_MAX_BYTES,
    streamTimeoutMs: parsed.DATABENCH_SWIFT_STUDIO_STREAM_TIMEOUT_MS,
    timeoutMs: parsed.DATABENCH_SWIFT_STUDIO_TIMEOUT_MS,
  } as const
  if (parsed.DATABENCH_SWIFT_STUDIO_ENABLED !== 'true') {
    return { enabled: false, routes: [], ...common }
  }
  const internalBaseUrl = parsePrivateHttpOrigin(
    parsed.DATABENCH_SWIFT_STUDIO_INTERNAL_BASE_URL as string,
    7860,
  )
  const providerBaseUrl = parsePrivateHttpOrigin(
    parsed.DATABENCH_SWIFT_STUDIO_PROVIDER_BASE_URL as string,
    7861,
  )
  const databenchBaseUrl = parsePrivateHttpOrigin(
    parsed.DATABENCH_SWIFT_STUDIO_DATABENCH_BASE_URL as string,
    8000,
  )
  const routeManifestPath = parsed.DATABENCH_SWIFT_STUDIO_ROUTES_MANIFEST as string
  if (!routeManifestPath.startsWith('/')) {
    throw new TypeError('Swift Studio route manifest path must be absolute')
  }
  const routes = readRouteManifest(routeManifestPath)
  return {
    enabled: true,
    databenchBaseUrl,
    internalBaseUrl,
    providerBaseUrl,
    ...(parsed.DATABENCH_SWIFT_STUDIO_PROVIDER_CREDENTIAL === undefined
      ? {}
      : { providerCredential: parsed.DATABENCH_SWIFT_STUDIO_PROVIDER_CREDENTIAL }),
    routeManifestPath,
    routes,
    ...common,
  }
}

export function findSwiftStudioRoute(
  routes: readonly SwiftStudioManifestRoute[],
  method: string,
  pathname: string,
): SwiftStudioManifestRoute | undefined {
  const normalizedMethod = method.toUpperCase()
  return routes.find(
    (route) => route.methods.includes(normalizedMethod) && routePattern(route.path).test(pathname),
  )
}

function readRouteManifest(path: string): readonly SwiftStudioManifestRoute[] {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new TypeError('Swift Studio route manifest cannot be read')
  }
  const manifest = z
    .object({
      schema_version: z.literal(1),
      upstream_commit: z.literal(MS_SWIFT_UPSTREAM_COMMIT),
      gradio_version: z.literal(SWIFT_STUDIO_GRADIO_VERSION),
      root_path: z.literal(SWIFT_STUDIO_PROXY_PREFIX),
      route_count: z.literal(76),
      routes_sha256: z.literal(SWIFT_STUDIO_ROUTES_SHA256),
      routes: z.array(
        z
          .object({
            path: z.string().startsWith('/'),
            methods: z.array(z.string().min(1)).min(1),
            route_type: z.string().min(1),
            classification: z.string().min(1),
            proxy_required: z.literal(true),
          })
          .strict(),
      ),
    })
    .passthrough()
    .parse(value)
  if (manifest.routes.length !== manifest.route_count) {
    throw new TypeError('Swift Studio route manifest count does not match its routes')
  }
  if (stableSha256(manifest.routes) !== manifest.routes_sha256) {
    throw new TypeError('Swift Studio route manifest digest does not match its routes')
  }
  const keys = new Set<string>()
  for (const route of manifest.routes) {
    for (const method of route.methods) {
      const key = `${method.toUpperCase()} ${route.path}`
      if (keys.has(key)) throw new TypeError(`Swift Studio route manifest duplicates ${key}`)
      keys.add(key)
    }
  }
  return manifest.routes
}

function stableSha256(value: unknown): string {
  return createHash('sha256')
    .update(Buffer.from(stableJson(value), 'utf8'))
    .digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('Swift Studio route manifest is not JSON')
  return serialized
}

function routePattern(template: string): RegExp {
  let source = '^'
  let cursor = 0
  const placeholder = /\{[A-Za-z_][A-Za-z0-9_]*(?::path)?\}/g
  for (const match of template.matchAll(placeholder)) {
    const index = match.index ?? 0
    source += escapeRegex(template.slice(cursor, index))
    source += match[0].endsWith(':path}') ? '.+' : '[^/]+'
    cursor = index + match[0].length
  }
  source += `${escapeRegex(template.slice(cursor))}$`
  return new RegExp(source, 'u')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parsePrivateHttpOrigin(value: string, defaultPort: number): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Swift Studio internal URL must be a valid HTTP origin')
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
    throw new TypeError('Swift Studio internal URL must be a private HTTP origin')
  }
  if (parsed.port === '') parsed.port = String(defaultPort)
  return parsed.origin
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (
    host === 'api' ||
    host === 'host.docker.internal' ||
    host === 'swift-studio' ||
    host === 'localhost'
  ) {
    return true
  }
  if (isIP(host) === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd')
  if (isIP(host) !== 4) return false
  const [first, second] = host.split('.').map(Number)
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}
