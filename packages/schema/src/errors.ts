import { ZodError, z } from 'zod'

export const ErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  detail: z.unknown().optional(),
})
export type ErrorBody = z.infer<typeof ErrorBodySchema>

export const ErrorResponseSchema = z
  .object({
    error: ErrorBodySchema,
  })
  // Named OpenAPI component so every route's error envelope emits a `$ref`.
  .meta({ id: 'ErrorResponse' })
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

export abstract class DomainError extends Error {
  readonly code: string
  readonly detail: unknown | undefined

  protected constructor(code: string, message: string, detail?: unknown) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

export class NotFoundError extends DomainError {
  override readonly name: string = 'NotFoundError'

  constructor(message: string, detail?: unknown) {
    super('not_found', message, detail)
  }
}

export class BadInputError extends DomainError {
  override readonly name: string = 'BadInputError'

  constructor(message: string, detail?: unknown) {
    super('bad_request', message, detail)
  }
}

export class ValidationError extends DomainError {
  override readonly name: string = 'ValidationError'

  constructor(message: string, detail?: unknown) {
    super('validation_error', message, detail)
  }
}

export class UnsupportedProfileError extends DomainError {
  override readonly name: string = 'UnsupportedProfileError'

  constructor(message: string, detail?: unknown) {
    super('unsupported_profile', message, detail)
  }
}

export class ConflictError extends DomainError {
  override readonly name: string = 'ConflictError'

  constructor(message: string, detail?: unknown) {
    super('conflict', message, detail)
  }
}

export class ResourceLimitError extends DomainError {
  override readonly name: string = 'ResourceLimitError'

  constructor(message: string, detail?: unknown) {
    super('resource_limit', message, detail)
  }
}

export class CapacityExceededError extends DomainError {
  override readonly name: string = 'CapacityExceededError'

  constructor(message: string, detail?: unknown) {
    super('capacity_exceeded', message, detail)
  }
}

export class IntegrityError extends DomainError {
  override readonly name: string = 'IntegrityError'

  constructor(message: string, detail?: unknown) {
    super('integrity_error', message, detail)
  }
}

export class ServiceUnavailableError extends DomainError {
  override readonly name: string = 'ServiceUnavailableError'

  constructor(message: string, detail?: unknown, options?: { readonly cause?: unknown }) {
    super('service_unavailable', message, detail)
    if (options && 'cause' in options) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: options.cause,
        writable: true,
      })
    }
  }
}

// The single source of the error taxonomy. Both transports classify with this
// and map the result to their own surface: apps/api → HTTP status, apps/cli →
// exit code. Mirrors the instanceof ladder both need (HTTPException is
// HTTP-only and handled separately by the API before classification).
export type ErrorClass =
  | 'not_found'
  | 'conflict'
  | 'validation_error'
  | 'unsupported_profile'
  | 'bad_request'
  | 'resource_limit'
  | 'capacity_exceeded'
  | 'integrity_error'
  | 'service_unavailable'
  | 'internal_error'

export function classifyError(error: unknown): ErrorClass {
  if (error instanceof ServiceUnavailableError) {
    return 'service_unavailable'
  }
  if (error instanceof ResourceLimitError) {
    return 'resource_limit'
  }
  if (error instanceof CapacityExceededError) {
    return 'capacity_exceeded'
  }
  if (error instanceof IntegrityError) {
    return 'integrity_error'
  }
  if (error instanceof NotFoundError) {
    return 'not_found'
  }
  if (error instanceof ConflictError) {
    return 'conflict'
  }
  if (error instanceof ValidationError || error instanceof ZodError) {
    return 'validation_error'
  }
  if (error instanceof UnsupportedProfileError) {
    return 'unsupported_profile'
  }
  if (error instanceof BadInputError || error instanceof TypeError) {
    return 'bad_request'
  }
  // A plain `Error` (constructor === Error) is treated as caller/input error,
  // like the API; other Error subclasses fall through to internal.
  if (error instanceof Error && error.constructor === Error) {
    return 'bad_request'
  }
  return 'internal_error'
}
