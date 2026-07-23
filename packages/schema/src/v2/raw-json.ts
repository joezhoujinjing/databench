import type { CanonicalJsonValue } from '@databench/hashing'
import type { ZodType } from 'zod'
import { BadInputError } from '../errors.js'

export interface RawJsonLimitsV2 {
  readonly maxBytes: number
  readonly maxDepth: number
}

export const DEFAULT_RAW_JSON_LIMITS_V2: RawJsonLimitsV2 = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 128,
})

export type RawJsonErrorReasonV2 =
  | 'bom_not_allowed'
  | 'byte_limit_exceeded'
  | 'depth_limit_exceeded'
  | 'duplicate_key'
  | 'invalid_number'
  | 'invalid_unicode'
  | 'malformed_json'
  | 'malformed_utf8'

export class RawJsonErrorV2 extends BadInputError {
  readonly reason: RawJsonErrorReasonV2
  readonly offset: number | null

  constructor(reason: RawJsonErrorReasonV2, message: string, offset: number | null = null) {
    super(message, { reason, offset })
    this.reason = reason
    this.offset = offset
  }
}

export function parseRawJsonV2(
  bytes: Uint8Array,
  limits: RawJsonLimitsV2 = DEFAULT_RAW_JSON_LIMITS_V2,
): CanonicalJsonValue {
  validateLimits(limits)
  if (bytes.byteLength > limits.maxBytes) {
    throw new RawJsonErrorV2(
      'byte_limit_exceeded',
      `Raw JSON exceeds the ${limits.maxBytes} byte limit`,
    )
  }
  if (hasUtf8Bom(bytes)) {
    throw new RawJsonErrorV2('bom_not_allowed', 'Raw JSON must not contain a UTF-8 BOM', 0)
  }

  const text = decodeUtf8(bytes)
  assertRawUnicodeScalarSequence(text)

  const scanner = new RawJsonScanner(text, limits.maxDepth)
  scanner.scanDocument()

  try {
    return JSON.parse(text) as CanonicalJsonValue
  } catch {
    throw new RawJsonErrorV2('malformed_json', 'Raw JSON is malformed')
  }
}

export function parseRawJsonBodyV2<T>(
  bytes: Uint8Array,
  schema: ZodType<T>,
  limits: RawJsonLimitsV2 = DEFAULT_RAW_JSON_LIMITS_V2,
): T {
  return schema.parse(parseRawJsonV2(bytes, limits))
}

export function createRawJsonBodyParserV2<T>(
  schema: ZodType<T>,
  limits: RawJsonLimitsV2 = DEFAULT_RAW_JSON_LIMITS_V2,
): (bytes: Uint8Array) => T {
  const capturedLimits = Object.freeze({ ...limits })
  validateLimits(capturedLimits)
  return (bytes) => parseRawJsonBodyV2(bytes, schema, capturedLimits)
}

class RawJsonScanner {
  private offset = 0

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  scanDocument(): void {
    this.skipWhitespace()
    this.scanValue(0)
    this.skipWhitespace()
    if (this.offset !== this.text.length) {
      this.fail('malformed_json', 'Unexpected content after the JSON value')
    }
  }

  private scanValue(depth: number): void {
    const token = this.text[this.offset]
    switch (token) {
      case '{':
        this.scanObject(depth + 1)
        return
      case '[':
        this.scanArray(depth + 1)
        return
      case '"':
        this.scanString()
        return
      case 't':
        this.scanLiteral('true')
        return
      case 'f':
        this.scanLiteral('false')
        return
      case 'n':
        this.scanLiteral('null')
        return
      default:
        if (token === '-' || isDigit(token)) {
          this.scanNumber()
          return
        }
        this.fail('malformed_json', 'Expected a JSON value')
    }
  }

  private scanObject(depth: number): void {
    this.assertDepth(depth)
    this.offset += 1
    this.skipWhitespace()
    if (this.consume('}')) {
      return
    }

    const keys = new Set<string>()
    while (true) {
      if (this.text[this.offset] !== '"') {
        this.fail('malformed_json', 'Expected an object property name')
      }
      const keyOffset = this.offset
      const key = this.scanString()
      if (keys.has(key)) {
        throw new RawJsonErrorV2(
          'duplicate_key',
          'Raw JSON contains a duplicate object key',
          keyOffset,
        )
      }
      keys.add(key)

      this.skipWhitespace()
      if (!this.consume(':')) {
        this.fail('malformed_json', 'Expected a colon after the object property name')
      }
      this.skipWhitespace()
      this.scanValue(depth)
      this.skipWhitespace()

      if (this.consume('}')) {
        return
      }
      if (!this.consume(',')) {
        this.fail('malformed_json', 'Expected a comma or closing brace')
      }
      this.skipWhitespace()
    }
  }

