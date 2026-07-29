import { ResourceLimitError } from '@databench/schema'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiEnv } from '../context.js'
import { readBoundedRequestBodyV2 } from '../routes/v2/transport.js'
import type { EvalScopeGatewayConfig } from './config.js'
import {
  EVALSCOPE_PLOTLY_ASSET_SHA256,
  EVALSCOPE_PROXY_ROUTES,
  type EvalScopeProxyRoute,
} from './routes.js'

const TASK_ID =
  /^(?:eval|perf)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const OPAQUE_DOCUMENT_ID = /^[A-Za-z0-9_-]{43}$/
const URI_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:/
const MAX_QUERY_BYTES = 8192
const RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-range',
  'content-security-policy',
  'content-type',
  'cross-origin-resource-policy',
  'etag',
  'last-modified',
  'referrer-policy',
  'x-content-type-options',
  'x-frame-options',
])

export interface RegisterEvalScopeGatewayOptions {
  readonly config: EvalScopeGatewayConfig
  readonly fetch?: typeof fetch
}

export function registerEvalScopeGateway(
  app: OpenAPIHono<ApiEnv>,
  options: RegisterEvalScopeGatewayOptions,
): void {
  if (!options.config.enabled) return
  if (options.config.internalBaseUrl === undefined) {
    throw new TypeError('Enabled EvalScope gateway requires an internal base URL')
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch
  for (const route of EVALSCOPE_PROXY_ROUTES) {
    const publicPath = `${options.config.proxyPrefix}${honoPath(route.path)}`
    app.on(route.method, publicPath, async (context) =>
      proxyEvalScope(context, route, options.config, fetchImplementation),
    )
  }
}

async function proxyEvalScope(
  context: Context<ApiEnv>,
  route: EvalScopeProxyRoute,
  config: EvalScopeGatewayConfig,
  fetchImplementation: typeof fetch,
): Promise<Response> {
  let query: URLSearchParams
  try {
    query = validateQuery(context, route)
  } catch (error) {
    if (error instanceof ResourceLimitError) {
      return gatewayError(context, 413, 'query_too_large', 'EvalScope query is too large')
    }
    return gatewayError(context, 422, 'query_invalid', 'EvalScope query is invalid')
  }
  const upstreamPath = resolveUpstreamPath(context, route)
  if (upstreamPath === null) {
    return gatewayError(context, 404, 'not_found', 'Generated document was not found')
  }
  if (route.response === 'document' && context.req.header('sec-fetch-dest') !== 'iframe') {
    return gatewayError(
      context,
      403,
      'generated_document_context_rejected',
      'Generated documents require the sandbox viewer',
    )
  }

  let requestBody: Uint8Array | undefined
  if (route.requestBody === 'json') {
    const mediaType = context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      return gatewayError(
        context,
        415,
        'unsupported_media_type',
        'EvalScope invoke requires Content-Type application/json',
      )
    }
    try {
      requestBody = await readBoundedRequestBodyV2(context.req.raw, config.requestMaxBytes)
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        return gatewayError(context, 413, 'request_too_large', 'EvalScope request is too large')
      }
      throw error
    }
    if (!validateJsonObject(requestBody)) {
      return gatewayError(
        context,
        400,
        'invalid_json',
        'EvalScope invoke body must be a JSON object',
      )
    }
    const taskId = context.req.header('evalscope-task-id')
    if (taskId === undefined || !TASK_ID.test(taskId)) {
      return gatewayError(context, 400, 'invalid_task_id', 'EvalScope-Task-Id is invalid')
    }
  } else if (await hasRequestBody(context.req.raw)) {
    return gatewayError(
      context,
      400,
      'unexpected_request_body',
      'This EvalScope route does not accept a body',
    )
  }

  const target = new URL(upstreamPath, config.internalBaseUrl)
  target.search = query.toString()
  const headers = new Headers({ accept: route.response === 'json' ? 'application/json' : '*/*' })
  if (requestBody !== undefined) {
    headers.set('content-type', 'application/json')
    headers.set('evalscope-task-id', context.req.header('evalscope-task-id') as string)
  }
  if (route.response === 'document') {
    headers.set('sec-fetch-dest', 'iframe')
  }
  const timeout = route.invoke ? config.invokeTimeoutMs : config.timeoutMs
  const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(timeout)])
  let upstream: Response
  try {
    upstream = await fetchImplementation(target, {
      method: route.method,
      headers,
      ...(requestBody === undefined ? {} : { body: exactArrayBuffer(requestBody) }),
      redirect: 'manual',
      signal,
    })
  } catch {
    return gatewayError(context, 503, 'evalscope_unavailable', 'EvalScope backend is unavailable')
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    void upstream.body?.cancel().catch(() => undefined)
    return gatewayError(
      context,
      502,
      'evalscope_redirect_rejected',
      'EvalScope redirect was rejected',
    )
  }

  let bytes: Uint8Array
  try {
    bytes = await readBoundedResponse(upstream, config.responseMaxBytes)
  } catch {
    return gatewayError(
      context,
      502,
      'evalscope_response_invalid',
      'EvalScope response exceeded its boundary',
    )
  }
  if (!validResponseType(route, upstream)) {
    return gatewayError(
      context,
      502,
      'evalscope_response_invalid',
      'EvalScope returned an invalid media type',
    )
  }
  const responseHeaders = new Headers()
  for (const [name, value] of upstream.headers) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value)
  }
  responseHeaders.set('x-content-type-options', 'nosniff')
  if (route.response !== 'asset') responseHeaders.set('cache-control', 'private, no-store')
  return new Response(exactArrayBuffer(bytes), {
    status: upstream.status,
    headers: responseHeaders,
  })
}

