import i18n from '../i18n/index.js'

export interface ApiErrorInit {
  status: number
  code: string
  message: string
  detail?: unknown
  body?: unknown
  cause?: unknown
  requestId?: string
}

export class ApiError extends Error {
  readonly body?: unknown
  readonly code: string
  readonly detail?: unknown
  readonly requestId?: string
  readonly status: number

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code

    if ('detail' in init) {
      this.detail = init.detail
    }

    if ('body' in init) {
      this.body = init.body
    }

    if ('requestId' in init) {
      this.requestId = init.requestId
    }
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

export function isNotJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')
  return contentType === null || !contentType.toLowerCase().includes('application/json')
}

export function networkApiError(cause: unknown): ApiError {
  return new ApiError({
    status: 0,
    code: 'unreachable',
    message: i18n.t('errors.unreachable'),
    cause,
  })
}

export async function ensureJsonResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    throw await responseToApiError(response)
  }

  if (isNotJsonResponse(response)) {
    throw new ApiError({
      status: response.status,
      code: 'not_databench',
      message: i18n.t('errors.notDatabench'),
      body: await safeReadBody(response),
    })
  }

  return response
}

export async function responseToApiError(response: Response): Promise<ApiError> {
  return apiErrorFromBody(
    response.status,
    await safeReadBody(response),
    response.headers.get('X-Request-ID') ?? undefined,
  )
}

export function apiErrorFromBody(status: number, body: unknown, requestId?: string): ApiError {
  const envelope = readErrorEnvelope(body)

  if (envelope !== null) {
    return new ApiError({
      status,
      code: envelope.code,
      message: envelope.message,
      detail: envelope.detail,
      body,
      ...(requestId === undefined ? {} : { requestId }),
    })
  }

  const code = errorCodeForStatus(status)

  return new ApiError({
    status,
    code,
    message: messageForStatus(status),
    body,
    ...(requestId === undefined ? {} : { requestId }),
  })
}

export function errorCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request'
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 405:
      return 'method_not_allowed'
    case 409:
      return 'conflict'
    case 422:
      return 'validation_error'
    case 429:
      return 'too_many_requests'
    case 500:
      return 'internal_error'
    case 501:
      return 'not_implemented'
    default:
      return 'error'
  }
}

export function messageForStatus(status: number): string {
  switch (status) {
    case 400:
      return i18n.t('errors.badRequest')
    case 404:
      return i18n.t('errors.notFound')
    case 422:
      return i18n.t('errors.validation')
    case 501:
      return i18n.t('errors.notImplemented')
    default:
      return i18n.t('errors.generic', { status })
  }
}

async function safeReadBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '')

  if (text === '') {
    return undefined
  }

  if (isNotJsonResponse(response)) {
    return text
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function readErrorEnvelope(
  body: unknown,
): { code: string; detail?: unknown; message: string } | null {
  if (!isRecord(body) || !isRecord(body.error)) {
    return null
  }

  const { code, detail, message } = body.error

  if (typeof code !== 'string' || typeof message !== 'string') {
    return null
  }

  if ('detail' in body.error) {
    return { code, detail, message }
  }

  return { code, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
