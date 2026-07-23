import type { JsonValueV2 } from '@databench/schema'

const textEncoder = new TextEncoder()

/**
 * Serializes trainer rows with deterministic JSON object ordering.
 *
 * Canonical records themselves continue to use their already-computed
 * `record_json`. Converter rows are not canonical identity inputs, but their
 * bytes are part of the versioned converter contract and therefore cannot
 * inherit insertion order from open JsonObject values.
 */
export function deterministicJsonV2(value: JsonValueV2): string {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Converter output cannot contain a non-finite number')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => deterministicJsonV2(item)).join(',')}]`
  }

  const entries = Object.entries(value).sort(([left], [right]) => utf16Compare(left, right))
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${deterministicJsonV2(item)}`)
    .join(',')}}`
}

export function deterministicJsonLineV2(value: JsonValueV2): Uint8Array {
  return textEncoder.encode(`${deterministicJsonV2(value)}\n`)
}

export function jsonUtf8BytesV2(value: JsonValueV2): number {
  return textEncoder.encode(deterministicJsonV2(value)).byteLength
}

function utf16Compare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}
