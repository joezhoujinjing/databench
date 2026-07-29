import {
  type ConverterAnalysisV2,
  ConverterAnalysisV2Schema,
  type ConverterDescriptorV2,
  ConverterDescriptorV2Schema,
  type ConverterNameV2,
  type ConverterTaskViewV2,
  datasetVersionForSortedRecordRevisionsV2,
  IntegrityError,
  isRecordRevisionV2,
  type JsonObjectV2,
  JsonObjectV2Schema,
  NotFoundError,
  type RecordRevisionV2,
} from '@databench/schema'
import { z } from 'zod'
import {
  analyzeMsSwiftV2,
  analyzeTrlDpoV2,
  analyzeTrlGrpoRlvrV2,
  analyzeTrlSftV2,
  type ConverterProjectionV2,
  canonicalFidelityV2,
  rowsMsSwiftV2,
  rowsTrlDpoV2,
  rowsTrlGrpoRlvrV2,
  rowsTrlSftV2,
} from './converter-projection.js'
import { deterministicJsonLineV2, deterministicJsonV2 } from './deterministic-json.js'
import {
  analyzeEvalScopeGeneralQaV2,
  EvalScopeGeneralQaOptionsV2Schema,
  rowsEvalScopeGeneralQaV2,
} from './evalscope-general-qa.js'

const V2_CONVERTER_VERSION = '1.0.0'
const V2_EXPORT_FIDELITY_PROFILE = 'databench-export-fidelity-1'
const V2_CONVERTER_MEDIA_TYPE = 'application/x-ndjson'
const EmptyConverterOptionsSchema = z.strictObject({})

export type V2ConverterOptionsSchema<TOptions extends JsonObjectV2 = JsonObjectV2> =
  z.ZodType<TOptions>

export interface V2ConverterDefinition<TOptions extends JsonObjectV2 = JsonObjectV2> {
  readonly name: ConverterNameV2
  readonly version: string
  readonly optionsSchema: V2ConverterOptionsSchema<TOptions>
  readonly mediaType: string
  readonly taskViews: readonly ConverterTaskViewV2[]
  inspect(records: readonly RecordRevisionV2[], options: TOptions): ConverterAnalysisV2
  stream(
    records: readonly RecordRevisionV2[],
    normalizedOptions: TOptions,
    analysis: ConverterAnalysisV2,
  ): AsyncIterable<Uint8Array>
}

interface AnalysisBindingV2 {
  readonly converter: ConverterNameV2
  readonly version: string
  readonly revisionSignature: string
  readonly normalizedOptionsJson: string
  readonly analysisJson: string
}

type V2OptionsParser = (input: unknown) => unknown

export class V2ConverterRegistry {
  readonly #definitions: ReadonlyMap<ConverterNameV2, V2ConverterDefinition>
  readonly #ordered: readonly V2ConverterDefinition[]
  readonly #descriptors: readonly ConverterDescriptorV2[]
  readonly #optionsParsers: ReadonlyMap<ConverterNameV2, V2OptionsParser>
  readonly #optionsSchemaSnapshots: ReadonlyMap<ConverterNameV2, string>
  readonly #analysisBindings = new WeakMap<object, AnalysisBindingV2>()

