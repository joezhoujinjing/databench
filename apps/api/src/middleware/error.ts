import {
  BadInputError,
  ConflictError,
  type DomainError,
  ErrorResponseSchema,
  NotFoundError,
  ValidationError,
} from '@databench/schema'
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

  if (error instanceof ValidationError) {
    return errorResponse(context, {
      status: STATUS_CODES.unprocessableEntity,
      code: 'validation_error',
      message: error.message,
      detail: error.detail,
    })
  }

  if (error instanceof ZodError) {
    return validationErrorResponse(context, 'payload validation failed', error)
  }

  if (error instanceof NotFoundError) {
    return domainErrorResponse(context, error, STATUS_CODES.notFound)
  }

  if (error instanceof ConflictError) {
    return domainErrorResponse(context, error, STATUS_CODES.conflict)
  }

  if (error instanceof BadInputError || error instanceof TypeError || isPlainError(error)) {
    return errorResponse(context, {
      status: STATUS_CODES.badRequest,
      code: 'bad_request',
      message: error.message,
    })
  }

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

function domainErrorResponse(
  context: Context<ApiEnv>,
  error: DomainError,
  status: ContentfulStatusCode,
): Response {
  return errorResponse(context, {
    status,
    code: error.code as ErrorCode,
    message: error.message,
    detail: error.detail,
  })
}

function isPlainError(error: unknown): error is Error {
  return error instanceof Error && error.constructor === Error
}
