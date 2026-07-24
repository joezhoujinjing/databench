import { readFileSync } from 'node:fs'
import {
  type ConverterAnalysisV2,
  ConverterAnalysisV2Schema,
  type ConverterNameV2,
  createExportPlanV2,
  createRecordRevisionV2,
  IntegrityError,
  type JsonObjectV2,
  type PostTrainingRecordV2,
  type RecordRevisionV2,
} from '@databench/schema'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import {
  createDefaultV2ConverterRegistry,
  type V2ConverterDefinition,
  V2ConverterRegistry,
} from '../src/index.js'

const textDecoder = new TextDecoder()
const EmptyOptionsSchema = z.strictObject({})
const DATASET_VERSION = '9'.repeat(64)

interface ConverterGoldenEntry {
  readonly name: ConverterNameV2
  readonly plan: unknown
  readonly output_utf8: string
}

interface ConverterGoldenFixture {
  readonly source_fixtures: readonly string[]
  readonly dataset_version: string
  readonly converters: readonly ConverterGoldenEntry[]
}

const sourceFixtureUrl = new URL(
  '../../schema/test/golden/fixtures/v2/record-all-fields.input.json',
  import.meta.url,
)
const goldenSourceFixtureUrl = new URL(
  './golden/fixtures/v2/converter-output-bytes-and-fidelity.input.json',
  import.meta.url,
)
const goldenFixtureUrl = new URL(
  './golden/fixtures/v2/converter-output-bytes-and-fidelity.expected.json',
  import.meta.url,
)