  constructor(definitions: Iterable<V2ConverterDefinition>) {
    const byName = new Map<ConverterNameV2, V2ConverterDefinition>()
    const descriptorByName = new Map<ConverterNameV2, ConverterDescriptorV2>()
    const optionsParsers = new Map<ConverterNameV2, V2OptionsParser>()
    const optionsSchemaSnapshots = new Map<ConverterNameV2, string>()
    for (const definition of definitions) {
      validateDefinition(definition)
      if (byName.has(definition.name)) {
        throw new TypeError(`Duplicate V2 converter name: ${definition.name}`)
      }
      const retained = Object.freeze({
        ...definition,
        taskViews: Object.freeze([...definition.taskViews]),
      })
      const optionsSchema = schemaJson(retained.optionsSchema)
      byName.set(definition.name, retained)
      descriptorByName.set(
        definition.name,
        deepFreeze(
          ConverterDescriptorV2Schema.parse({
            name: retained.name,
            version: retained.version,
            options_schema: optionsSchema,
            media_type: retained.mediaType,
            task_views: [...retained.taskViews],
            export_fidelity_profile: V2_EXPORT_FIDELITY_PROFILE,
          }),
        ),
      )
      optionsParsers.set(definition.name, retained.optionsSchema.parse.bind(retained.optionsSchema))
      optionsSchemaSnapshots.set(definition.name, deterministicJsonV2(optionsSchema))
    }
    this.#definitions = byName
    this.#ordered = Object.freeze([...byName.values()].sort((a, b) => asciiCompare(a.name, b.name)))
    this.#descriptors = Object.freeze(
      this.#ordered.map((definition) => {
        const descriptor = descriptorByName.get(definition.name)
        if (!descriptor) {
          throw new IntegrityError('V2 converter descriptor snapshot is missing', {
            converter: definition.name,
          })
        }
        return descriptor
      }),
    )
    this.#optionsParsers = optionsParsers
    this.#optionsSchemaSnapshots = optionsSchemaSnapshots
  }

  get(name: string): V2ConverterDefinition | null {
    return this.#definitions.get(name as ConverterNameV2) ?? null
  }

  require(name: string): V2ConverterDefinition {
    const converter = this.get(name)
    if (!converter) {
      throw new NotFoundError(`V2 converter not found: ${name}`, { converter: name })
    }
    return converter
  }

  list(): readonly V2ConverterDefinition[] {
    return this.#ordered
  }

  descriptors(): readonly ConverterDescriptorV2[] {
    return this.#descriptors
  }

  parseOptions(name: string, input: unknown): JsonObjectV2 {
    const definition = this.require(name)
    const currentSchema = deterministicJsonV2(schemaJson(definition.optionsSchema))
    if (currentSchema !== this.#optionsSchemaSnapshots.get(definition.name)) {
      throw new IntegrityError('V2 converter options schema changed after registry construction', {
        converter: definition.name,
      })
    }
    const parser = this.#optionsParsers.get(definition.name)
    if (!parser) {
      throw new IntegrityError('V2 converter options parser snapshot is missing', {
        converter: definition.name,
      })
    }
    const parsed = parser(input)
    return deepFreeze(JsonObjectV2Schema.parse(parsed))
  }

  inspect(
    name: string,
    recordsInput: readonly RecordRevisionV2[],
    optionsInput: unknown,
  ): ConverterAnalysisV2 {
    const definition = this.require(name)
    const records = stableRevisions(recordsInput)
    const options = this.parseOptions(name, optionsInput)
    const analysis = deepFreeze(
      ConverterAnalysisV2Schema.parse(definition.inspect(records, options)),
    )
    if (analysis.media_type !== definition.mediaType) {
      throw new IntegrityError('V2 converter inspect media type does not match its descriptor', {
        converter: definition.name,
      })
    }
    const normalizedOptionsJson = deterministicJsonV2(analysis.normalized_options)
    if (normalizedOptionsJson !== deterministicJsonV2(options)) {
      throw new IntegrityError('V2 converter inspect changed already-normalized options', {
        converter: definition.name,
      })
    }
    this.#analysisBindings.set(analysis, {
      converter: definition.name,
      version: definition.version,
      revisionSignature: revisionSignature(records),
      normalizedOptionsJson,
      analysisJson: deterministicJsonV2(analysis),
    })
    return analysis
  }

  stream(
    name: string,
    recordsInput: readonly RecordRevisionV2[],
    normalizedOptionsInput: unknown,
    analysis: ConverterAnalysisV2,
  ): AsyncIterable<Uint8Array> {
    const definition = this.require(name)
    const records = stableRevisions(recordsInput)
    const normalizedOptions = this.parseOptions(name, normalizedOptionsInput)
    const binding = this.#analysisBindings.get(analysis)
    if (
      !binding ||
      binding.converter !== definition.name ||
      binding.version !== definition.version ||
      binding.revisionSignature !== revisionSignature(records) ||
      binding.normalizedOptionsJson !== deterministicJsonV2(normalizedOptions) ||
      binding.analysisJson !== deterministicJsonV2(analysis)
    ) {
      throw new IntegrityError(
        'V2 converter stream requires the exact immutable inspect analysis',
        {
          converter: definition.name,
        },
      )
    }
    return definition.stream(records, normalizedOptions, analysis)
  }
}

