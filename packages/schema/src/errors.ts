import { z } from 'zod'

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
  override readonly name = 'NotFoundError'

  constructor(message: string, detail?: unknown) {
    super('not_found', message, detail)
  }
}

export class BadInputError extends DomainError {
  override readonly name = 'BadInputError'

  constructor(message: string, detail?: unknown) {
    super('bad_request', message, detail)
  }
}

export class ValidationError extends DomainError {
  override readonly name = 'ValidationError'

  constructor(message: string, detail?: unknown) {
    super('validation_error', message, detail)
  }
}

export class ConflictError extends DomainError {
  override readonly name = 'ConflictError'

  constructor(message: string, detail?: unknown) {
    super('conflict', message, detail)
  }
}
