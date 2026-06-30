import type { Kind } from '@databench/schema'
import type { JsonRecord } from './detect-kind.js'

export function normalizeRecord(record: JsonRecord, kind: Kind): JsonRecord {
  const normalized: JsonRecord = { ...record }

  if (kind === 'preference') {
    normalized.prompt = asMessages(normalized.prompt, 'user')
    normalized.chosen = asCompletion(normalized.chosen)
    normalized.rejected = asCompletion(normalized.rejected)
  } else if (kind === 'rl') {
    normalized.prompt = asMessages(normalized.prompt, 'user')
  }

  return normalized
}

export function asMessages(value: unknown, defaultRole: string): JsonRecord[] {
  if (value == null) {
    return []
  }

  if (typeof value === 'string') {
    return [{ role: defaultRole, content: value }]
  }

  if (isPlainRecord(value)) {
    return [value]
  }

  if (isIterable(value)) {
    return Array.from(value) as JsonRecord[]
  }

  throw new TypeError('message value is not iterable')
}

export function asCompletion(value: unknown): unknown {
  if (typeof value === 'string') {
    return { role: 'assistant', content: value }
  }

  return value
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof (value as Partial<Iterable<unknown>>)[Symbol.iterator] === 'function'
}
