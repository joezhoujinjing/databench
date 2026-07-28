export type EvalScopeApiErrorKind =
  | 'aborted'
  | 'network'
  | 'http-4xx'
  | 'http-5xx'
  | 'validation'
  | 'unavailable'

export class EvalScopeApiError extends Error {
  readonly code?: string
  readonly field?: string
  readonly kind: EvalScopeApiErrorKind
  readonly status?: number

  constructor(
    kind: EvalScopeApiErrorKind,
    message: string,
    options: { code?: string; field?: string; status?: number } = {},
  ) {
    super(message)
    this.name = 'EvalScopeApiError'
    this.kind = kind
    if (options.code !== undefined) this.code = options.code
    if (options.field !== undefined) this.field = options.field
    if (options.status !== undefined) this.status = options.status
    Object.setPrototypeOf(this, EvalScopeApiError.prototype)
  }
}

export function isEvalScopeApiError(error: unknown): error is EvalScopeApiError {
  return error instanceof EvalScopeApiError
}
