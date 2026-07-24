import { BadInputError, JsonObjectV2Schema, parseRawJsonV2 } from '@databench/schema'
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

export function requireExactPositionals(
  positionals: readonly string[],
  count: number,
  usage: string,
): void {
  if (positionals.length !== count) {
    throw new BadInputError(
      `${usage}: expected ${count} positional argument${count === 1 ? '' : 's'}`,
    )
  }
}

export function parseV2JsonObjectFlag(
  values: Values,
  key: string,
): ReturnType<typeof JsonObjectV2Schema.parse> {
  const text = optString(values, key)
  if (text === undefined) return JsonObjectV2Schema.parse({})
  return JsonObjectV2Schema.parse(parseRawJsonV2(new TextEncoder().encode(text)))
}
