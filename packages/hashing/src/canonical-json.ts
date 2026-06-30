const NUMBER_LEXEME = Symbol.for('@databench/hashing/json-number-lexeme')
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

export interface JsonNumberLexeme {
  readonly [NUMBER_LEXEME]: true
  readonly source: string
}

export interface JsonParseContext {
  readonly source?: string
}

export function jsonNumberLexeme(source: string): JsonNumberLexeme {
  if (!JSON_NUMBER_PATTERN.test(source)) {
    throw new TypeError(`Invalid JSON number lexeme: ${source}`)
  }

  return {
    [NUMBER_LEXEME]: true,
    source,
  }
}

export function canonicalJsonReviver(
  _key: string,
  value: unknown,
  context?: JsonParseContext,
): unknown {
  if (typeof value === 'number' && context?.source !== undefined) {
    return jsonNumberLexeme(context.source)
  }

  return value
}

export function parseCanonicalJson(text: string): unknown {
  return JSON.parse(text, canonicalJsonReviver)
}

export function canonicalJson(value: unknown): string {
  return encodeCanonical(value)
}

function encodeCanonical(value: unknown): string {
  if (isJsonNumberLexeme(value)) {
    return value.source
  }

  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeCanonical(item)).join(',')}]`
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return encodeNumber(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object':
      return encodeObject(value)
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      return JSON.stringify(String(value))
  }

  return JSON.stringify(String(value))
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value)
  }

  return String(value)
}

function encodeObject(value: object): string {
  if (!isPlainObject(value)) {
    return JSON.stringify(String(value))
  }

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key])}`)
    .join(',')}}`
}

export function isJsonNumberLexeme(value: unknown): value is JsonNumberLexeme {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<JsonNumberLexeme>)[NUMBER_LEXEME] === true
  )
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareCodePoints(left: string, right: string): number {
  const leftCodePoints = Array.from(left)
  const rightCodePoints = Array.from(right)
  const length = Math.min(leftCodePoints.length, rightCodePoints.length)

  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCodePoints[index]?.codePointAt(0) ?? 0
    const rightCodePoint = rightCodePoints[index]?.codePointAt(0) ?? 0

    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint - rightCodePoint
    }
  }

  return leftCodePoints.length - rightCodePoints.length
}