export function createDefaultV2ConverterRegistry(): V2ConverterRegistry {
  return new V2ConverterRegistry([
    defineCanonicalJsonlConverter(),
    defineEvalScopeGeneralQaConverter(),
    defineProjectedConverter('trl-sft', ['sft'], 'trl-sft.jsonl', analyzeTrlSftV2, rowsTrlSftV2),
    defineProjectedConverter('trl-dpo', ['dpo'], 'trl-dpo.jsonl', analyzeTrlDpoV2, rowsTrlDpoV2),
    defineProjectedConverter(
      'trl-grpo-rlvr',
      ['rlvr-grpo'],
      'trl-grpo-rlvr.jsonl',
      analyzeTrlGrpoRlvrV2,
      rowsTrlGrpoRlvrV2,
    ),
    defineProjectedConverter(
      'ms-swift',
      ['ms-swift'],
      'ms-swift.jsonl',
      analyzeMsSwiftV2,
      rowsMsSwiftV2,
    ),
  ])
}

function defineEvalScopeGeneralQaConverter(): V2ConverterDefinition {
  return Object.freeze({
    name: 'evalscope-general-qa',
    version: V2_CONVERTER_VERSION,
    optionsSchema: EvalScopeGeneralQaOptionsV2Schema,
    mediaType: V2_CONVERTER_MEDIA_TYPE,
    taskViews: ['evaluation-qa'] as const,
    inspect(records: readonly RecordRevisionV2[], options: JsonObjectV2) {
      const normalizedOptions = EvalScopeGeneralQaOptionsV2Schema.parse(options)
      const projection = analyzeEvalScopeGeneralQaV2(records, normalizedOptions)
      return ConverterAnalysisV2Schema.parse({
        normalized_options: normalizedOptions,
        media_type: V2_CONVERTER_MEDIA_TYPE,
        suggested_filename: 'databench.jsonl',
        output_count: projection.outputCount,
        config_hints: projection.configHints,
        fidelity: projection.fidelity,
      })
    },
    async *stream(
      records: readonly RecordRevisionV2[],
      options: JsonObjectV2,
      analysis: ConverterAnalysisV2,
    ) {
      const normalizedOptions = EvalScopeGeneralQaOptionsV2Schema.parse(options)
      let outputCount = 0
      for (const row of rowsEvalScopeGeneralQaV2(records, normalizedOptions)) {
        outputCount += 1
        if (outputCount > analysis.output_count) {
          throw new IntegrityError(
            'EvalScope general_qa converter produced more rows than inspected',
          )
        }
        yield deterministicJsonLineV2(row)
      }
      if (outputCount !== analysis.output_count) {
        throw new IntegrityError(
          'EvalScope general_qa converter produced fewer rows than inspected',
        )
      }
    },
  })
}

function defineCanonicalJsonlConverter(): V2ConverterDefinition<Record<string, never>> {
  return Object.freeze({
    name: 'canonical-jsonl',
    version: V2_CONVERTER_VERSION,
    optionsSchema: EmptyConverterOptionsSchema,
    mediaType: V2_CONVERTER_MEDIA_TYPE,
    taskViews: ['canonical'] as const,
    inspect(records: readonly RecordRevisionV2[], options: Record<string, never>) {
      return ConverterAnalysisV2Schema.parse({
        normalized_options: options,
        media_type: V2_CONVERTER_MEDIA_TYPE,
        suggested_filename: 'canonical.jsonl',
        output_count: records.length,
        config_hints: {},
        fidelity: canonicalFidelityV2(),
      })
    },
    async *stream(
      records: readonly RecordRevisionV2[],
      _normalizedOptions: Record<string, never>,
      analysis: ConverterAnalysisV2,
    ) {
      if (analysis.output_count !== records.length) {
        throw new IntegrityError('Canonical converter output count drifted after inspect')
      }
      for (const revision of records) {
        yield new TextEncoder().encode(`${revision.record_json}\n`)
      }
    },
  })
}