  private scanArray(depth: number): void {
    this.assertDepth(depth)
    this.offset += 1
    this.skipWhitespace()
    if (this.consume(']')) {
      return
    }

    while (true) {
      this.scanValue(depth)
      this.skipWhitespace()
      if (this.consume(']')) {
        return
      }
      if (!this.consume(',')) {
        this.fail('malformed_json', 'Expected a comma or closing bracket')
      }
      this.skipWhitespace()
    }
  }

  private scanString(): string {
    const start = this.offset
    this.offset += 1

    while (this.offset < this.text.length) {
      const codeUnit = this.text.charCodeAt(this.offset)
      if (codeUnit === 0x22) {
        this.offset += 1
        const source = this.text.slice(start, this.offset)
        let value: string
        try {
          value = JSON.parse(source) as string
        } catch {
          this.fail('malformed_json', 'Malformed JSON string', start)
        }
        assertDecodedString(value, start)
        return value
      }
      if (codeUnit < 0x20) {
        this.fail('malformed_json', 'Unescaped control character in JSON string')
      }
      if (codeUnit === 0x5c) {
        this.offset += 1
        const escapeCode = this.text[this.offset]
        if (escapeCode === 'u') {
          const digits = this.text.slice(this.offset + 1, this.offset + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
            this.fail('malformed_json', 'Malformed Unicode escape in JSON string')
          }
          this.offset += 5
          continue
        }
        if (!escapeCode || !'"\\/bfnrt'.includes(escapeCode)) {
          this.fail('malformed_json', 'Malformed escape in JSON string')
        }
      }
      this.offset += 1
    }

    this.fail('malformed_json', 'Unterminated JSON string', start)
  }

  private scanNumber(): void {
    const source = this.text.slice(this.offset)
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source)
    const lexeme = match?.[0]
    if (!lexeme) {
      this.fail('malformed_json', 'Malformed JSON number')
    }

    const value = Number(lexeme)
    if (!Number.isFinite(value)) {
      this.fail('invalid_number', 'JSON number is outside the finite IEEE-754 range')
    }
    if (/^-?(?:0|[1-9]\d*)$/.test(lexeme) && !Number.isSafeInteger(value)) {
      this.fail('invalid_number', 'JSON integer is outside the safe integer range')
    }
    this.offset += lexeme.length
  }

  private scanLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.offset)) {
      this.fail('malformed_json', `Expected ${literal}`)
    }
    this.offset += literal.length
  }

  private assertDepth(depth: number): void {
    if (depth > this.maxDepth) {
      this.fail('depth_limit_exceeded', `Raw JSON exceeds the nesting depth ${this.maxDepth}`)
    }
  }

  private skipWhitespace(): void {
    while (isJsonWhitespace(this.text.charCodeAt(this.offset))) {
      this.offset += 1
    }
  }

  private consume(expected: string): boolean {
    if (this.text[this.offset] !== expected) {
      return false
    }
    this.offset += 1
    return true
  }

  private fail(reason: RawJsonErrorReasonV2, message: string, offset = this.offset): never {
    throw new RawJsonErrorV2(reason, message, offset)
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new RawJsonErrorV2('malformed_utf8', 'Raw JSON must be valid UTF-8')
  }
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

function assertRawUnicodeScalarSequence(text: string): void {
  try {
    assertDecodedString(text, 0)
  } catch (error) {
    if (error instanceof RawJsonErrorV2) {
      throw error
    }
    throw new RawJsonErrorV2('invalid_unicode', 'Raw JSON contains invalid Unicode')
  }
}

function assertDecodedString(value: string, baseOffset: number): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new RawJsonErrorV2(
          'invalid_unicode',
          'Raw JSON contains a lone UTF-16 surrogate',
          baseOffset + index,
        )
      }
      index += 1
      continue
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new RawJsonErrorV2(
        'invalid_unicode',
        'Raw JSON contains a lone UTF-16 surrogate',
        baseOffset + index,
      )
    }
  }
}

function validateLimits(limits: RawJsonLimitsV2): void {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0) {
    throw new TypeError('Raw JSON maxBytes must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0) {
    throw new TypeError('Raw JSON maxDepth must be a non-negative safe integer')
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9'
}

function isJsonWhitespace(codeUnit: number): boolean {
  return codeUnit === 0x20 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0d
}
