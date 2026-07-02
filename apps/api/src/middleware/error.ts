import { classifyError, DomainError, type ErrorClass, ErrorResponseSchema } from '@databench/schema'
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import type { ApiEnv } from '../context.js'

type ErrorCode =
  | 'bad_request'
  | 'conflict'
  | 'error'
  | 'forbidden'
  | 'internal_error'
  | 'method_not_allowed'
  | 'not_found'
  | 'too_many_requests'
  | 'unauthorized'
  | 'unprocessable_entity'
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
  unprocessableEntity: 422,
  tooManyRequests: 429,
  internalError: 500,
} as const

const HTTP_STATUS_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
  500: 'internal_error',
}

// HTTP status per shared taxonomy class (see @databench/schema classifyError).
const STATUS_FOR: Record<ErrorClass, ContentfulStatusCode> = {
  not_found: 404,
  conflict: 409,
  validation_error: 422,
  bad_request: 400,
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

  const errorClass = classifyError(error)
  const status = STATUS_FOR[errorClass]

  if (error instanceof DomainError) {
    return errorResponse(context, {
      status,
      code: error.code as ErrorCode,
      message: error.message,
      detail: error.detail,
    })
  }

  if (errorClass === 'internal_error') {
    // Don't leak internal failure messages over HTTP.
    return errorResponse(context, {
      status,
      code: 'internal_error',
      message: 'internal server error',
    })
  }

  return errorResponse(context, {
    status,
    code: errorClass,
    message: error instanceof Error ? error.message : 'error',
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
    detail: error.issues,
  })
}

export function errorResponse(context: Context<ApiEnv>, options: ErrorEnvelopeOptions): Response {
  const response = ErrorResponseSchema.parse({
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
