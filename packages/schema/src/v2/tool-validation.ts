import { type CanonicalJsonObject, canonicalJsonV2 } from '@databench/hashing'
import type { ErrorObject, ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import safeRegex from 'safe-regex2'

export interface ToolSchemaValidationLimitsV2 {
  readonly maxSchemaBytes: number
  readonly maxSchemaDepth: number
  readonly maxSchemaNodes: number
  readonly maxSchemaRefs: number
  readonly maxCompileMilliseconds: number
  readonly maxInstanceDepth: number
}

export const DEFAULT_TOOL_SCHEMA_LIMITS_V2: ToolSchemaValidationLimitsV2 = Object.freeze({
  maxSchemaBytes: 64 * 1024,
  maxSchemaDepth: 64,
  maxSchemaNodes: 4096,
  maxSchemaRefs: 256,
  maxCompileMilliseconds: 250,
  maxInstanceDepth: 128,
})

export class ToolSchemaValidationErrorV2 extends Error {
  override readonly name = 'ToolSchemaValidationErrorV2'
}

export interface CompiledToolInputSchemaV2 {
  validate(args: CanonicalJsonObject): readonly ErrorObject[] | null
}

const MAX_COMPILED_SCHEMA_CACHE_ENTRIES = 256
const toolSchemaAjv = new Ajv2020({
  addUsedSchema: false,
  allErrors: false,
  strict: true,
  validateFormats: false,
})
const compiledSchemaCache = new Map<string, ValidateFunction>()

export function compileToolInputSchemaV2(
  schema: CanonicalJsonObject,
  limits: ToolSchemaValidationLimitsV2 = DEFAULT_TOOL_SCHEMA_LIMITS_V2,
): CompiledToolInputSchemaV2 {
  validateLimits(limits)
  if (schema.type !== 'object') {
    throw new ToolSchemaValidationErrorV2('Tool input_schema root type must be object')
  }

  const schemaJson = canonicalJsonV2(schema)
  const bytes = new TextEncoder().encode(schemaJson).byteLength
  if (bytes > limits.maxSchemaBytes) {
    throw new ToolSchemaValidationErrorV2('Tool input_schema exceeds the schema byte budget')
  }
  inspectSchemaGraph(schema, limits)

  const validator = getOrCompileValidator(schema, schemaJson, limits.maxCompileMilliseconds)

  return {
    validate(args) {
      if (jsonDepth(args) > limits.maxInstanceDepth) {
        return [instanceDepthError(limits.maxInstanceDepth)]
      }
      return validator(args) ? null : cloneAjvErrors(validator.errors ?? [])
    },
  }
}

function getOrCompileValidator(
  schema: CanonicalJsonObject,
  schemaJson: string,
  maxCompileMilliseconds: number,
): ValidateFunction {
  const cached = compiledSchemaCache.get(schemaJson)
  if (cached) {
    compiledSchemaCache.delete(schemaJson)
    compiledSchemaCache.set(schemaJson, cached)
    return cached
  }
  if (maxCompileMilliseconds === 0) {
    throw new ToolSchemaValidationErrorV2('Tool input_schema exceeded the compile time budget')
  }

  let validator: ValidateFunction
  const startedCpu = process.threadCpuUsage()
  try {
    validator = toolSchemaAjv.compile(schema)
  } catch (error) {
    throw new ToolSchemaValidationErrorV2(
      `Tool input_schema failed Draft 2020-12 compilation: ${errorMessage(error)}`,
    )
  }
  const compileCpu = process.threadCpuUsage(startedCpu)
  if ((compileCpu.user + compileCpu.system) / 1000 > maxCompileMilliseconds) {
    throw new ToolSchemaValidationErrorV2('Tool input_schema exceeded the compile time budget')
  }

  compiledSchemaCache.set(schemaJson, validator)
  if (compiledSchemaCache.size > MAX_COMPILED_SCHEMA_CACHE_ENTRIES) {
    const oldest = compiledSchemaCache.keys().next().value
    if (oldest !== undefined) {
      compiledSchemaCache.delete(oldest)
    }
  }
  return validator
}

function inspectSchemaGraph(
  schema: CanonicalJsonObject,
  limits: ToolSchemaValidationLimitsV2,
): void {
  let nodes = 0
  let refs = 0
  type Location = 'schema' | 'schema-map' | 'schema-array' | 'data'
  const stack: Array<{ value: unknown; depth: number; location: Location }> = [
    { value: schema, depth: 1, location: 'schema' },
  ]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      break
    }
    nodes += 1
    if (nodes > limits.maxSchemaNodes) {
      throw new ToolSchemaValidationErrorV2('Tool input_schema exceeds the node budget')
    }
    if (current.depth > limits.maxSchemaDepth) {
      throw new ToolSchemaValidationErrorV2('Tool input_schema exceeds the depth budget')
    }

    if (Array.isArray(current.value)) {
      for (const value of current.value) {
        stack.push({
          value,
          depth: current.depth + 1,
          location: current.location === 'schema-array' ? 'schema' : current.location,
        })
      }
      continue
    }
    if (!isObject(current.value)) {
      continue
    }

    if (current.location === 'schema-map') {
      for (const value of Object.values(current.value)) {
        stack.push({ value, depth: current.depth + 1, location: 'schema' })
      }
      continue
    }

    for (const [key, value] of Object.entries(current.value)) {
      if (current.location === 'schema' && (key === '$ref' || key === '$dynamicRef')) {
        refs += 1
        if (refs > limits.maxSchemaRefs) {
          throw new ToolSchemaValidationErrorV2('Tool input_schema exceeds the $ref budget')
        }
        if (typeof value !== 'string' || !value.startsWith('#')) {
          throw new ToolSchemaValidationErrorV2(
            'Tool input_schema only allows local fragment $ref and $dynamicRef',
          )
        }
      }
      if (current.location === 'schema' && key === 'pattern' && typeof value === 'string') {
        assertSafeSchemaRegex(value)
      }
      if (current.location === 'schema' && key === 'patternProperties' && isObject(value)) {
        for (const pattern of Object.keys(value)) {
          assertSafeSchemaRegex(pattern)
        }
      }

      stack.push({
        value,
        depth: current.depth + 1,
        location: schemaLocationForKeyword(current.location, key),
      })
    }
  }
}

const SCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
])
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const SCHEMA_VALUE_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
])

function schemaLocationForKeyword(
  parentLocation: 'schema' | 'schema-map' | 'schema-array' | 'data',
  keyword: string,
): 'schema' | 'schema-map' | 'schema-array' | 'data' {
  if (parentLocation !== 'schema') {
    return parentLocation === 'schema-array' ? 'schema' : 'data'
  }
  if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
    return 'schema-map'
  }
  if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) {
    return 'schema-array'
  }
  return SCHEMA_VALUE_KEYWORDS.has(keyword) ? 'schema' : 'data'
}

function assertSafeSchemaRegex(pattern: string): void {
  if (pattern.length > 512 || !safeRegex(pattern)) {
    throw new ToolSchemaValidationErrorV2('Tool input_schema contains an unsafe regular expression')
  }
}

function jsonDepth(value: unknown): number {
  let maximum = 0
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      break
    }
    if (!Array.isArray(current.value) && !isObject(current.value)) {
      continue
    }
    const depth = current.depth + 1
    maximum = Math.max(maximum, depth)
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value)
    for (const child of children) {
      stack.push({ value: child, depth })
    }
  }
  return maximum
}

function validateLimits(limits: ToolSchemaValidationLimitsV2): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`)
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function instanceDepthError(limit: number): ErrorObject {
  return {
    instancePath: '',
    schemaPath: '#',
    keyword: 'maxDepth',
    params: { limit },
    message: `must not exceed nesting depth ${limit}`,
  }
}

function cloneAjvErrors(errors: readonly ErrorObject[]): readonly ErrorObject[] {
  return errors.map((error) => ({
    ...error,
    params: structuredClone(error.params),
  }))
}
