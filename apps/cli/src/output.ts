import { classifyError, DomainError, ErrorResponseSchema } from '@databench/schema'
import { ZodError } from 'zod'

export interface EmitErrorOptions {
  readonly sanitizeUnexpected?: boolean
}

export function emitResult(value: unknown, compact: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`)
}

// Errors go to stderr in the SAME envelope the API emits (ErrorResponseSchema),
// with the code drawn from the shared taxonomy (classifyError) so CLI and HTTP
// failures classify identically. Unlike the API, a local CLI surfaces the real
// message for internal errors rather than hiding it.
export function emitError(error: unknown, compact: boolean, options: EmitErrorOptions = {}): void {
  const cleanupFailed = hasCliCleanupFailure(error)
  const body =
    error instanceof DomainError
      ? {
          code: error.code,
          message: appendCleanupFailure(error.message, cleanupFailed),
          ...(error.detail !== undefined ? { detail: error.detail } : {}),
        }
      : error instanceof ZodError
        ? {
            code: 'validation_error',
            message: appendCleanupFailure('payload validation failed', cleanupFailed),
            detail:
              options.sanitizeUnexpected === true
                ? error.issues.map((issue) => ({
                    path: issue.path.map(String).join('.'),
                    code: issue.code,
                    message: issue.message,
                  }))
                : error.issues,
          }
        : {
            code: classifyError(error),
            message: appendCleanupFailure(
              options.sanitizeUnexpected === true
                ? 'V2 command failed without a safe diagnostic message'
                : error instanceof Error
                  ? error.message
                  : String(error),
              cleanupFailed,
            ),
          }
  const envelope = ErrorResponseSchema.parse({ error: body })
  process.stderr.write(`${JSON.stringify(envelope, null, compact ? 0 : 2)}\n`)
}

function hasCliCleanupFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly cliCleanupFailed?: unknown }).cliCleanupFailed === true
  )
}

function appendCleanupFailure(message: string, cleanupFailed: boolean): string {
  return cleanupFailed ? `${message}; temporary export cleanup also failed` : message
}
