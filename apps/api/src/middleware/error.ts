import {
  BadRequestDetailV2Schema,
  CapacityExceededDetailV2Schema,
  classifyError,
  DeterminismConflictDetailV2Schema,
  DomainError,
  type ErrorClass,
  ErrorResponseSchema,
  ErrorResponseV2Schema,
  EvaluationRunStateConflictDetailV2Schema,
  FidelityErrorDetailV2Schema,
  IdentityConflictDetailV2Schema,
  IntegrityErrorDetailV2Schema,
  LayoutConflictDetailV2Schema,
  ModelRegistryConflictDetailV2Schema,
  NotFoundDetailV2Schema,
  RefConflictDetailV2Schema,
  RefStateConflictDetailV2Schema,
  ResourceLimitDetailV2Schema,
  ServiceUnavailableDetailV2Schema,
  SwiftStudioSessionStateConflictDetailV2Schema,
  TransformJobStateConflictDetailV2Schema,
  UnsupportedProfileDetailV2Schema,
  ValidationErrorDetailV2Schema,
} from '@databench/schema'
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import type { ApiEnv } from '../context.js'

type ErrorCode =
  | 'bad_request'
  | 'capacity_exceeded'
  | 'conflict'
  | 'determinism_conflict'
  | 'error'
  | 'evaluation_run_state_conflict'
  | 'fidelity_error'
  | 'forbidden'
  | 'identity_conflict'
  | 'integrity_error'
  | 'internal_error'
  | 'layout_conflict'
  | 'model_registry_conflict'
  | 'method_not_allowed'
  | 'not_found'
  | 'resource_limit'
  | 'ref_conflict'
  | 'ref_state_conflict'
  | 'service_unavailable'
  | 'swift_studio_session_state_conflict'
  | 'too_many_requests'
  | 'transform_job_state_conflict'
  | 'unauthorized'
  | 'unprocessable_entity'
  | 'unsupported_profile'
  | 'validation_error'

interface ErrorEnvelopeOptions {
  readonly code: ErrorCode
  readonly message: string
  readonly status: ContentfulStatusCode
  readonly detail?: unknown
}

const STATUS_CODES = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  payloadTooLarge: 413,
  unprocessableEntity: 422,
  tooManyRequests: 429,
  internalError: 500,
  serviceUnavailable: 503,
} as const

const HTTP_STATUS_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'resource_limit',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
  500: 'internal_error',
  503: 'service_unavailable',
}

// HTTP status per shared taxonomy class (see @databench/schema classifyError).
const STATUS_FOR: Record<ErrorClass, ContentfulStatusCode> = {
  not_found: 404,
  conflict: 409,
  validation_error: 422,
  unsupported_profile: 422,
  bad_request: 400,
  resource_limit: 413,
  capacity_exceeded: 503,
  integrity_error: 500,
  service_unavailable: 503,
  internal_error: 500,
}

export function installErrorHandlers(app: {
  onError: (handler: ErrorHandler<ApiEnv>) => unknown
  notFound: (handler: NotFoundHandler<ApiEnv>) => unknown
}): void {
  app.notFound(notFoundHandler)
  app.onError(errorHandler)
}

export const notFoundHandler: NotFoundHandler<ApiEnv> = (context) =>
  errorResponse(context, {
    status: STATUS_CODES.notFound,
    code: 'not_found',
    message: 'Not Found',
  })

export const errorHandler: ErrorHandler<ApiEnv> = (error, context) => {
  if (error instanceof HTTPException) {
    return httpExceptionResponse(error, context)
  }

  // ZodError carries structured issues, so shape its detail specifically before
  // falling back to the shared taxonomy for everything else.
  if (error instanceof ZodError) {
    return validationErrorResponse(context, 'payload validation failed', error)
  }

  if (error instanceof DomainError) {
    const errorClass = classifyError(error)
    const status = STATUS_FOR[errorClass]
    if (isV2Request(context) && error.code === 'conflict') {
      return errorResponse(context, {
        status: STATUS_CODES.internalError,
        code: 'internal_error',
        message: 'internal server error',
      })
    }
    return errorResponse(context, {
      status,
      code: error.code as ErrorCode,
      message: error.message,
      detail: error.detail,
    })
  }

  // Only explicitly typed domain, HTTP, and Zod failures may expose their
  // message. Untyped dependency/runtime failures are always sanitized.
  return errorResponse(context, {
    status: STATUS_CODES.internalError,
    code: 'internal_error',
    message: 'internal server error',
  })
}

