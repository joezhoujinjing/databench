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
  EVALSCOPE_GENERAL_QA_EXCLUSION_REASONS,
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

interface EvalScopeGeneralQaGoldenFixture {
  readonly source_fixture: string
  readonly dataset_version: string
  readonly profiles: readonly Array<{
    readonly target_source: 'selected-candidate' | 'verification-ground-truth' | 'none'
    readonly plan: unknown
    readonly output_utf8: string
  }>
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
const evalScopeGoldenFixtureUrl = new URL(
  './golden/fixtures/v2/evalscope-general-qa.expected.json',
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
      const options =
        descriptor.name === 'evalscope-general-qa' ? { target_source: 'none' as const } : {}
      const left = await inspectAndCollect(registry, descriptor.name, [first, second], options)
      const right = await inspectAndCollect(registry, descriptor.name, [second, first], options)
      expect(right).toEqual(left)
    }
  })

  test('matches all three EvalScope general_qa profile fixed bytes and fidelity plans', async () => {
    const fixture = readJson<EvalScopeGeneralQaGoldenFixture>(evalScopeGoldenFixtureUrl)
    const revision = createRecordRevisionV2(readJson<PostTrainingRecordV2>(goldenSourceFixtureUrl))
    const registry = createDefaultV2ConverterRegistry()
    const descriptor = registry.require('evalscope-general-qa')

    expect(fixture.source_fixture).toBe(
      'packages/io/test/golden/fixtures/v2/converter-output-bytes-and-fidelity.input.json',
    )
    expect(fixture.profiles.map(({ target_source }) => target_source)).toEqual([
      'selected-candidate',
      'verification-ground-truth',
      'none',
    ])

    for (const expected of fixture.profiles) {
      const options = { target_source: expected.target_source }
      const analysis = registry.inspect('evalscope-general-qa', [revision], options)
      const output = await collectUtf8(
        registry.stream('evalscope-general-qa', [revision], options, analysis),
      )
      const plan = createExportPlanV2({
        export_fidelity_profile: 'databench-export-fidelity-1',
        dataset_version: fixture.dataset_version,
        converter: 'evalscope-general-qa',
        converter_version: descriptor.version,
        normalized_options: analysis.normalized_options,
        media_type: analysis.media_type,
        suggested_filename: analysis.suggested_filename,
        output_count: analysis.output_count,
        config_hints: analysis.config_hints,
        fidelity: analysis.fidelity,
      })

      expect(plan, expected.target_source).toEqual(expected.plan)
      expect(output, expected.target_source).toBe(expected.output_utf8)
      expect(new TextEncoder().encode(output), expected.target_source).toEqual(
        new TextEncoder().encode(expected.output_utf8),
      )
    }
  })

  test('publishes strict EvalScope options, evaluation task view, and fixed config hints', () => {
    const registry = createDefaultV2ConverterRegistry()
    const descriptor = registry.descriptors().find(({ name }) => name === 'evalscope-general-qa')
    if (!descriptor) throw new TypeError('Missing EvalScope general_qa descriptor')

    expect(descriptor).toMatchObject({
      version: '1.0.0',
      media_type: 'application/x-ndjson',
      task_views: ['evaluation-qa'],
      options_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['target_source'],
      },
    })
    expect(registry.parseOptions('evalscope-general-qa', { target_source: 'none' })).toEqual({
      target_source: 'none',
    })
    expect(() => registry.parseOptions('evalscope-general-qa', {})).toThrow()
    expect(() =>
      registry.parseOptions('evalscope-general-qa', {
        target_source: 'selected-candidate',
        field_mapping: '/unsafe',
      }),
    ).toThrow()
    expect(() =>
      registry.parseOptions('evalscope-general-qa', { target_source: 'selected' }),
    ).toThrow()

    const revision = createRecordRevisionV2(qaRecord('1', 'Question'))
    const analysis = registry.inspect('evalscope-general-qa', [revision], {
      target_source: 'none',
    })
    expect(analysis).toMatchObject({
      normalized_options: { target_source: 'none' },
      suggested_filename: 'databench.jsonl',
      output_count: 1,
      config_hints: {
        evalscope: {
          benchmark: 'general_qa',
          subset: 'databench',
          total_records: 1,
          output_count: 1,
          excluded_records: 0,
          excluded_by_reason: {},
        },
      },
    })
  })

  test('reports every bounded exclusion reason and rejects non-text prompt forms', () => {
    const registry = createDefaultV2ConverterRegistry()
    const promptCases = [
      withQaRecord('1', (record) => {
        record.contents = []
      }),
      withQaRecord('2', (record) => {
        record.contents.push(textContent('ai', 'unfinished answer'))
      }),
      withQaRecord('3', (record) => {
        record.contents[0]?.parts.push(textPart('second part'))
      }),
      withQaRecord('4', (record) => {
        const content = record.contents[0]
        if (!content) throw new TypeError('Expected prompt content')
        content.parts = [
          {
            type: 'file_data',
            file_data: {
              uri: 's3://evalscope-fixtures/prompt.png',
              media_type: 'image/png',
              digest: { algorithm: 'blake3', value: '1'.repeat(64) },
              size_bytes: 1,
            },
            thought: false,
            thought_signature: null,
            part_metadata: {},
          },
        ]
      }),
      withQaRecord('5', (record) => {
        const part = record.contents[0]?.parts[0]
        if (part?.type !== 'text') throw new TypeError('Expected text prompt')
        part.thought = true
      }),
      functionTrajectoryRecord('6'),
      withQaRecord('7', (record) => {
        record.tools = [fixtureTool()]
      }),
    ].map(createRecordRevisionV2)
    const promptAnalysis = registry.inspect('evalscope-general-qa', promptCases, {
      target_source: 'none',
    })
    expect(evalScopeSummary(promptAnalysis)).toEqual({
      benchmark: 'general_qa',
      subset: 'databench',
      total_records: 7,
      output_count: 0,
      excluded_records: 7,
      excluded_by_reason: {
        prompt_empty: 1,
        prompt_not_user_terminated: 1,
        prompt_not_text_only: 4,
        tools_not_supported: 1,
      },
    })

    const missingSelected = createRecordRevisionV2(qaRecord('8', 'No selected answer'))
    const incompatibleSelected = createRecordRevisionV2(
      withQaRecord('9', (record) => {
        record.candidates = [selectedCandidate('9', 'answer')]
        record.candidates[0]?.contents[0]?.parts.push(textPart('extra'))
      }),
    )
    const selectedAnalysis = registry.inspect(
      'evalscope-general-qa',
      [missingSelected, incompatibleSelected],
      { target_source: 'selected-candidate' },
    )
    expect(evalScopeSummary(selectedAnalysis).excluded_by_reason).toEqual({
      selected_candidate_missing: 1,
      selected_candidate_not_text_only: 1,
    })

    const missingVerification = createRecordRevisionV2(qaRecord('a', 'No verification'))
    const nonStringVerification = createRecordRevisionV2(
      withQaRecord('b', (record) => {
        record.verification = verification({ answer: 42 })
      }),
    )
    const verificationAnalysis = registry.inspect(
      'evalscope-general-qa',
      [missingVerification, nonStringVerification],
      { target_source: 'verification-ground-truth' },
    )
    expect(evalScopeSummary(verificationAnalysis).excluded_by_reason).toEqual({
      verification_missing: 1,
      verification_ground_truth_not_string: 1,
    })
    expect([
      ...Object.keys(evalScopeSummary(promptAnalysis).excluded_by_reason),
      ...Object.keys(evalScopeSummary(selectedAnalysis).excluded_by_reason),
      ...Object.keys(evalScopeSummary(verificationAnalysis).excluded_by_reason),
    ]).toEqual(EVALSCOPE_GENERAL_QA_EXCLUSION_REASONS)
  })

  test('keeps Unicode and empty text exact, expands selected rows, and binds profile options', async () => {
    const source = withQaRecord('c', (record) => {
      const prompt = record.contents[0]?.parts[0]
      if (prompt?.type !== 'text') throw new TypeError('Expected text prompt')
      prompt.text = '  问题 🌏\n第二行  '
      record.candidates = [selectedCandidate('c', ''), selectedCandidate('d', '  答案 🌟  ')]
      record.verification = verification('')
    })
    const revision = createRecordRevisionV2(source)
    const registry = createDefaultV2ConverterRegistry()
    const analysis = registry.inspect('evalscope-general-qa', [revision], {
      target_source: 'selected-candidate',
    })
    expect(analysis.output_count).toBe(2)
    const output = await collectUtf8(
      registry.stream('evalscope-general-qa', [revision], analysis.normalized_options, analysis),
    )
    const rows = nonEmptyLines(output).map(
      (line) => JSON.parse(line) as { messages: Array<{ content: string }>; response: string },
    )
    expect(rows.map(({ response }) => response)).toEqual(['', '  答案 🌟  '])
    expect(rows.map(({ messages }) => messages[0]?.content)).toEqual([
      '  问题 🌏\n第二行  ',
      '  问题 🌏\n第二行  ',
    ])
    expect(() =>
      registry.stream('evalscope-general-qa', [revision], { target_source: 'none' }, analysis),
    ).toThrow(IntegrityError)

    const groundTruth = await inspectAndCollect(registry, 'evalscope-general-qa', [revision], {
      target_source: 'verification-ground-truth',
    })
    expect(JSON.parse(groundTruth.output)).toMatchObject({ response: '' })
    const noReference = await inspectAndCollect(registry, 'evalscope-general-qa', [revision], {
      target_source: 'none',
    })
    expect(JSON.parse(noReference.output)).not.toHaveProperty('response')
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
  options: JsonObjectV2 = {},
): Promise<{ readonly analysis: ConverterAnalysisV2; readonly output: string }> {
  const analysis = registry.inspect(name, records, options)
  const output = await collectUtf8(registry.stream(name, records, options, analysis))
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

function qaRecord(idDigit: string, text: string): PostTrainingRecordV2 {
  return {
    schema_version: '2.0.0',
    id: `rec_${idDigit.repeat(64)}`,
    contents: [textContent('user', text)],
    candidates: [],
    preference_relations: [],
    tools: [],
    verification: null,
    source: null,
    lang: null,
    lineage: null,
    tags: [],
    extra: {},
  }
}

function withQaRecord(
  idDigit: string,
  mutate: (record: PostTrainingRecordV2) => void,
): PostTrainingRecordV2 {
  const record = qaRecord(idDigit, 'Question')
  mutate(record)
  return record
}

function textContent(role: 'system' | 'user' | 'ai', text: string) {
  return {
    role,
    parts: [textPart(text)],
    loss_weight: role === 'system' ? 0 : null,
  }
}

function textPart(text: string) {
  return {
    type: 'text' as const,
    text,
    thought: false,
    thought_signature: null,
    part_metadata: {},
  }
}

function selectedCandidate(idDigit: string, text: string) {
  return {
    id: `cand_${idDigit.repeat(64)}`,
    contents: [textContent('ai', text)],
    finish_reason: null,
    rank: null,
    selected: true,
    signals: [],
    generator: null,
    token_count: null,
    avg_logprobs: null,
  }
}

function verification(groundTruth: JsonObjectV2 | string) {
  return {
    verifier: 'fixture-verifier',
    verifier_version: '1',
    ground_truth: groundTruth,
    constraint: null,
    config: {},
  }
}

function fixtureTool() {
  return {
    name: 'lookup',
    description: null,
    input_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
    },
  }
}

function functionTrajectoryRecord(idDigit: string): PostTrainingRecordV2 {
  const record = qaRecord(idDigit, 'Use the tool')
  record.tools = [fixtureTool()]
  record.contents = [
    textContent('user', 'Use the tool'),
    {
      role: 'ai',
      parts: [
        {
          type: 'function_call',
          function_call: { id: 'call-1', name: 'lookup', args: {} },
          thought: false,
          thought_signature: null,
          part_metadata: {},
        },
      ],
      loss_weight: null,
    },
    {
      role: 'user',
      parts: [
        {
          type: 'function_response',
          function_response: { call_id: 'call-1', response: 'done' },
          thought: false,
          thought_signature: null,
          part_metadata: {},
        },
      ],
      loss_weight: null,
    },
  ]
  return record
}

function evalScopeSummary(analysis: ConverterAnalysisV2): {
  benchmark: string
  subset: string
  total_records: number
  output_count: number
  excluded_records: number
  excluded_by_reason: Record<string, number>
} {
  return analysis.config_hints.evalscope as {
    benchmark: string
    subset: string
    total_records: number
    output_count: number
    excluded_records: number
    excluded_by_reason: Record<string, number>
  }
}

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf8')) as T
}