function honoPath(path: string): string {
  return path.replace('{opaque_id}', ':opaqueId').replace('{sha256}', EVALSCOPE_PLOTLY_ASSET_SHA256)
}

function resolveUpstreamPath(context: Context<ApiEnv>, route: EvalScopeProxyRoute): string | null {
  if (route.path.includes('{opaque_id}')) {
    const opaqueId = context.req.param('opaqueId')
    if (opaqueId === undefined || !OPAQUE_DOCUMENT_ID.test(opaqueId)) return null
    return `/generated-documents/${opaqueId}`
  }
  return route.path.replace('{sha256}', EVALSCOPE_PLOTLY_ASSET_SHA256)
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

function validateQuery(context: Context<ApiEnv>, route: EvalScopeProxyRoute): URLSearchParams {
  const parsed = new URL(context.req.url)
  if (new TextEncoder().encode(parsed.search).byteLength > MAX_QUERY_BYTES) {
    throw new ResourceLimitError('EvalScope query exceeds its byte limit', {
      resource: 'query_bytes',
      limit: MAX_QUERY_BYTES,
      actual: parsed.search.length,
    })
  }
  const allowed = new Set(route.query)
  for (const key of parsed.searchParams.keys()) {
    if (!allowed.has(key) || parsed.searchParams.getAll(key).length !== 1) {
      throw new TypeError('EvalScope query contains an unreviewed or duplicate field')
    }
  }
  validateQueryValues(route.path, parsed.searchParams)
  return parsed.searchParams
}

function validateQueryValues(path: string, query: URLSearchParams): void {
  const required: Record<string, readonly string[]> = {
    '/api/v1/eval/stop': ['task_id'],
    '/api/v1/eval/progress': ['task_id'],
    '/api/v1/eval/log': ['task_id'],
    '/api/v1/eval/report': ['task_id'],
    '/api/v1/perf/stop': ['task_id'],
    '/api/v1/perf/progress': ['task_id'],
    '/api/v1/perf/log': ['task_id'],
    '/api/v1/perf/report': ['task_id'],
    '/api/v1/perf/detail': ['path'],
    '/api/v1/perf/chart': ['path'],
    '/api/v1/perf/compare/chart': ['paths'],
    '/api/v1/perf/runs': ['path'],
    '/api/v1/perf/requests': ['path', 'run'],
    '/api/v1/perf/history/report': ['path'],
    '/api/v1/reports/load': ['report_name'],
    '/api/v1/reports/load_multi': ['report_names'],
    '/api/v1/reports/dataframe': ['report_name'],
    '/api/v1/reports/predictions': ['report_name', 'dataset_name', 'subset_name'],
    '/api/v1/reports/analysis': ['report_name', 'dataset_name'],
    '/api/v1/reports/html': ['report_name'],
    '/api/v1/reports/media/file': ['path'],
  }
  for (const field of required[path] ?? []) {
    if (!query.has(field) || query.get(field) === '')
      throw new TypeError(`Missing EvalScope query field: ${field}`)
  }
  const taskId = query.get('task_id')
  if (taskId !== null) {
    if (!TASK_ID.test(taskId)) throw new TypeError('Invalid EvalScope task ID')
    if (path.startsWith('/api/v1/eval/') !== taskId.startsWith('eval_')) {
      throw new TypeError('EvalScope task ID prefix does not match route')
    }
  }
  for (const field of ['path', 'run', 'report_name']) {
    const value = query.get(field)
    if (value !== null) assertRelativeLocator(value)
  }
  for (const field of ['paths', 'report_names']) {
    const value = query.get(field)
    if (value === null) continue
    const items = value.split(';').filter(Boolean)
    if (items.length === 0 || items.length > 16) throw new TypeError(`Invalid EvalScope ${field}`)
    for (const item of items) assertRelativeLocator(item)
  }
  for (const field of ['start_line', 'page', 'page_size']) {
    const value = query.get(field)
    if (value === null) continue
    const number = Number(value)
    const minimum = field === 'start_line' ? 0 : 1
    const maximum = field === 'page_size' ? 500 : field === 'page' ? 1_000_000 : 100_000_000
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
      throw new TypeError(`Invalid EvalScope ${field}`)
    }
  }
  for (const field of ['score_min', 'score_max']) {
    const value = query.get(field)
    if (
      value !== null &&
      (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1)
    ) {
      throw new TypeError(`Invalid EvalScope ${field}`)
    }
  }
  for (const field of ['search', 'dataset_name', 'subset_name']) {
    const value = query.get(field)
    if (value !== null) assertBoundedText(value, field, 4096)
  }
  for (const field of ['models', 'datasets']) {
    const value = query.get(field)
    if (value === null) continue
    const items = value.split(';').filter(Boolean)
    if (items.length === 0 || items.length > 128) throw new TypeError(`Invalid EvalScope ${field}`)
    for (const item of items) assertBoundedText(item, field, 512)
  }
  validateEnum(query, 'all', ['true', 'false'])
  validateEnum(query, 'refresh', ['true', 'false'])
  validateEnum(query, 'theme', ['dark', 'light'])
  validateEnum(query, 'sort_by', ['score', 'model', 'dataset', 'time'])
  validateEnum(query, 'sort_order', ['asc', 'desc'])
  validateEnum(query, 'status', ['success', 'failed'])
  if (path === '/api/v1/eval/benchmarks') {
    validateEnum(query, 'type', ['', 'text', 'multimodal', 'agent', 'aigc'])
  }
  if (path === '/api/v1/reports/dataframe') {
    validateEnum(query, 'type', ['acc', 'compare', 'dataset'])
    if (query.get('type') === 'dataset' && !query.has('dataset_name')) {
      throw new TypeError('EvalScope dataset_name is required for a dataset dataframe')
    }
  }
  const sweepCharts = ['latency', 'ttft', 'tpot', 'rps', 'throughput', 'success'] as const
  const perRunCharts = [
    'percentile_latency',
    'percentile_token',
    'req_latency',
    'req_ttft_tpot',
    'req_tokens',
    'req_success',
  ] as const
  if (path === '/api/v1/perf/chart') {
    validateEnum(query, 'chart_type', [...sweepCharts, ...perRunCharts])
    if (
      perRunCharts.includes(query.get('chart_type') as (typeof perRunCharts)[number]) &&
      !query.has('run')
    ) {
      throw new TypeError('EvalScope run is required for a per-run performance chart')
    }
  }
  if (path === '/api/v1/perf/compare/chart') {
    validateEnum(query, 'chart_type', sweepCharts)
  }
  if (path === '/api/v1/reports/chart') {
    validateEnum(query, 'chart_type', [
      'scores',
      'sunburst',
      'dataset_scores',
      'radar',
      'histogram',
      'grouped_bar',
    ])
    validateReportChartQuery(query)
  }
}