export function validationErrorResponse(
  context: Context<ApiEnv>,
  message: string,
  error: ZodError,
): Response {
  return errorResponse(context, {
    status: STATUS_CODES.unprocessableEntity,
    code: 'validation_error',
    message,
    detail: isV2Request(context) ? { issues: zodIssues(error) } : error.issues,
  })
}

export function errorResponse(context: Context<ApiEnv>, options: ErrorEnvelopeOptions): Response {
  const response = isV2Request(context)
    ? ErrorResponseV2Schema.parse({ error: normalizeV2Error(context, options) })
    : ErrorResponseSchema.parse({
        error: {
          code: options.code,
          message: options.message,
          ...(options.detail !== undefined ? { detail: options.detail } : {}),
        },
      })

  return context.json(response, options.status)
}

function httpExceptionResponse(error: HTTPException, context: Context<ApiEnv>): Response {
  return errorResponse(context, {
    status: error.status,
    code: HTTP_STATUS_CODE[error.status] ?? 'error',
    message: error.message,
  })
}

function isV2Request(context: Context<ApiEnv>): boolean {
  const pathname = new URL(context.req.url).pathname
  return pathname.startsWith('/v2/') || pathname.startsWith('/mcp-files/')
}

function normalizeV2Error(
  context: Context<ApiEnv>,
  options: ErrorEnvelopeOptions,
): {
  readonly code: string
  readonly message: string
  readonly detail: unknown
} {
  const message = boundedMessage(options.message)
  const detail = options.detail
  switch (options.code) {
    case 'bad_request':
      return {
        code: 'bad_request',
        message,
        detail: normalizeIssuesDetail(BadRequestDetailV2Schema, detail, message, 'bad_request'),
      }
    case 'validation_error':
    case 'unprocessable_entity':
      return {
        code: 'validation_error',
        message,
        detail: normalizeIssuesDetail(
          ValidationErrorDetailV2Schema,
          detail,
          message,
          'validation_error',
        ),
      }
    case 'resource_limit':
      return {
        code: 'resource_limit',
        message,
        detail: normalizeResourceLimit(detail, message),
      }
    case 'capacity_exceeded':
      return {
        code: 'capacity_exceeded',
        message,
        detail: normalizeCapacityExceeded(detail),
      }
    case 'not_found':
      return {
        code: 'not_found',
        message,
        detail: normalizeNotFound(context, detail),
      }
    case 'identity_conflict':
      return {
        code: 'identity_conflict',
        message,
        detail: IdentityConflictDetailV2Schema.safeParse(detail).data ?? {
          reason: 'claim_request_mismatch',
        },
      }
    case 'determinism_conflict':
      return {
        code: 'determinism_conflict',
        message,
        detail: DeterminismConflictDetailV2Schema.parse(detail),
      }
    case 'layout_conflict':
      return {
        code: 'layout_conflict',
        message,
        detail: LayoutConflictDetailV2Schema.safeParse(detail).data ?? {
          reason: 'layout_conflict',
        },
      }
    case 'model_registry_conflict':
      return {
        code: 'model_registry_conflict',
        message,
        detail: ModelRegistryConflictDetailV2Schema.parse(detail),
      }
    case 'ref_conflict':
      return {
        code: 'ref_conflict',
        message,
        detail: RefConflictDetailV2Schema.parse(detail),
      }
    case 'ref_state_conflict':
      return {
        code: 'ref_state_conflict',
        message,
        detail: RefStateConflictDetailV2Schema.parse(detail),
      }
    case 'transform_job_state_conflict':
      return {
        code: 'transform_job_state_conflict',
        message,
        detail: TransformJobStateConflictDetailV2Schema.parse(detail),
      }
    case 'evaluation_run_state_conflict':
      return {
        code: 'evaluation_run_state_conflict',
        message,
        detail: EvaluationRunStateConflictDetailV2Schema.parse(detail),
      }
    case 'swift_studio_session_state_conflict':
      return {
        code: 'swift_studio_session_state_conflict',
        message,
        detail: SwiftStudioSessionStateConflictDetailV2Schema.parse(detail),
      }
    case 'unsupported_profile':
      return {
        code: 'unsupported_profile',
        message,
        detail: normalizeUnsupportedProfile(detail),
      }
    case 'fidelity_error':
      return {
        code: 'fidelity_error',
        message,
        detail: FidelityErrorDetailV2Schema.parse(detail),
      }
    case 'integrity_error':
      return {
        code: 'integrity_error',
        message,
        detail: normalizeIntegrity(detail),
      }
    case 'unauthorized':
      return {
        code: 'unauthorized',
        message,
        detail: {
          reason: message.toLowerCase().includes('missing')
            ? 'credentials_missing'
            : 'credentials_invalid',
        },
      }
    case 'forbidden':
      return {
        code: 'forbidden',
        message,
        detail: { reason: 'workspace_access_denied' },
      }
    case 'too_many_requests':
      return {
        code: 'too_many_requests',
        message,
        detail: normalizeTooManyRequests(detail),
      }
    case 'service_unavailable':
      return {
        code: 'service_unavailable',
        message,
        detail: normalizeServiceUnavailable(detail),
      }
    case 'conflict':
    case 'error':
    case 'internal_error':
    case 'method_not_allowed':
      return {
        code: 'internal_error',
        message: 'internal server error',
        detail: { reason: 'unexpected_error' },
      }
  }
}

