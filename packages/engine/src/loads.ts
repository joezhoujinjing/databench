import { parseCanonicalJson } from '@databench/hashing'

export function loads(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {}
  }

  const parsed = parseCanonicalJson(value)
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }

  return {}
}