describe('V2 converter registry and fidelity', () => {
  test('matches real output bytes, descriptors, analyses, and fidelity plan goldens', async () => {
    const fixture = readJson<ConverterGoldenFixture>(goldenFixtureUrl)
    const revisions = [
      createRecordRevisionV2(readJson<PostTrainingRecordV2>(goldenSourceFixtureUrl)),
      createRecordRevisionV2(readJson<PostTrainingRecordV2>(sourceFixtureUrl)),
    ]
    const registry = createDefaultV2ConverterRegistry()
    const descriptors = new Map(
      registry.descriptors().map((descriptor) => [descriptor.name, descriptor]),
    )

    expect(fixture.source_fixtures).toEqual([
      'packages/io/test/golden/fixtures/v2/converter-output-bytes-and-fidelity.input.json',
      'packages/schema/test/golden/fixtures/v2/record-all-fields.input.json',
    ])
    expect(fixture.dataset_version).toBe(DATASET_VERSION)
    expect(fixture.converters.map((entry) => entry.name)).toEqual([
      'canonical-jsonl',
      'ms-swift',
      'trl-dpo',
      'trl-grpo-rlvr',
      'trl-sft',
    ])

    for (const expected of fixture.converters) {
      const analysis = registry.inspect(expected.name, revisions, {})
      const output = await collectUtf8(
        registry.stream(expected.name, revisions, analysis.normalized_options, analysis),
      )
      const descriptor = descriptors.get(expected.name)
      if (!descriptor) {
        throw new TypeError(`Missing converter descriptor: ${expected.name}`)
      }
      const plan = createExportPlanV2({
        export_fidelity_profile: 'databench-export-fidelity-1',
        dataset_version: fixture.dataset_version,
        converter: expected.name,
        converter_version: descriptor.version,
        normalized_options: analysis.normalized_options,
        media_type: analysis.media_type,
        suggested_filename: analysis.suggested_filename,
        output_count: analysis.output_count,
        config_hints: analysis.config_hints,
        fidelity: analysis.fidelity,
      })

      expect(plan).toEqual(expected.plan)
      expect(output).toBe(expected.output_utf8)
      expect(new TextEncoder().encode(output)).toEqual(
        new TextEncoder().encode(expected.output_utf8),
      )
    }
  })

  test('sorts every converter by revision identity and ignores physical input order', async () => {
    const base = readJson<PostTrainingRecordV2>(sourceFixtureUrl)
    if (!base.source) {
      throw new TypeError('Golden source must contain provenance')
    }
    const second = createRecordRevisionV2({
      ...structuredClone(base),
      id: `rec_${'8'.repeat(64)}`,
      source: {
        ...base.source,
        original_id: 'order-43',
      },
    })
    const first = createRecordRevisionV2(base)
    const registry = createDefaultV2ConverterRegistry()

    for (const descriptor of registry.descriptors()) {
      const left = await inspectAndCollect(registry, descriptor.name, [first, second])
      const right = await inspectAndCollect(registry, descriptor.name, [second, first])
      expect(right).toEqual(left)
    }
  })

  test('normalizes nested open-object key order in trainer bytes', async () => {
    const original = readJson<PostTrainingRecordV2>(sourceFixtureUrl)
    const reordered = structuredClone(original)
    const candidate = reordered.candidates[0]
    const tool = reordered.tools[0]
    const verification = reordered.verification
    const callPart = candidate?.contents[0]?.parts[0]
    if (!candidate?.generator || !tool || !verification || callPart?.type !== 'function_call') {
      throw new TypeError('Golden source must contain generator, tool, verification, and call data')
    }
    candidate.generator.parameters = reverseObject(candidate.generator.parameters)
    tool.input_schema = reverseObject(tool.input_schema)
    verification.config = reverseObject(verification.config)
    callPart.function_call.args = reverseObject(callPart.function_call.args)

    const originalRevision = createRecordRevisionV2(original)
    const reorderedRevision = createRecordRevisionV2(reordered)
    expect(reorderedRevision.record_digest).toBe(originalRevision.record_digest)
    const registry = createDefaultV2ConverterRegistry()

    for (const name of ['trl-sft', 'trl-dpo', 'trl-grpo-rlvr', 'ms-swift'] as const) {
      const left = await inspectAndCollect(registry, name, [originalRevision])
      const right = await inspectAndCollect(registry, name, [reorderedRevision])
      expect(right).toEqual(left)
    }
  })

  test('does not infer SFT or DPO rows and reports selected/direction projection explicitly', () => {
    const original = readJson<PostTrainingRecordV2>(sourceFixtureUrl)
    const noSelection = structuredClone(original)
    for (const candidate of noSelection.candidates) {
      candidate.selected = null
    }
    const noPreference = structuredClone(original)
    noPreference.preference_relations = []
    const registry = createDefaultV2ConverterRegistry()

    expect(
      registry.inspect('trl-sft', [createRecordRevisionV2(noSelection)], {}).output_count,
    ).toBe(0)
    expect(
      registry.inspect('trl-dpo', [createRecordRevisionV2(noPreference)], {}).output_count,
    ).toBe(0)

    const sft = registry.inspect('trl-sft', [createRecordRevisionV2(original)], {})
    expect(sft.fidelity.changes).toContainEqual({
      path: '/candidates',
      action: 'transformed',
      impact: 'none',
      reason: 'selected_candidate_row_projection',
    })
    expect(sft.fidelity.changes).toContainEqual({
      path: '/candidates',
      action: 'dropped',
      impact: 'semantic',
      reason: 'non_selected_candidate_state_not_exported',
    })

    const dpo = registry.inspect('trl-dpo', [createRecordRevisionV2(original)], {})
    expect(dpo.fidelity.changes).toContainEqual({
      path: '/preference_relations',
      action: 'transformed',
      impact: 'none',
      reason: 'preference_direction_to_chosen_rejected',
    })
    expect(dpo.fidelity.changes).toContainEqual({
      path: '/preference_relations',
      action: 'dropped',
      impact: 'semantic',
      reason: 'preference_criterion_not_represented',
    })
    expect(dpo.fidelity.changes).toContainEqual({
      path: '/candidates',
      action: 'dropped',
      impact: 'semantic',
      reason: 'candidate_loss_mask_not_representable_by_dpo',
    })
  })

  test('reports semantic exclusion for every ineligible trainer record in mixed datasets', async () => {
    const source = readJson<PostTrainingRecordV2>(sourceFixtureUrl)
    const eligible = createRecordRevisionV2(source)
    const cases = [
      {
        name: 'trl-sft' as const,
        reason: 'sft_ineligible_record_excluded',
        record: withRecordId(source, '1', (record) => {
          for (const candidate of record.candidates) candidate.selected = null
        }),
      },
      {
        name: 'trl-dpo' as const,
        reason: 'dpo_ineligible_record_excluded',
        record: withRecordId(source, '2', (record) => {
          record.preference_relations = []
        }),
      },
      {
        name: 'trl-grpo-rlvr' as const,
        reason: 'rlvr_ineligible_record_excluded',
        record: withRecordId(source, '3', (record) => {
          record.verification = null
        }),
      },
      {
        name: 'ms-swift' as const,
        reason: 'ms_swift_ineligible_record_excluded',
        record: withRecordId(source, '4', (record) => {
          for (const candidate of record.candidates) candidate.selected = null
        }),
      },
    ]
    const registry = createDefaultV2ConverterRegistry()

    for (const testCase of cases) {
      const ineligible = createRecordRevisionV2(testCase.record)
      const excluded = registry.inspect(testCase.name, [ineligible], {})
      expect(excluded.output_count, testCase.name).toBe(0)
      expect(excluded.fidelity.changes, testCase.name).toContainEqual({
        path: '',
        action: 'dropped',
        impact: 'semantic',
        reason: testCase.reason,
      })

      const mixed = await inspectAndCollect(registry, testCase.name, [ineligible, eligible])
      expect(mixed.analysis.output_count, testCase.name).toBe(1)
      expect(nonEmptyLines(mixed.output), testCase.name).toHaveLength(1)
      expect(mixed.analysis.fidelity.changes, testCase.name).toContainEqual({
        path: '',
        action: 'dropped',
        impact: 'semantic',
        reason: testCase.reason,
      })
    }
  })

  test('writes TRL tool call IDs with structured JSON object arguments', async () => {
    const revision = createRecordRevisionV2(readJson<PostTrainingRecordV2>(sourceFixtureUrl))
    const registry = createDefaultV2ConverterRegistry()

    for (const name of ['trl-sft', 'trl-dpo'] as const) {
      const result = await inspectAndCollect(registry, name, [revision])
      const row = JSON.parse(nonEmptyLines(result.output)[0] ?? '{}') as JsonObjectV2
      const messages =
        name === 'trl-sft' ? (row.completion as JsonObjectV2[]) : (row.chosen as JsonObjectV2[])
      const call = messages.find((message) => Array.isArray(message.tool_calls))
      const toolCall = (call?.tool_calls as JsonObjectV2[] | undefined)?.[0]
      const functionCall = toolCall?.function as JsonObjectV2 | undefined

      expect(toolCall?.id, name).toBe('call-order-42')
      expect(functionCall?.arguments, name).toEqual({ order_id: '42' })
      expect(typeof functionCall?.arguments, name).toBe('object')
    }
  })

  test('keeps inspect side-effect-free and binds stream to the exact analysis', async () => {
    const revision = createRecordRevisionV2(readJson<PostTrainingRecordV2>(sourceFixtureUrl))
    const inspectSpy = vi.fn()
    const streamSpy = vi.fn()
    const custom = customCanonicalConverter(inspectSpy, streamSpy)
    const registry = new V2ConverterRegistry([custom])

    const analysis = registry.inspect('canonical-jsonl', [revision], {})
    expect(inspectSpy).toHaveBeenCalledOnce()
    expect(streamSpy).not.toHaveBeenCalled()
    expect(Object.isFrozen(analysis)).toBe(true)
    expect(Object.isFrozen(analysis.fidelity)).toBe(true)

    const before = structuredClone(analysis)
    const byteStream = registry.stream(
      'canonical-jsonl',
      [revision],
      analysis.normalized_options,
      analysis,
    )
    expect(streamSpy).not.toHaveBeenCalled()
    const output = await collectUtf8(byteStream)
    expect(output).toBe('custom\n')
    expect(streamSpy).toHaveBeenCalledOnce()
    expect(analysis).toEqual(before)

    const forged = ConverterAnalysisV2Schema.parse(structuredClone(analysis))
    expect(() => registry.stream('canonical-jsonl', [revision], {}, forged)).toThrow(IntegrityError)
    expect(() => registry.inspect('canonical-jsonl', [revision], { unknown: true })).toThrow()
  })

  test('streams rows lazily and stops projecting after consumer return', async () => {
    const original = readJson<PostTrainingRecordV2>(sourceFixtureUrl)
    if (!original.source) {
      throw new TypeError('Golden source must contain provenance')
    }
    const first = createRecordRevisionV2(original)
    const second = createRecordRevisionV2({
      ...structuredClone(original),
      id: `rec_${'8'.repeat(64)}`,
      source: { ...original.source, original_id: 'order-43' },
    })
    const streamSpy = vi.fn()
    const registry = new V2ConverterRegistry([customCanonicalConverter(vi.fn(), streamSpy)])
    const analysis = registry.inspect('canonical-jsonl', [first, second], {})
    const stream = registry.stream('canonical-jsonl', [first, second], {}, analysis)
    const iterator = stream[Symbol.asyncIterator]()

    expect(streamSpy).not.toHaveBeenCalled()
    expect((await iterator.next()).done).toBe(false)
    expect(streamSpy).toHaveBeenCalledOnce()
    await iterator.return?.()
    expect(streamSpy).toHaveBeenCalledOnce()
  })

  test('snapshots descriptor task views and detects options-schema mutation', () => {
    const taskViews: Array<'canonical' | 'sft'> = ['canonical']
    const mutableOptions = z.strictObject({})
    const definition = customCanonicalConverter(vi.fn(), vi.fn())
    const registry = new V2ConverterRegistry([
      {
        ...definition,
        taskViews,
        optionsSchema: mutableOptions,
      },
    ])
    const descriptor = registry.descriptors()[0]
    if (!descriptor) {
      throw new TypeError('Expected one converter descriptor')
    }

    taskViews[0] = 'sft'
    expect(descriptor.task_views).toEqual(['canonical'])
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(Object.isFrozen(descriptor.options_schema)).toBe(true)

    ;(mutableOptions.shape as Record<string, z.ZodType>).late_field = z.string()
    expect(() => registry.parseOptions('canonical-jsonl', {})).toThrow(IntegrityError)
  })

  test('retains the original options parser when the exposed schema parse method is replaced', () => {
    const mutableOptions = z.strictObject({})
    const definition = customCanonicalConverter(vi.fn(), vi.fn())
    const registry = new V2ConverterRegistry([
      {
        ...definition,
        optionsSchema: mutableOptions,
      },
    ])
    const replacementParser = vi.fn(() => ({ injected: true }))

    Object.defineProperty(mutableOptions, 'parse', {
      configurable: true,
      value: replacementParser,
    })

    expect(registry.parseOptions('canonical-jsonl', {})).toEqual({})
    expect(replacementParser).not.toHaveBeenCalled()
    expect(() => registry.parseOptions('canonical-jsonl', { unknown: true })).toThrow()
  })

  test('rejects inspect media type drift from the converter descriptor', () => {
    const revision = createRecordRevisionV2(readJson<PostTrainingRecordV2>(sourceFixtureUrl))
    const definition = customCanonicalConverter(vi.fn(), vi.fn())
    const registry = new V2ConverterRegistry([
      {
        ...definition,
        inspect(records, options) {
          return ConverterAnalysisV2Schema.parse({
            ...definition.inspect(records, options),
            media_type: 'application/json',
          })
        },
      },
    ])

    expect(() => registry.inspect('canonical-jsonl', [revision], {})).toThrow(IntegrityError)
  })

  test('exports ms-swift agent roles, JSON-string tools, and compatibility hints', async () => {
    const revision = createRecordRevisionV2(readJson<PostTrainingRecordV2>(sourceFixtureUrl))
    const registry = createDefaultV2ConverterRegistry()
    const analysis = registry.inspect('ms-swift', [revision], {})
    const output = await collectUtf8(
      registry.stream('ms-swift', [revision], analysis.normalized_options, analysis),
    )
    const row = JSON.parse(output) as {
      messages: Array<{ role: string; content: string; loss_scale?: number }>
      tools: string
    }

    expect(row.messages.map((message) => message.role)).toContain('tool_call')
    expect(row.messages.map((message) => message.role)).toContain('tool_response')
    expect(row.messages.find((message) => message.role === 'tool_call')?.loss_scale).toBe(1)
    expect(typeof row.tools).toBe('string')
    expect(JSON.parse(row.tools)).toBeInstanceOf(Array)
    expect(analysis.config_hints).toEqual({
      dataset_format: 'messages',
      minimum_version: '4.2.0',
      is_binary_loss_scale: true,
    })
    expect(analysis.fidelity.changes).toContainEqual({
      path: '/candidates',
      action: 'dropped',
      impact: 'semantic',
      reason: 'function_call_id_not_representable',
    })
  })

  test('exports canonical system content directly and maps canonical ai to assistant', async () => {
    const record = readJson<PostTrainingRecordV2>(sourceFixtureUrl)
    const system = record.contents[0]
    const systemPart = system?.parts[0]
    if (
      (system?.role as string | undefined) !== 'system' ||
      systemPart?.type !== 'text' ||
      system.parts.length !== 1 ||
      system.loss_weight !== 0
    ) {
      throw new TypeError('Converter source must begin with canonical system text content')
    }

    const revision = createRecordRevisionV2(record)
    const registry = createDefaultV2ConverterRegistry()
    const canonical = registry.inspect('canonical-jsonl', [revision], {})
    expect(canonical.fidelity.preserved).toContain('/contents')
    expect(canonical.fidelity.preserved).not.toContain('/system_instruction')
    const projections = [
      { name: 'trl-sft' as const, promptField: 'prompt', assistantField: 'completion' },
      { name: 'trl-dpo' as const, promptField: 'prompt', assistantField: 'chosen' },
      { name: 'trl-grpo-rlvr' as const, promptField: 'prompt', assistantField: null },
      { name: 'ms-swift' as const, promptField: 'messages', assistantField: 'messages' },
    ]

    for (const projection of projections) {
      const result = await inspectAndCollect(registry, projection.name, [revision])
      const row = JSON.parse(nonEmptyLines(result.output)[0] ?? '{}') as JsonObjectV2
      const messages = row[projection.promptField] as JsonObjectV2[]

      expect(messages[0], projection.name).toEqual({
        role: 'system',
        content: systemPart.text,
      })
      if (projection.assistantField !== null) {
        const assistantMessages = row[projection.assistantField] as JsonObjectV2[]
        expect(
          assistantMessages.some((message) => message.role === 'assistant'),
          projection.name,
        ).toBe(true)
      }
      expect(result.analysis.fidelity.preserved, projection.name).toContain('/contents')
      expect(result.analysis.fidelity.preserved, projection.name).not.toContain(
        '/system_instruction',
      )
      expect(
        result.analysis.fidelity.changes.some((change) => change.path === '/system_instruction'),
        projection.name,
      ).toBe(false)
    }
  })

  test('reports non-binary ms-swift loss scale and writes it on assistant messages', async () => {
    const record = readJson<PostTrainingRecordV2>(sourceFixtureUrl)
    const finalContent = record.candidates[0]?.contents[2]
    if (!finalContent) {
      throw new TypeError('Golden source must contain a final candidate content')
    }
    finalContent.loss_weight = 0.5
    const revision = createRecordRevisionV2(record)
    const registry = createDefaultV2ConverterRegistry()
    const analysis = registry.inspect('ms-swift', [revision], {})
    const output = await collectUtf8(
      registry.stream('ms-swift', [revision], analysis.normalized_options, analysis),
    )
    const row = JSON.parse(output) as {
      messages: Array<{ role: string; content: string; loss_scale?: number }>
    }

    expect(analysis.config_hints.is_binary_loss_scale).toBe(false)
    expect(
      row.messages.find((message) => message.content === 'Order 42 has shipped.')?.loss_scale,
    ).toBe(0.5)
  })

  test('preserves empty text parts as explicit trainer messages', async () => {
    const record = readJson<PostTrainingRecordV2>(goldenSourceFixtureUrl)
    const promptPart = record.contents[0]?.parts[0]
    const completionPart = record.candidates[0]?.contents[0]?.parts[0]
    if (promptPart?.type !== 'text' || completionPart?.type !== 'text') {
      throw new TypeError('Converter golden source must contain text prompt and completion parts')
    }
    promptPart.text = ''
    completionPart.text = ''
    const revision = createRecordRevisionV2(record)
    const registry = createDefaultV2ConverterRegistry()

    const sft = await inspectAndCollect(registry, 'trl-sft', [revision])
    const sftRow = JSON.parse(nonEmptyLines(sft.output)[0] ?? '{}') as {
      prompt: Array<{ content: string }>
      completion: Array<{ content: string }>
    }
    expect(sftRow.prompt[0]?.content).toBe('')
    expect(sftRow.completion[0]?.content).toBe('')

    const swift = await inspectAndCollect(registry, 'ms-swift', [revision])
    const swiftRow = JSON.parse(nonEmptyLines(swift.output)[0] ?? '{}') as {
      messages: Array<{ content: string }>
    }
    expect(swiftRow.messages.map(({ content }) => content)).toEqual(['', ''])
  })
})

