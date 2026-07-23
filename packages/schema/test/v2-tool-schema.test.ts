import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { CanonicalJsonObject } from '@databench/hashing'
import { describe, expect, test } from 'vitest'
import {
  compileToolInputSchemaV2,
  DEFAULT_TOOL_SCHEMA_LIMITS_V2,
  ToolSchemaValidationErrorV2,
} from '../src/index.js'

interface ToolFixture {
  valid_recursive: CanonicalJsonObject
  valid_instance: CanonicalJsonObject
  invalid_instance: CanonicalJsonObject
  invalid_schemas: Array<{ name: string; schema: CanonicalJsonObject }>
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./golden/fixtures/v2/tool-schema-local-ref-budget.input.json', import.meta.url),
    ),
    'utf8',
  ),
) as ToolFixture

describe('Tool Draft 2020-12 validation', () => {
  test('compiles a self-contained recursive schema and validates args', () => {
    const compiled = compileToolInputSchemaV2(fixture.valid_recursive)
    expect(compiled.validate(fixture.valid_instance)).toBeNull()
    expect(compiled.validate(fixture.invalid_instance)).not.toBeNull()
  })

  test.each(fixture.invalid_schemas)('rejects $name', ({ schema }) => {
    expect(() => compileToolInputSchemaV2(schema)).toThrow(ToolSchemaValidationErrorV2)
  })

  test('treats unknown formats as annotations', () => {
    const compiled = compileToolInputSchemaV2({
      type: 'object',
      properties: { value: { type: 'string', format: 'future-provider-format' } },
    })
    expect(compiled.validate({ value: 'anything' })).toBeNull()
  })

  test('only interprets refs at schema locations and budgets dynamic refs', () => {
    expect(() =>
      compileToolInputSchemaV2({
        type: 'object',
        properties: {
          value: {
            type: 'object',
            default: { $ref: 'https://example.com/annotation-only' },
          },
        },
      }),
    ).not.toThrow()

    expect(() =>
      compileToolInputSchemaV2(
        {
          type: 'object',
          $dynamicAnchor: 'node',
          properties: { child: { $dynamicRef: '#node' } },
        },
        { ...DEFAULT_TOOL_SCHEMA_LIMITS_V2, maxSchemaRefs: 0 },
      ),
    ).toThrow(/\$ref budget/)
  })

  test('rejects unsafe regular expressions before compiling or validating instances', () => {
    expect(() =>
      compileToolInputSchemaV2({
        type: 'object',
        properties: { value: { type: 'string', pattern: '(a+)+$' } },
      }),
    ).toThrow(/unsafe regular expression/)
  })

  test('enforces schema byte, depth, node, ref, and instance budgets', () => {
    expect(() =>
      compileToolInputSchemaV2(fixture.valid_recursive, {
        ...DEFAULT_TOOL_SCHEMA_LIMITS_V2,
        maxSchemaBytes: 10,
      }),
    ).toThrow(/byte budget/)
    expect(() =>
      compileToolInputSchemaV2(fixture.valid_recursive, {
        ...DEFAULT_TOOL_SCHEMA_LIMITS_V2,
        maxSchemaDepth: 2,
      }),
    ).toThrow(/depth budget/)
    expect(() =>
      compileToolInputSchemaV2(fixture.valid_recursive, {
        ...DEFAULT_TOOL_SCHEMA_LIMITS_V2,
        maxSchemaNodes: 2,
      }),
    ).toThrow(/node budget/)
    expect(() =>
      compileToolInputSchemaV2(fixture.valid_recursive, {
        ...DEFAULT_TOOL_SCHEMA_LIMITS_V2,
        maxSchemaRefs: 0,
      }),
    ).toThrow(/\$ref budget/)
    expect(() =>
      compileToolInputSchemaV2(
        { type: 'object', properties: { uncached: { type: 'string' } } },
        { ...DEFAULT_TOOL_SCHEMA_LIMITS_V2, maxCompileMilliseconds: 0 },
      ),
    ).toThrow(/compile time budget/)

    const shallowInstance = compileToolInputSchemaV2(fixture.valid_recursive, {
      ...DEFAULT_TOOL_SCHEMA_LIMITS_V2,
      maxInstanceDepth: 1,
    })
    expect(shallowInstance.validate(fixture.valid_instance)?.[0]?.keyword).toBe('maxDepth')
  })
})