function normalizeTooManyRequests(detail: unknown) {
  const value = asRecord(detail)?.retry_after_seconds
  return {
    retry_after_seconds:
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null,
  }
}

function normalizeIssuesDetail(
  schema: typeof BadRequestDetailV2Schema | typeof ValidationErrorDetailV2Schema,
  detail: unknown,
  message: string,
  fallbackCode: string,
) {
  const parsed = schema.safeParse(detail)
  if (parsed.success) return parsed.data
  const record = asRecord(detail)
  const candidates = Array.isArray(record?.issues)
    ? record.issues
    : Array.isArray(detail)
      ? detail
      : []
  const issues = candidates
    .slice(0, 1_024)
    .map((issue) => normalizeIssue(issue, message, fallbackCode))
  const directReason = normalizeOptionalToken(record?.reason)
  return schema.parse({
    issues:
      issues.length > 0
        ? issues
        : [
            {
              path: '',
              line: null,
              code: directReason ?? normalizeToken(fallbackCode),
              message,
            },
          ],
  })
}

function normalizeResourceLimit(detail: unknown, message: string) {
  const parsed = ResourceLimitDetailV2Schema.safeParse(detail)
  if (parsed.success) return parsed.data
  const record = asRecord(detail)
  const issues =
    Array.isArray(record?.issues) && record.issues.length > 0
      ? record.issues
          .slice(0, 1_024)
          .map((issue) => normalizeIssue(issue, message, 'resource_limit'))
      : undefined
  return ResourceLimitDetailV2Schema.parse({
    resource: normalizeToken(record?.resource, 'unknown'),
    limit: nonNegativeSafeInteger(record?.limit),
    actual: quantity(record?.actual),
    ...(issues === undefined ? {} : { issues }),
  })
}

function normalizeCapacityExceeded(detail: unknown) {
  const parsed = CapacityExceededDetailV2Schema.safeParse(detail)
  if (parsed.success) return parsed.data
  const record = asRecord(detail)
  if (record?.required !== undefined || record?.available !== undefined) {
    return CapacityExceededDetailV2Schema.parse({
      resource: normalizeToken(record.resource, 'unknown'),
      required: quantity(record.required),
      available: quantity(record.available),
    })
  }
  return CapacityExceededDetailV2Schema.parse({
    resource: normalizeToken(record?.resource, 'unknown'),
    limit: quantity(record?.limit),
    actual: quantity(record?.actual),
  })
}

function normalizeNotFound(context: Context<ApiEnv>, detail: unknown) {
  const parsed = NotFoundDetailV2Schema.safeParse(detail)
  if (parsed.success) return parsed.data
  const record = asRecord(detail)
  if (typeof record?.record_id === 'string') {
    return { kind: 'record' as const, value: boundedValue(record.record_id) }
  }
  for (const [key, kind] of [
    ['ref_name', 'ref'],
    ['dataset_version', 'dataset'],
    ['converter', 'converter'],
    ['transform', 'transform'],
    ['run_id', 'evaluation_run'],
  ] as const) {
    const value = record?.[key]
    if (typeof value === 'string') {
      return { kind, value: boundedValue(value) }
    }
  }
  const pathname = new URL(context.req.url).pathname
  return {
    kind: 'route' as const,
    value: pathname.startsWith('/mcp-files/') ? '/mcp-files/*' : boundedValue(pathname),
  }
}

