import type { CanonicalJsonValue } from './types.js'

export function compareJcsUtf16(left: string, right: string): number {
  const length = Math.min(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index)
    if (difference !== 0) {
      return difference
    }
  }

  return left.length - right.length
}

export function canonicalJsonV2(value: unknown): string {
  return encodeJcsValue(value, new WeakSet<object>())
}

function encodeJcsValue(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) {
    return 'null'
  }

  switch (typeof value) {
    case 'string':
      assertUnicodeScalarSequence(value)
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('RFC 8785 does not allow non-finite numbers')
      }
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object':
      return encodeObjectOrArray(value, ancestors)
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new TypeError(`RFC 8785 does not allow values of type ${typeof value}`)
  }

  throw new TypeError('RFC 8785 received an unsupported value')
}

function encodeObjectOrArray(value: object, ancestors: WeakSet<object>): string {
  if (ancestors.has(value)) {
    throw new TypeError('RFC 8785 does not allow cyclic values')
  }

  ancestors.add(value)
  try {
    return Array.isArray(value) ? encodeArray(value, ancestors) : encodeObject(value, ancestors)
  } finally {
    ancestors.delete(value)
  }
}

function encodeArray(value: readonly unknown[], ancestors: WeakSet<object>): string {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError('RFC 8785 does not allow sparse arrays')
    }
  }

  const unexpectedKeys = Reflect.ownKeys(value).filter((key) => {
    if (key === 'length') {
      return false
    }
    return typeof key !== 'string' || !isArrayIndex(key, value.length)
  })
  if (unexpectedKeys.length > 0) {
    throw new TypeError('RFC 8785 arrays cannot have non-index properties')
  }

  return `[${value.map((item) => encodeJcsValue(item, ancestors)).join(',')}]`
}

function encodeObject(value: object, ancestors: WeakSet<object>): string {
  if (!isPlainObject(value)) {
    throw new TypeError('RFC 8785 only allows plain objects')
  }

  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new TypeError('RFC 8785 object keys must be strings')
  }

  const record = value as Readonly<Record<string, unknown>>
  const keys = ownKeys as string[]
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError('RFC 8785 only allows enumerable data properties')
    }
    assertUnicodeScalarSequence(key)
  }

  return `{${keys
    .sort(compareJcsUtf16)
    .map((key) => `${JSON.stringify(key)}:${encodeJcsValue(record[key], ancestors)}`)
    .join(',')}}`
}

function isPlainObject(value: object): value is Readonly<Record<string, CanonicalJsonValue>> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) {
    return false
  }
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length
}

export function assertUnicodeScalarSequence(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('RFC 8785 does not allow lone UTF-16 surrogates')
      }
      index += 1
      continue
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError('RFC 8785 does not allow lone UTF-16 surrogates')
    }
  }
}
