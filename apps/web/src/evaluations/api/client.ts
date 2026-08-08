import type { output } from 'zod'
import { getApiBaseUrl, getStoredToken } from '../../api/config.js'
import { EVALSCOPE_CLIENT_CONFIG, EVALSCOPE_PLOTLY_ASSET_SHA256 } from './config.js'
import { EvalScopeApiError } from './errors.js'
import {
  EVALSCOPE_JSON_OPERATIONS,
  EVALSCOPE_NON_JSON_ROUTES,
  type EvalScopeJsonOperation,
} from './routes.js'
import { type GeneratedDocumentDescriptor, generatedDocumentDescriptorSchema } from './schemas.js'

type QueryPrimitive = boolean | number | string | undefined
type OperationDescriptor<K extends EvalScopeJsonOperation> = (typeof EVALSCOPE_JSON_OPERATIONS)[K]
type QueryKey<K extends EvalScopeJsonOperation> = OperationDescriptor<K>['query'][number]
type OperationOutput<K extends EvalScopeJsonOperation> = output<OperationDescriptor<K>['schema']>

export type EvalScopeRequestOptions<K extends EvalScopeJsonOperation> = {
  readonly body?: Record<string, unknown>
  readonly query?: Partial<Record<QueryKey<K>, QueryPrimitive>>
  readonly signal?: AbortSignal
  readonly taskId?: string
}

export interface EvalScopeClient {
  generatedDocumentUrl(descriptor: GeneratedDocumentDescriptor): string
  mediaUrl(locator: string): string
  plotlyAssetUrl(): string
  request<K extends EvalScopeJsonOperation>(
    operation: K,
    options?: EvalScopeRequestOptions<K>,
  ): Promise<OperationOutput<K>>
}

const TASK_ID =
  /^(?:eval|perf)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const RELATIVE_LOCATOR = /^[^\\]{1,2048}$/u

export function createEvalScopeClient(
  fetchImplementation: typeof fetch = globalThis.fetch,
  getAccessToken: () => string = () => getStoredToken(getApiBaseUrl()),
): EvalScopeClient {
  return {
    async request<K extends EvalScopeJsonOperation>(
      operationName: K,
      options: EvalScopeRequestOptions<K> = {},
    ): Promise<OperationOutput<K>> {
      const descriptor = EVALSCOPE_JSON_OPERATIONS[operationName]
      const url = buildOperationUrl(descriptor, options.query)
      const init = buildRequestInit(descriptor, options, getAccessToken())
      let response: Response

      try {
        response = await fetchImplementation(url, init)
      } catch (error) {
        if (isAbortError(error)) {
          throw new EvalScopeApiError('aborted', 'EvalScope request was aborted')
        }
        throw new EvalScopeApiError(
          'network',
          error instanceof Error ? error.message : 'EvalScope network request failed',
        )
      }

      if (!response.ok) {
        throw await responseError(response, operationName)
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
      if (contentType !== 'application/json') {
        throw new EvalScopeApiError('validation', 'EvalScope returned a non-JSON response')
      }
      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new EvalScopeApiError('validation', 'EvalScope returned malformed JSON')
      }
      const parsed = descriptor.schema.safeParse(data)
      if (!parsed.success) {
        throw new EvalScopeApiError(
          'validation',
          `EvalScope response validation failed: ${parsed.error.message}`,
        )
      }
      return parsed.data as OperationOutput<K>
    },
    generatedDocumentUrl(input: GeneratedDocumentDescriptor): string {
      const descriptor = generatedDocumentDescriptorSchema.parse(input)
      return `${EVALSCOPE_CLIENT_CONFIG.gatewayBase}/generated-documents/${descriptor.document_id}`
    },
    mediaUrl(locator: string): string {
      assertRelativeLocator(locator)
      const query = new URLSearchParams({ path: locator })
      return `${EVALSCOPE_CLIENT_CONFIG.apiBase}${EVALSCOPE_NON_JSON_ROUTES.media}?${query}`
    },
    plotlyAssetUrl(): string {
      return `${EVALSCOPE_CLIENT_CONFIG.gatewayBase}/generated-assets/plotly-${EVALSCOPE_PLOTLY_ASSET_SHA256}.min.js`
    },
  }
}

export const evalScopeClient = createEvalScopeClient()

function buildOperationUrl<K extends EvalScopeJsonOperation>(
  descriptor: OperationDescriptor<K>,
  query: EvalScopeRequestOptions<K>['query'],
): string {
  const base =
    descriptor.scope === 'gateway'
      ? EVALSCOPE_CLIENT_CONFIG.gatewayBase
      : EVALSCOPE_CLIENT_CONFIG.apiBase
  const params = new URLSearchParams()
  const allowed = new Set<string>(descriptor.query)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (!allowed.has(key)) {
      throw new EvalScopeApiError('validation', `Unreviewed EvalScope query field: ${key}`)
    }
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const encoded = params.toString()
  return `${base}${descriptor.path}${encoded === '' ? '' : `?${encoded}`}`
}

function buildRequestInit<K extends EvalScopeJsonOperation>(
  descriptor: OperationDescriptor<K>,
  options: EvalScopeRequestOptions<K>,
  accessToken: string,
): RequestInit {
  const headers = new Headers({ accept: 'application/json' })
  const token = accessToken.trim()
  if (token !== '') headers.set('authorization', `Bearer ${token}`)
  const expectsBody = 'requestBody' in descriptor && descriptor.requestBody === 'json'
  if (expectsBody !== (options.body !== undefined)) {
    throw new EvalScopeApiError(
      'validation',
      expectsBody
        ? 'EvalScope invoke requires a JSON body'
        : 'This EvalScope operation rejects a body',
    )
  }
  if (expectsBody) {
    if (options.taskId === undefined || !TASK_ID.test(options.taskId)) {
      throw new EvalScopeApiError('validation', 'EvalScope invoke requires a valid task ID')
    }
    headers.set('content-type', 'application/json')
    headers.set('evalscope-task-id', options.taskId)
  } else if (options.taskId !== undefined) {
    throw new EvalScopeApiError('validation', 'This EvalScope operation rejects a task header')
  }
  return {
    method: descriptor.method,
    headers,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }
}

async function responseError(
  response: Response,
  operation: EvalScopeJsonOperation,
): Promise<EvalScopeApiError> {
  let code: string | undefined
  let field: string | undefined
  let message = `EvalScope request failed with HTTP ${response.status}`
  try {
    const body = (await response.json()) as unknown
    if (isRecord(body) && isRecord(body.error)) {
      if (typeof body.error.code === 'string') code = body.error.code
      if (typeof body.error.field === 'string') field = body.error.field
      if (typeof body.error.message === 'string') message = body.error.message
    }
  } catch {
    // A typed status is still more useful than an untrusted error body.
  }
  const unavailable =
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504 ||
    (operation === 'config' && response.status === 404)
  const kind = unavailable ? 'unavailable' : response.status >= 500 ? 'http-5xx' : 'http-4xx'
  return new EvalScopeApiError(kind, message, {
    ...(code === undefined ? {} : { code }),
    ...(field === undefined ? {} : { field }),
    status: response.status,
  })
}

function assertRelativeLocator(locator: string): void {
  if (
    !RELATIVE_LOCATOR.test(locator) ||
    containsControlCharacter(locator) ||
    locator.startsWith('/') ||
    locator.split('/').includes('..') ||
    /^[A-Za-z]:/u.test(locator) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(locator)
  ) {
    throw new EvalScopeApiError('validation', 'EvalScope media locator is invalid')
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