function normalizeUnsupportedProfile(detail: unknown) {
  const parsed = UnsupportedProfileDetailV2Schema.safeParse(detail)
  if (parsed.success) return parsed.data
  const record = asRecord(detail)
  return UnsupportedProfileDetailV2Schema.parse({
    kind: isProfileKind(record?.kind) ? record.kind : 'identity',
    value: boundedValue(typeof record?.value === 'string' ? record.value : 'unknown', 128),
    supported: Array.isArray(record?.supported)
      ? record.supported
          .filter((value): value is string => typeof value === 'string')
          .slice(0, 64)
          .map((value) => boundedValue(value, 128))
      : [],
  })
}

function normalizeIntegrity(detail: unknown) {
  const parsed = IntegrityErrorDetailV2Schema.safeParse(detail)
  if (parsed.success) return parsed.data
  const record = asRecord(detail)
  const datasetVersion =
    typeof record?.dataset_version === 'string' && /^[0-9a-f]{64}$/.test(record.dataset_version)
      ? record.dataset_version
      : undefined
  const layoutVersion =
    typeof record?.layout_version === 'string'
      ? boundedValue(record.layout_version, 128)
      : undefined
  return IntegrityErrorDetailV2Schema.parse({
    reason: normalizeToken(record?.reason, 'integrity_check_failed'),
    ...(datasetVersion === undefined ? {} : { dataset_version: datasetVersion }),
    ...(layoutVersion === undefined ? {} : { layout_version: layoutVersion }),
  })
}

function normalizeServiceUnavailable(detail: unknown) {
  const parsed = ServiceUnavailableDetailV2Schema.safeParse(detail)
  if (parsed.success) return parsed.data
  const record = asRecord(detail)
  const dependency =
    record?.provider === 's3' || record?.provider === 'oss'
      ? 'object_store'
      : record?.dependency === 'catalog'
        ? 'postgres'
        : record?.dependency === 'postgres' ||
            record?.dependency === 'object_store' ||
            record?.dependency === 'worker'
          ? record.dependency
          : 'unknown'
  return ServiceUnavailableDetailV2Schema.parse({ dependency, retryable: true })
}

function zodIssues(error: ZodError) {
  return error.issues.slice(0, 1_024).map((issue) => ({
    path: jsonPointer(issue.path),
    line: null,
    code: normalizeToken(issue.code),
    message: boundedMessage(issue.message),
  }))
}

function normalizeIssue(issue: unknown, fallbackMessage: string, fallbackCode: string) {
  const record = asRecord(issue)
  return {
    path:
      typeof record?.path === 'string'
        ? boundedValue(record.path, 1_024)
        : Array.isArray(record?.path)
          ? jsonPointer(record.path)
          : '',
    line:
      typeof record?.line === 'number' && Number.isSafeInteger(record.line) && record.line > 0
        ? record.line
        : null,
    code: normalizeToken(record?.code, fallbackCode),
    message: boundedMessage(typeof record?.message === 'string' ? record.message : fallbackMessage),
  }
}

function jsonPointer(path: readonly unknown[]): string {
  if (path.length === 0) return ''
  return `/${path
    .map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`.slice(0, 1_024)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeToken(value: unknown, fallback = 'unknown'): string {
  if (typeof value === 'string' && /^[a-z][a-z0-9._-]{0,127}$/.test(value)) return value
  return fallback
}

function normalizeOptionalToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,127}$/.test(value) ? value : undefined
}

function boundedMessage(value: string): string {
  const bounded = value.slice(0, 2_048)
  return bounded.length > 0 ? bounded : 'request failed'
}

function boundedValue(value: string, max = 512): string {
  const bounded = value.slice(0, max)
  return bounded.length > 0 ? bounded : 'unknown'
}

function nonNegativeSafeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function quantity(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,63})$/.test(value)) return value
  return 0
}

function isProfileKind(
  value: unknown,
): value is 'identity' | 'record_schema' | 'layout' | 'export_fidelity' {
  return (
    value === 'identity' ||
    value === 'record_schema' ||
    value === 'layout' ||
    value === 'export_fidelity'
  )
}
