import { BadInputError, PaginationQuerySchema } from '@databench/schema'
import type { Values } from './types.js'

export function optString(values: Values, key: string): string | undefined {
  const value = values[key]
  return typeof value === 'string' ? value : undefined
}

export function optBool(values: Values, key: string): boolean {
  return values[key] === true
}

export function stringList(values: Values, key: string): string[] {
  const value = values[key]
  if (Array.isArray(value)) {
    return value
  }
  return typeof value === 'string' ? [value] : []
}

// Parse --limit/--offset through the same schema the HTTP API uses, so the CLI
// enforces the identical bounds (limit ∈ [1, MAX_PAGE_LIMIT], offset ≥ 0) and
// rejects the same bad values (a ZodError → validation exit code), instead of
// silently accepting limit=0, negative offsets, or garbage like "20x".
export function pagination(values: Values): { limit: number; offset: number } {
  const limit = optString(values, 'limit')
  const offset = optString(values, 'offset')
  return PaginationQuerySchema.parse({
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  })
}

export function requirePositional(
  positionals: readonly string[],
  index: number,
  label: string,
): string {
  const value = positionals[index]
  if (value === undefined || value === '') {
    throw new BadInputError(`${label} is required`)
  }
  return value
}

export function requireString(values: Values, key: string, label: string): string {
  const value = optString(values, key)
  if (value === undefined) {
    throw new BadInputError(`${label} is required`)
  }
  return value
}

export function parseJsonFlag(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new BadInputError(`${label}: invalid JSON`)
  }
}