function defineProjectedConverter(
  name: Exclude<ConverterNameV2, 'canonical-jsonl'>,
  taskViews: readonly ConverterTaskViewV2[],
  suggestedFilename: string,
  analyze: (records: readonly RecordRevisionV2[]) => ConverterProjectionV2,
  rows: (records: readonly RecordRevisionV2[]) => Iterable<JsonObjectV2>,
): V2ConverterDefinition<Record<string, never>> {
  return Object.freeze({
    name,
    version: V2_CONVERTER_VERSION,
    optionsSchema: EmptyConverterOptionsSchema,
    mediaType: V2_CONVERTER_MEDIA_TYPE,
    taskViews: Object.freeze([...taskViews]),
    inspect(records: readonly RecordRevisionV2[], options: Record<string, never>) {
      const projection = analyze(records)
      return ConverterAnalysisV2Schema.parse({
        normalized_options: options,
        media_type: V2_CONVERTER_MEDIA_TYPE,
        suggested_filename: suggestedFilename,
        output_count: projection.outputCount,
        config_hints: projection.configHints,
        fidelity: projection.fidelity,
      })
    },
    async *stream(
      records: readonly RecordRevisionV2[],
      _normalizedOptions: Record<string, never>,
      analysis: ConverterAnalysisV2,
    ) {
      let outputCount = 0
      for (const row of rows(records)) {
        outputCount += 1
        if (outputCount > analysis.output_count) {
          throw new IntegrityError('V2 converter produced more rows than inspected', {
            converter: name,
          })
        }
        yield deterministicJsonLineV2(row)
      }
      if (outputCount !== analysis.output_count) {
        throw new IntegrityError('V2 converter produced fewer rows than inspected', {
          converter: name,
        })
      }
    },
  })
}

function stableRevisions(input: readonly RecordRevisionV2[]): readonly RecordRevisionV2[] {
  if (!Array.isArray(input)) {
    throw new TypeError('V2 converter records must be a readonly array')
  }
  const seenIds = new Set<string>()
  let alreadySorted = true
  const retained = input.map((revision) => {
    if (!isRecordRevisionV2(revision)) {
      throw new TypeError('V2 converter requires RecordRevisionV2 values')
    }
    if (seenIds.has(revision.record.id)) {
      throw new IntegrityError('V2 converter received duplicate record logical IDs', {
        record_id: revision.record.id,
      })
    }
    seenIds.add(revision.record.id)
    return revision
  })
  for (let index = 1; index < retained.length; index += 1) {
    const previous = retained[index - 1]
    const current = retained[index]
    if (previous && current && compareRevisions(previous, current) > 0) {
      alreadySorted = false
      break
    }
  }
  if (!alreadySorted) retained.sort(compareRevisions)
  return Object.freeze(retained)
}

function revisionSignature(records: readonly RecordRevisionV2[]): string {
  return datasetVersionForSortedRecordRevisionsV2(records)
}

function compareRevisions(left: RecordRevisionV2, right: RecordRevisionV2): number {
  const digest = asciiCompare(left.record_digest, right.record_digest)
  return digest === 0 ? asciiCompare(left.record.id, right.record.id) : digest
}

function validateDefinition(definition: V2ConverterDefinition): void {
  ConverterDescriptorV2Schema.parse({
    name: definition.name,
    version: definition.version,
    options_schema: schemaJson(definition.optionsSchema),
    media_type: definition.mediaType,
    task_views: [...definition.taskViews],
    export_fidelity_profile: V2_EXPORT_FIDELITY_PROFILE,
  })
  const optionsSchema = schemaJson(definition.optionsSchema)
  if (
    optionsSchema.type !== 'object' ||
    optionsSchema.additionalProperties !== false ||
    !isRuntimeStrictObjectSchema(definition.optionsSchema)
  ) {
    throw new TypeError('V2 converter options schema must be a strict object schema')
  }
  if (typeof definition.inspect !== 'function' || typeof definition.stream !== 'function') {
    throw new TypeError('V2 converter definitions require inspect and stream functions')
  }
}

function schemaJson(schema: z.ZodType): JsonObjectV2 {
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