function customCanonicalConverter(
  inspectSpy: ReturnType<typeof vi.fn>,
  streamSpy: ReturnType<typeof vi.fn>,
): V2ConverterDefinition<Record<string, never>> {
  return {
    name: 'canonical-jsonl',
    version: 'test-1',
    optionsSchema: EmptyOptionsSchema,
    mediaType: 'application/x-ndjson',
    taskViews: ['canonical'],
    inspect(records, options) {
      inspectSpy()
      return ConverterAnalysisV2Schema.parse({
        normalized_options: options,
        media_type: 'application/x-ndjson',
        suggested_filename: 'custom.jsonl',
        output_count: records.length,
        config_hints: {},
        fidelity: { preserved: ['/contents'], changes: [] },
      })
    },
    async *stream(records) {
      for (const _record of records) {
        streamSpy()
        yield new TextEncoder().encode('custom\n')
      }
    },
  }
}

async function inspectAndCollect(
  registry: V2ConverterRegistry,
  name: ConverterNameV2,
  records: readonly RecordRevisionV2[],
): Promise<{ readonly analysis: ConverterAnalysisV2; readonly output: string }> {
  const analysis = registry.inspect(name, records, {})
  const output = await collectUtf8(
    registry.stream(name, records, analysis.normalized_options, analysis),
  )
  return { analysis, output }
}

async function collectUtf8(source: AsyncIterable<Uint8Array>): Promise<string> {
  let output = ''
  for await (const chunk of source) {
    output += textDecoder.decode(chunk, { stream: true })
  }
  output += textDecoder.decode()
  return output
}

function reverseObject(input: JsonObjectV2): JsonObjectV2 {
  return Object.fromEntries(Object.entries(input).reverse()) as JsonObjectV2
}

function withRecordId(
  source: PostTrainingRecordV2,
  digit: string,
  mutate: (record: PostTrainingRecordV2) => void,
): PostTrainingRecordV2 {
  const record = structuredClone(source)
  record.id = `rec_${digit.repeat(64)}`
  mutate(record)
  return record
}

function nonEmptyLines(output: string): string[] {
  return output.split('\n').filter((line) => line.length > 0)
}

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf8')) as T
}
