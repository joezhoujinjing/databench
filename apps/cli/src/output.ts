import { classifyError, DomainError, ErrorResponseSchema } from '@databench/schema'
import { ZodError } from 'zod'

export function emitResult(value: unknown, compact: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`)
}

// Errors go to stderr in the SAME envelope the API emits (ErrorResponseSchema),
// with the code drawn from the shared taxonomy (classifyError) so CLI and HTTP
// failures classify identically. Unlike the API, a local CLI surfaces the real
// message for internal errors rather than hiding it.
export function emitError(error: unknown, compact: boolean): void {
  const body =
    error instanceof DomainError
      ? {
          code: error.code,
          message: error.message,
          ...(error.detail !== undefined ? { detail: error.detail } : {}),
        }
      : error instanceof ZodError
        ? { code: 'validation_error', message: 'payload validation failed', detail: error.issues }
        : {
            code: classifyError(error),
            message: error instanceof Error ? error.message : String(error),
          }
  const envelope = ErrorResponseSchema.parse({ error: body })
  process.stderr.write(`${JSON.stringify(envelope, null, compact ? 0 : 2)}\n`)
}
