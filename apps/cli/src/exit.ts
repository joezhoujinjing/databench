import { classifyError, type ErrorClass } from '@databench/schema'

// Exit codes for the shared error taxonomy — the CLI counterpart to the HTTP
// status map in apps/api (both classify via @databench/schema classifyError),
// so an agent gets the same error taxonomy over the CLI as over HTTP.
export const EXIT = {
  ok: 0,
  internal: 1,
  badInput: 2,
  notFound: 3,
  conflict: 4,
  validation: 5,
} as const

const EXIT_FOR: Record<ErrorClass, number> = {
  internal_error: EXIT.internal,
  bad_request: EXIT.badInput,
  not_found: EXIT.notFound,
  conflict: EXIT.conflict,
  validation_error: EXIT.validation,
}

export function exitCodeFor(error: unknown): number {
  return EXIT_FOR[classifyError(error)]
}