function validateReportChartQuery(query: URLSearchParams): void {
  const chartType = query.get('chart_type') ?? 'scores'
  if (chartType === 'grouped_bar' && !query.has('report_names')) {
    throw new TypeError('EvalScope report_names is required for a grouped bar chart')
  }
  if (chartType === 'radar' && !query.has('report_names') && !query.has('report_name')) {
    throw new TypeError('EvalScope report_name or report_names is required for a radar chart')
  }
  if (
    chartType === 'histogram' &&
    (!query.has('report_name') || !query.has('dataset_name') || !query.has('subset_name'))
  ) {
    throw new TypeError('EvalScope report, dataset, and subset are required for a histogram')
  }
  if (!['radar', 'grouped_bar', 'histogram'].includes(chartType) && !query.has('report_name')) {
    throw new TypeError('EvalScope report_name is required for this chart')
  }
  if (chartType === 'dataset_scores' && !query.has('dataset_name')) {
    throw new TypeError('EvalScope dataset_name is required for a dataset chart')
  }
}

function assertBoundedText(value: string, field: string, maxBytes: number): void {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`Invalid EvalScope ${field}`)
  }
}

function assertRelativeLocator(value: string): void {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 2048 ||
    hasControlCharacter(value) ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('~') ||
    URI_LIKE.test(value) ||
    value.split('/').includes('..')
  ) {
    throw new TypeError('EvalScope locator must be a contained relative value')
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function validateEnum(query: URLSearchParams, field: string, choices: readonly string[]): void {
  const value = query.get(field)
  if (value !== null && !choices.includes(value)) throw new TypeError(`Invalid EvalScope ${field}`)
}

function validateJsonObject(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    let nodes = 0
    const visit = (node: unknown, depth: number): boolean => {
      nodes += 1
      if (nodes > 100_000 || depth > 64) return false
      if (Array.isArray(node)) return node.every((item) => visit(item, depth + 1))
      if (node !== null && typeof node === 'object') {
        return Object.entries(node).every(
          ([key, child]) =>
            new TextEncoder().encode(key).byteLength <= 1024 && visit(child, depth + 1),
        )
      }
      return typeof node !== 'number' || Number.isFinite(node)
    }
    return visit(value, 0)
  } catch {
    return false
  }
}

