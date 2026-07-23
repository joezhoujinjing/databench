import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  createRawJsonBodyParserV2,
  parseRawJsonBodyV2,
  parseRawJsonV2,
  type RawJsonErrorReasonV2,
  RawJsonErrorV2,
} from '../src/index.js'

interface RawCase {
  name: string
  raw?: string
  bytes_hex?: string
  reason?: RawJsonErrorReasonV2
  max_bytes?: number
  max_depth?: number
}

interface RawFixture {
  valid: RawCase[]
  invalid: RawCase[]
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        './golden/fixtures/v2/jcs-invalid-values-and-duplicate-keys.input.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as RawFixture
const encoder = new TextEncoder()

function bytesFor(testCase: RawCase): Uint8Array {
  if (testCase.bytes_hex !== undefined) {
    return Uint8Array.from(Buffer.from(testCase.bytes_hex, 'hex'))
  }
  return encoder.encode(testCase.raw ?? '')
}

function limitsFor(testCase: RawCase): { maxBytes: number; maxDepth: number } {
  return {
    maxBytes: testCase.max_bytes ?? 1024,
    maxDepth: testCase.max_depth ?? 16,
  }
}

describe('parseRawJsonV2', () => {
  test.each(fixture.valid)('accepts $name', (testCase) => {
    expect(() => parseRawJsonV2(bytesFor(testCase), limitsFor(testCase))).not.toThrow()
  })

  test.each(fixture.invalid)('rejects $name before schema validation', (testCase) => {
    try {
      parseRawJsonV2(bytesFor(testCase), limitsFor(testCase))
      throw new Error(`Expected ${testCase.name} to fail`)
    } catch (error) {
      expect(error).toBeInstanceOf(RawJsonErrorV2)
      expect((error as RawJsonErrorV2).reason).toBe(testCase.reason)
    }
  })

  test('counts decoded duplicate keys and each nested container', () => {
    expect(() => parseRawJsonV2(encoder.encode('{"a":1,"\\u0061":2}'))).toThrowError(
      expect.objectContaining({ reason: 'duplicate_key' }),
    )
    expect(() =>
      parseRawJsonV2(encoder.encode('{"a":[{}]}'), { maxBytes: 64, maxDepth: 2 }),
    ).toThrowError(expect.objectContaining({ reason: 'depth_limit_exceeded' }))
    expect(parseRawJsonV2(encoder.encode('{"a":[]}'), { maxBytes: 64, maxDepth: 2 })).toEqual({
      a: [],
    })
  })
})

describe('raw body schema helper', () => {
  const BodySchema = z.strictObject({
    key: z.string(),
    count: z.number().int().safe(),
  })

  test('runs raw validation before the supplied strict Zod schema', () => {
    const parseBody = createRawJsonBodyParserV2(BodySchema, { maxBytes: 128, maxDepth: 2 })

    expect(parseBody(encoder.encode('{"key":"v","count":2}'))).toEqual({ key: 'v', count: 2 })
    expect(() => parseBody(encoder.encode('{"key":"a","key":"b","count":2}'))).toThrowError(
      expect.objectContaining({ reason: 'duplicate_key' }),
    )
    expect(() => parseBody(encoder.encode('{"key":"v","count":2,"extra":true}'))).toThrow(
      z.ZodError,
    )
  })

  test('also exposes a one-shot body parser', () => {
    expect(parseRawJsonBodyV2(encoder.encode('{"key":"v","count":1}'), BodySchema)).toEqual({
      key: 'v',
      count: 1,
    })
  })
})
