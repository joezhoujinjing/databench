import {
  type JsonObjectV2,
  JsonObjectV2Schema,
  NotFoundError,
  V2_TRANSFORM_MAX_INPUTS,
} from '@databench/schema'
import { z } from 'zod'
import type { V2TransformDefinition, V2TransformRegistryDescriptor } from './contracts.js'

const TRANSFORM_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/
const TRANSFORM_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_IDENTITY_STRING_BYTES = 1024

export interface DefineV2TransformOptions<P extends object> {
  readonly name: string
  readonly version: string
  readonly inputRoles: readonly string[]
  readonly paramsSchema: z.ZodType<P>
  readonly paramsExample: P
  readonly identityMode: 'preserve' | 'derive'
  readonly rngSeed: V2TransformDefinition<P>['rngSeed']
  readonly estimateWorkingSet: V2TransformDefinition<P>['estimateWorkingSet']
  readonly run: V2TransformDefinition<P>['run']
}

export function defineV2Transform<P extends object>(
  options: DefineV2TransformOptions<P>,
): V2TransformDefinition<P> {
  validateName(options.name)
  validateVersion(options.version)
  validateInputRoles(options.inputRoles)
  if (options.identityMode !== 'preserve' && options.identityMode !== 'derive') {
    throw new TypeError('V2 transform identityMode must be preserve or derive')
  }
  const paramsSchemaJson = schemaJson(options.paramsSchema)
  if (
    paramsSchemaJson.type !== 'object' ||
    paramsSchemaJson.additionalProperties !== false ||
    !isRuntimeStrictObjectSchema(options.paramsSchema)
  ) {
    throw new TypeError('V2 transform params schema must be a strict object schema')
  }
  if (typeof options.run !== 'function') {
    throw new TypeError('V2 transform run must be a function')
  }
  if (typeof options.estimateWorkingSet !== 'function') {
    throw new TypeError('V2 transform estimateWorkingSet must be a function')
  }
  if (typeof options.rngSeed !== 'function') {
    throw new TypeError('V2 transform rngSeed must be a function')
  }
  const paramsExample = parseParamsExample(options.paramsSchema, options.paramsExample)

  return Object.freeze({
    name: options.name,
    version: options.version,
    inputRoles: Object.freeze([...options.inputRoles]),
    paramsSchema: options.paramsSchema,
    paramsExample,
    identityMode: options.identityMode,
    rngSeed: options.rngSeed,
    estimateWorkingSet: options.estimateWorkingSet,
    run: options.run,
  })
}

export class V2TransformRegistry {
  readonly #definitions: ReadonlyMap<string, V2TransformDefinition>
  readonly #ordered: readonly V2TransformDefinition[]

  constructor(definitions: Iterable<V2TransformDefinition>) {
    const byName = new Map<string, V2TransformDefinition>()
    for (const definition of definitions) {
      validateDefinition(definition)
      const retained = Object.freeze({ ...definition }) as V2TransformDefinition
      if (byName.has(retained.name)) {
        throw new TypeError(`Duplicate V2 transform name: ${retained.name}`)
      }
      byName.set(retained.name, retained)
    }
    this.#definitions = byName
    this.#ordered = Object.freeze([...byName.values()].sort((a, b) => asciiCompare(a.name, b.name)))
    Object.freeze(this)
  }

  get(name: string): V2TransformDefinition | null {
    return this.#definitions.get(name) ?? null
  }

  require(name: string): V2TransformDefinition {
    const definition = this.get(name)
    if (!definition) {
      throw new NotFoundError(`V2 transform not found: ${name}`, { transform: name })
    }
    return definition
  }

  list(): readonly V2TransformDefinition[] {
    return this.#ordered
  }

  descriptors(): readonly Readonly<V2TransformRegistryDescriptor>[] {
    return Object.freeze(
      this.#ordered.map((definition) =>
        deepFreeze({
          name: definition.name,
          version: definition.version,
          identity_mode: definition.identityMode,
          input_roles: [...definition.inputRoles],
          params_schema: schemaJson(definition.paramsSchema),
          params_example: structuredClone(definition.paramsExample),
        }),
      ),
    )
  }

  parseParams(name: string, input: unknown): JsonObjectV2 {
    const parsed = this.require(name).paramsSchema.parse(input)
    return deepFreeze(JsonObjectV2Schema.parse(parsed))
  }
}

function validateDefinition(definition: V2TransformDefinition): void {
  validateName(definition.name)
  validateVersion(definition.version)
  validateInputRoles(definition.inputRoles)
  if (definition.identityMode !== 'preserve' && definition.identityMode !== 'derive') {
    throw new TypeError('V2 transform identityMode must be preserve or derive')
  }
  if (typeof definition.run !== 'function') {
    throw new TypeError('V2 transform run must be a function')
  }
  if (typeof definition.estimateWorkingSet !== 'function') {
    throw new TypeError('V2 transform estimateWorkingSet must be a function')
  }
  if (typeof definition.rngSeed !== 'function') {
    throw new TypeError('V2 transform rngSeed must be a function')
  }
  const json = schemaJson(definition.paramsSchema)
  if (
    json.type !== 'object' ||
    json.additionalProperties !== false ||
    !isRuntimeStrictObjectSchema(definition.paramsSchema)
  ) {
    throw new TypeError('V2 transform params schema must be a strict object schema')
  }
  parseParamsExample(definition.paramsSchema, definition.paramsExample)
}

function parseParamsExample<P extends object>(schema: z.ZodType<P>, input: unknown): P {
  const parsed = schema.parse(input)
  return deepFreeze(JsonObjectV2Schema.parse(structuredClone(parsed))) as P
}

function validateInputRoles(inputRoles: readonly string[]): void {
  if (inputRoles.length < 1 || inputRoles.length > V2_TRANSFORM_MAX_INPUTS) {
    throw new TypeError(
      `V2 transform inputRoles must contain between 1 and ${V2_TRANSFORM_MAX_INPUTS} roles`,
    )
  }
  for (const role of inputRoles) validateName(role)
}

function schemaJson(schema: z.ZodType): JsonObjectV2 {
  // Zod attaches a non-enumerable `~standard` helper to the generated object.
  // It is implementation metadata, not JSON Schema, so remove it through a
  // structured clone before enforcing the canonical JsonObject boundary.
  return JsonObjectV2Schema.parse(structuredClone(z.toJSONSchema(schema)))
}

function isRuntimeStrictObjectSchema(schema: z.ZodType): boolean {
  const internal = schema as z.ZodType & {
    readonly _zod?: {
      readonly def?: {
        readonly type?: unknown
        readonly catchall?: { readonly _zod?: { readonly def?: { readonly type?: unknown } } }
      }
    }
  }
  return (
    internal._zod?.def?.type === 'object' && internal._zod.def.catchall?._zod?.def?.type === 'never'
  )
}

function validateName(value: string): void {
  if (!TRANSFORM_NAME_PATTERN.test(value)) {
    throw new TypeError('V2 transform name must be lowercase ASCII kebab-case')
  }
  validateUtf8Length('V2 transform name', value)
}

function validateVersion(value: string): void {
  if (!TRANSFORM_VERSION_PATTERN.test(value)) {
    throw new TypeError('V2 transform version must be lowercase ASCII')
  }
  validateUtf8Length('V2 transform version', value)
}

function validateUtf8Length(name: string, value: string): void {
  if (new TextEncoder().encode(value).byteLength > MAX_IDENTITY_STRING_BYTES) {
    throw new TypeError(`${name} must be at most ${MAX_IDENTITY_STRING_BYTES} UTF-8 bytes`)
  }
}

function asciiCompare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}