async function hasRequestBody(request: Request): Promise<boolean> {
  const length = request.headers.get('content-length')
  if (length !== null && length !== '0') return true
  if (request.body === null) return false
  const bytes = await readBoundedRequestBodyV2(request, 0).catch(() => new Uint8Array([1]))
  return bytes.byteLength !== 0
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxBytes)) {
    void response.body?.cancel().catch(() => undefined)
    throw new TypeError('EvalScope response is too large')
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        void reader.cancel().catch(() => undefined)
        throw new TypeError('EvalScope response is too large')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function validResponseType(route: EvalScopeProxyRoute, response: Response): boolean {
  if (response.status >= 400) return contentType(response) === 'application/json'
  const mediaType = contentType(response)
  if (route.response === 'json') return mediaType === 'application/json'
  if (route.response === 'document') return mediaType === 'text/html'
  if (route.response === 'asset') {
    return mediaType === 'application/javascript' || mediaType === 'text/javascript'
  }
  return (
    mediaType.startsWith('image/') ||
    mediaType.startsWith('audio/') ||
    mediaType.startsWith('video/')
  )
}

function contentType(response: Response): string {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function gatewayError(
  context: Context<ApiEnv>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  context.header('Cache-Control', 'private, no-store')
  context.header('X-Content-Type-Options', 'nosniff')
  return context.json({ error: { code, message } }, status)
}
