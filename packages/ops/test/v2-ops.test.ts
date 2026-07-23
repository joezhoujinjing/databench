import { readFileSync } from 'node:fs'
import { DEFAULT_V2_DATASET_LIMITS, V2Dataset } from '@databench/engine'
import {
  type IdentityCreationRequestV1,
  type PostTrainingRecordV2,
  prepareIdentityClaimV2,
  type RecordRevisionV2,
} from '@databench/schema'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  AppendEvidenceV2ParamsSchema,
  appendEvidenceV2,
  BUILTIN_V2_TRANSFORM_REGISTRY,
  createDeterministicRngV2,
  createV2TransformContext,
  defineV2Transform,
  type EventIdentityRequestV2,
  PromptRewriteV2ParamsSchema,
  promptRewriteV2,
  SampleV2ParamsSchema,
  SelectionUpdateV2ParamsSchema,
  SubsetV2ParamsSchema,
  sampleV2,
  selectionUpdateV2,
  subsetV2,
  type V2IdentityAllocator,
  V2TransformRegistry,
} from '../src/index.js'

const NAMESPACE = '123e4567-e89b-12d3-a456-426614174000'
const RUN_ID = `run_${'a'.repeat(64)}`
const RECORD_1 = `rec_${'1'.repeat(64)}`
const RECORD_2 = `rec_${'2'.repeat(64)}`
const RECORD_3 = `rec_${'3'.repeat(64)}`
const CANDIDATE_1 = `cand_${'a'.repeat(64)}`
const CANDIDATE_2 = `cand_${'b'.repeat(64)}`
const SIGNAL_1 = `sig_${'c'.repeat(64)}`
const PREFERENCE_1 = `pref_${'d'.repeat(64)}`

interface TransformGoldenFixture {
  readonly fixture_version: 1
  readonly operations: readonly {
    readonly name: string
    readonly version: '1'
    readonly input_roles: readonly string[]
    readonly params: Readonly<Record<string, unknown>>
    readonly identity_mode: 'preserve' | 'derive'
  }[]
  readonly rng: {
    readonly algorithm: 'mulberry32-v1'
    readonly seed: number
    readonly next_uint32: readonly number[]
    readonly next_int: readonly {
      readonly seed: number
      readonly max_exclusive: number
      readonly value: number
    }[]
  }
  readonly sample: {
    readonly input_dataset_version: string
    readonly params: { readonly count: number; readonly seed: number }
    readonly output_record_ids: readonly string[]
    readonly output_dataset_version: string
  }
  readonly append_evidence: {
    readonly output_dataset_version: string
    readonly changed_record_digest: string
  }
  readonly selection_update: {
    readonly output_dataset_version: string
    readonly changed_record_digest: string
  }
  readonly prompt_rewrite: {
    readonly output_index: 0
    readonly parent_count: 1
  }
}

const transformFixture = JSON.parse(
  readFileSync(
    new URL(
      '../../workspace/test/golden/fixtures/v2/transform-identity-cache-race.fixture.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as TransformGoldenFixture

const INPUT_ROLES_BY_OPERATION: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'append-evidence': Object.freeze(['base', 'patch']),
  'prompt-rewrite': Object.freeze(['base', 'rewrite']),
  sample: Object.freeze(['base']),
  'selection-update': Object.freeze(['base', 'patch']),
  subset: Object.freeze(['base']),
})

type CanonicalRecordViewV2 = RecordRevisionV2['record']

function textContent(role: 'user' | 'ai', text: string) {
  return {
    role,
    parts: [
      {
        type: 'text' as const,
        text,
        thought: false,
        thought_signature: null,
        part_metadata: {},
      },
    ],
    loss_weight: null,
  }
}

function record(id: string, prompt: string, withCandidates = false): PostTrainingRecordV2 {
  return {
    schema_version: '2.0.0',
    id,
    system_instruction: null,
    contents: [textContent('user', prompt)],
    candidates: withCandidates
      ? [
          {
            id: CANDIDATE_1,
            contents: [textContent('ai', 'answer one')],
            finish_reason: null,
            rank: null,
            selected: null,
            signals: [],
            generator: null,
            token_count: null,
            avg_logprobs: null,
          },
          {
            id: CANDIDATE_2,
            contents: [textContent('ai', 'answer two')],
            finish_reason: null,
            rank: null,
            selected: null,
            signals: [],
            generator: null,
            token_count: null,
            avg_logprobs: null,
          },
        ]
      : [],
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

function baseDataset(): V2Dataset {
  return V2Dataset.fromRecords([
    record(RECORD_1, 'rank this', true),
    record(RECORD_2, 'old prompt'),
    record(RECORD_3, 'third prompt'),
  ])
}

function evidencePatch(): V2Dataset {
  const patched = record(RECORD_1, 'rank this', true)
  patched.candidates[0]?.signals.push({
    id: SIGNAL_1,
    name: 'quality',
    kind: 'rating',
    value: {
      type: 'number',
      value: 0.9,
      scale_min: 0,
      scale_max: 1,
      higher_is_better: true,
    },
    source: { type: 'ai', id: 'judge-v1', version: '1' },
    rationale: 'concise and correct',
    created_at: null,
    supersedes: null,
  })
  patched.preference_relations.push({
    id: PREFERENCE_1,
    left_candidate_id: CANDIDATE_1,
    right_candidate_id: CANDIDATE_2,
    outcome: 'left',
    status: 'adjudicated',
    criterion: 'quality',
    source: { type: 'ai', id: 'judge-v1', version: '1' },
    rationale: null,
    created_at: null,
    supersedes: null,
  })
  return V2Dataset.fromRecords([patched])
}

function selectionPatch(): V2Dataset {
  const patched = record(RECORD_1, 'rank this', true)
  const first = patched.candidates[0]
  const second = patched.candidates[1]
  if (!first || !second) throw new TypeError('selection fixture candidates are missing')
  first.selected = true
  first.rank = 0
  second.selected = false
  second.rank = 1
  return V2Dataset.fromRecords([patched])
}

function promptPatch(): V2Dataset {
  const second = record(RECORD_2, 'new prompt')
  second.system_instruction = 'Use terse answers.'
  const third = record(RECORD_3, 'rewritten third prompt')
  return V2Dataset.fromRecords([second, third])
}

function pureAllocator(captured: IdentityCreationRequestV1[] = []): V2IdentityAllocator {
  const derive = async (input: IdentityCreationRequestV1): Promise<string> => {
    captured.push(structuredClone(input))
    return prepareIdentityClaimV2(NAMESPACE, input).entity_id
  }
  const unsupported = async (): Promise<string> => {
    throw new TypeError('allocator method is not used by this operation')
  }
  return {
    allocateRoot: unsupported,
    deriveRecord: derive,
    allocateCandidate: unsupported,
    allocateEvent: async (_input: EventIdentityRequestV2) => unsupported(),
  }
}

function context(seed: number | null, allocator = pureAllocator()) {
  return createV2TransformContext({
    run_id: RUN_ID,
    identity_allocator: allocator,
    seed,
    limits: DEFAULT_V2_DATASET_LIMITS,
    working_set_budget_bytes: Number.MAX_SAFE_INTEGER,
    signal: new AbortController().signal,
  })
}

function ids(dataset: V2Dataset): string[] {
  return [...dataset.records()].map((revision) => revision.record.id)
}

describe('V2 transform registry and deterministic context', () => {
  test('publishes stable descriptors, strict params, identity mode, estimators, and RNG extractors', () => {
    const descriptors = BUILTIN_V2_TRANSFORM_REGISTRY.descriptors()
    expect(
      descriptors.map(({ name, version, identity_mode }) => ({ name, version, identity_mode })),
    ).toEqual(
      transformFixture.operations.map(({ name, version, identity_mode }) => ({
        name,
        version,
        identity_mode,
      })),
    )
    for (const operation of transformFixture.operations) {
      expect(operation.input_roles).toEqual(INPUT_ROLES_BY_OPERATION[operation.name])
      expect(BUILTIN_V2_TRANSFORM_REGISTRY.parseParams(operation.name, operation.params)).toEqual(
        operation.params,
      )
    }
    expect(
      descriptors.every((descriptor) => descriptor.params_schema.additionalProperties === false),
    ).toBe(true)
    expect(Object.isFrozen(descriptors[0]?.params_schema)).toBe(true)

    expect(() => BUILTIN_V2_TRANSFORM_REGISTRY.parseParams('sample', { count: 1 })).toThrow()
    expect(() => BUILTIN_V2_TRANSFORM_REGISTRY.require('missing')).toThrow(/not found/)
    expect(() =>
      BUILTIN_V2_TRANSFORM_REGISTRY.parseParams('sample', { count: 1, seed: 7, extra: true }),
    ).toThrow()
    const sampleParams = SampleV2ParamsSchema.parse({ count: 1, seed: 7 })
    expect(sampleV2.rngSeed(sampleParams)).toBe(7)
    expect(subsetV2.rngSeed(SubsetV2ParamsSchema.parse({ record_ids: [] }))).toBeNull()

    const data = baseDataset()
    const subsetEstimate = subsetV2.estimateWorkingSet(
      [data],
      SubsetV2ParamsSchema.parse({ record_ids: [] }),
    )
    expect(subsetEstimate).toEqual({
      outputUpperBoundBytes: data.canonicalBytes,
      frameEstimateBytes: data.canonicalBytes,
    })
    const mutatingEstimate = appendEvidenceV2.estimateWorkingSet(
      [data, evidencePatch()],
      AppendEvidenceV2ParamsSchema.parse({}),
      DEFAULT_V2_DATASET_LIMITS,
    )
    expect(mutatingEstimate.frameEstimateBytes).toBe(DEFAULT_V2_DATASET_LIMITS.max_canonical_bytes)
    expect(Number.isSafeInteger(mutatingEstimate.outputUpperBoundBytes)).toBe(true)
  })

  test('rejects a non-strict runtime params schema and duplicate registry definitions', () => {
    expect(() =>
      defineV2Transform({
        name: 'not-strict',
        version: '1',
        paramsSchema: z.object({ value: z.string() }),
        identityMode: 'preserve',
        rngSeed: () => null,
        estimateWorkingSet: () => ({ outputUpperBoundBytes: 0, frameEstimateBytes: 0 }),
        async run(inputs) {
          return inputs[0] as V2Dataset
        },
      }),
    ).toThrow(/strict object/)
    expect(() =>
      defineV2Transform({
        name: 'invalid-identity-mode',
        version: '1',
        paramsSchema: z.strictObject({}),
        identityMode: 'invalid' as unknown as 'preserve',
        rngSeed: () => null,
        estimateWorkingSet: () => ({ outputUpperBoundBytes: 0, frameEstimateBytes: 0 }),
        async run(inputs) {
          return inputs[0] as V2Dataset
        },
      }),
    ).toThrow(/identityMode/)
    expect(() => new V2TransformRegistry([subsetV2, subsetV2])).toThrow(/Duplicate/)
  })

  test('retains an immutable definition snapshot instead of caller-owned objects', () => {
    const mutable = {
      ...subsetV2,
      name: 'mutable-definition',
    }
    const originalRun = mutable.run
    const registry = new V2TransformRegistry([mutable])

    mutable.name = 'changed-after-registration'
    mutable.run = async (inputs) => inputs[0] as V2Dataset

    const retained = registry.require('mutable-definition')
    expect(Object.isFrozen(retained)).toBe(true)
    expect(retained.name).toBe('mutable-definition')
    expect(retained.run).toBe(originalRun)
    expect(registry.get('changed-after-registration')).toBeNull()
  })

  test('locks the RNG vector and exposes no clock, environment, arbitrary RNG, or network handle', () => {
    expect(transformFixture.fixture_version).toBe(1)
    expect(transformFixture.rng.algorithm).toBe('mulberry32-v1')
    const rng = createDeterministicRngV2(transformFixture.rng.seed)
    expect(
      Array.from({ length: transformFixture.rng.next_uint32.length }, () => rng.nextUint32()),
    ).toEqual(transformFixture.rng.next_uint32)
    for (const vector of transformFixture.rng.next_int) {
      expect(createDeterministicRngV2(vector.seed).nextInt(vector.max_exclusive)).toBe(vector.value)
    }

    const operationContext = context(7)
    expect(Object.keys(operationContext).sort()).toEqual([
      'identity_allocator',
      'limits',
      'run_id',
      'seeded_rng',
      'signal',
      'working_set_budget_bytes',
    ])
    expect(Object.isFrozen(operationContext)).toBe(true)
    expect(operationContext.run_id).toBe(RUN_ID)
    expect(() => createDeterministicRngV2(-1)).toThrow()
  })
})

describe('V2 built-in operations', () => {
  test('subset and seeded sample preserve revisions deterministically', async () => {
    const data = baseDataset()
    expect(data.version).toBe(transformFixture.sample.input_dataset_version)
    const subsetParams = SubsetV2ParamsSchema.parse({ record_ids: [RECORD_1, RECORD_3] })
    const subset = await subsetV2.run([data], subsetParams, context(null))
    expect(new Set(ids(subset))).toEqual(new Set([RECORD_1, RECORD_3]))
    expect(subset.get(RECORD_1)?.record_digest).toBe(data.get(RECORD_1)?.record_digest)

    const sampleParams = SampleV2ParamsSchema.parse(transformFixture.sample.params)
    const first = await sampleV2.run([data], sampleParams, context(sampleParams.seed))
    const second = await sampleV2.run([data], sampleParams, context(sampleParams.seed))
    expect(first.version).toBe(second.version)
    expect(ids(first)).toEqual(ids(second))
    expect(ids(first)).toEqual(transformFixture.sample.output_record_ids)
    expect(first.version).toBe(transformFixture.sample.output_dataset_version)
    const seedSeven = await sampleV2.run(
      [data],
      SampleV2ParamsSchema.parse({ count: 1, seed: 7 }),
      context(7),
    )
    const seedTen = await sampleV2.run(
      [data],
      SampleV2ParamsSchema.parse({ count: 1, seed: 10 }),
      context(10),
    )
    expect(ids(seedSeven)).not.toEqual(ids(seedTen))
    await expect(sampleV2.run([data], sampleParams, context(8))).rejects.toThrow(/normalized seed/)
    expect(() => SubsetV2ParamsSchema.parse({ record_ids: [RECORD_3, RECORD_1] })).toThrow(
      /strictly ASCII sorted/,
    )
    const largeSortedSubset = Array.from(
      { length: 1_001 },
      (_, index) => `rec_${index.toString(16).padStart(64, '0')}`,
    )
    expect(SubsetV2ParamsSchema.parse({ record_ids: largeSortedSubset }).record_ids).toEqual(
      largeSortedSubset,
    )
  })

  test('append-evidence accepts only append-only canonical patch revisions', async () => {
    const data = baseDataset()
    const params = AppendEvidenceV2ParamsSchema.parse({})
    const output = await appendEvidenceV2.run([data, evidencePatch()], params, context(null))
    const result = output.get(RECORD_1)
    expect(result?.record.id).toBe(RECORD_1)
    expect(result?.record.candidates[0]?.signals.map((signal) => signal.id)).toEqual([SIGNAL_1])
    expect(result?.record.preference_relations.map((relation) => relation.id)).toEqual([
      PREFERENCE_1,
    ])
    expect(result?.record.lineage?.steps.at(-1)).toEqual({
      name: 'append-evidence',
      version: '1',
      params: {},
    })
    expect(result?.record_digest).toBe(transformFixture.append_evidence.changed_record_digest)
    expect(output.version).toBe(transformFixture.append_evidence.output_dataset_version)
    expect(output.get(RECORD_2)?.record_digest).toBe(data.get(RECORD_2)?.record_digest)
    const repeated = await appendEvidenceV2.run([data, evidencePatch()], params, context(null))
    expect(repeated.version).toBe(output.version)

    await expect(
      appendEvidenceV2.run(
        [data, V2Dataset.fromRecords([record(RECORD_1, 'rank this', true)])],
        params,
        context(null),
      ),
    ).rejects.toThrow(/must append/)

    await expect(
      appendEvidenceV2.run(
        [evidencePatch(), V2Dataset.fromRecords([record(RECORD_1, 'rank this', true)])],
        params,
        context(null),
      ),
    ).rejects.toThrow(/prefix|append/)

    const twoSignals = cloneRecord(evidencePatch().get(RECORD_1)?.record)
    const originalSignal = twoSignals.candidates[0]?.signals[0]
    if (!originalSignal) throw new TypeError('evidence fixture signal is missing')
    twoSignals.candidates[0]?.signals.push({
      ...structuredClone(originalSignal),
      id: `sig_${'e'.repeat(64)}`,
      name: 'safety',
    })
    const reorderedSignals = structuredClone(twoSignals)
    reorderedSignals.candidates[0]?.signals.reverse()
    await expect(
      appendEvidenceV2.run(
        [V2Dataset.fromRecords([twoSignals]), V2Dataset.fromRecords([reorderedSignals])],
        params,
        context(null),
      ),
    ).rejects.toThrow(/prefix|append/)

    const illegal = cloneRecord(evidencePatch().get(RECORD_1)?.record)
    illegal.contents = [textContent('user', 'payload changed outside evidence')]
    await expect(
      appendEvidenceV2.run([data, V2Dataset.fromRecords([illegal])], params, context(null)),
    ).rejects.toThrow(/only append/)
  })

  test('selection-update accepts only selected/rank patch changes', async () => {
    const data = baseDataset()
    const params = SelectionUpdateV2ParamsSchema.parse({})
    const output = await selectionUpdateV2.run([data, selectionPatch()], params, context(null))
    expect(
      output.get(RECORD_1)?.record.candidates.map(({ selected, rank }) => ({ selected, rank })),
    ).toEqual([
      { selected: true, rank: 0 },
      { selected: false, rank: 1 },
    ])
    expect(output.get(RECORD_1)?.record.id).toBe(RECORD_1)
    expect(output.get(RECORD_1)?.record.candidates.map((candidate) => candidate.id)).toEqual([
      CANDIDATE_1,
      CANDIDATE_2,
    ])
    expect(output.get(RECORD_1)?.record_digest).not.toBe(data.get(RECORD_1)?.record_digest)
    expect(output.get(RECORD_1)?.record_digest).toBe(
      transformFixture.selection_update.changed_record_digest,
    )
    expect(output.version).toBe(transformFixture.selection_update.output_dataset_version)

    await expect(
      selectionUpdateV2.run(
        [data, V2Dataset.fromRecords([record(RECORD_1, 'rank this', true)])],
        params,
        context(null),
      ),
    ).rejects.toThrow(/must change/)

    const reordered = cloneRecord(selectionPatch().get(RECORD_1)?.record)
    reordered.candidates.reverse()
    await expect(
      selectionUpdateV2.run([data, V2Dataset.fromRecords([reordered])], params, context(null)),
    ).rejects.toThrow(/only change/)

    const illegal = cloneRecord(selectionPatch().get(RECORD_1)?.record)
    const candidate = illegal.candidates[0]
    if (!candidate) throw new TypeError('selection fixture candidate missing')
    candidate.finish_reason = 'changed-too'
    await expect(
      selectionUpdateV2.run([data, V2Dataset.fromRecords([illegal])], params, context(null)),
    ).rejects.toThrow(/only change/)
  })

  test('prompt-rewrite derives stable IDs with one exact parent and output_index zero', async () => {
    const data = baseDataset()
    const captured: IdentityCreationRequestV1[] = []
    const params = PromptRewriteV2ParamsSchema.parse({})
    const output = await promptRewriteV2.run(
      [data, promptPatch()],
      params,
      context(null, pureAllocator(captured)),
    )
    const derived = [...output.records()].filter((revision) => revision.record.id !== RECORD_1)
    expect(output.get(RECORD_2)).toBeNull()
    expect(output.get(RECORD_3)).toBeNull()
    expect(derived).toHaveLength(2)
    expect(derived.map((revision) => revision.record.id)).not.toContain(RECORD_2)
    expect(captured.map((request) => request.seed.output_index)).toEqual([
      transformFixture.prompt_rewrite.output_index,
      transformFixture.prompt_rewrite.output_index,
    ])
    for (const revision of derived) {
      expect(revision.record.lineage?.parent_refs).toHaveLength(
        transformFixture.prompt_rewrite.parent_count,
      )
      expect(revision.record.lineage?.steps.at(-1)?.params).toEqual({})
    }

    const repeated = await promptRewriteV2.run(
      [data, promptPatch()],
      params,
      context(null, pureAllocator()),
    )
    expect(repeated.version).toBe(output.version)

    const revisedBaseRecord = record(RECORD_2, 'old prompt')
    revisedBaseRecord.extra = { revision: 2 }
    const revisedRewriteRecord = record(RECORD_2, 'new prompt for revision two')
    revisedRewriteRecord.system_instruction = 'Use terse answers.'
    revisedRewriteRecord.extra = { revision: 2 }
    const revisedOutput = await promptRewriteV2.run(
      [V2Dataset.fromRecords([revisedBaseRecord]), V2Dataset.fromRecords([revisedRewriteRecord])],
      params,
      context(null, pureAllocator()),
    )
    const firstDerived = derived.find(
      (revision) => revision.record.lineage?.parent_refs[0]?.id === RECORD_2,
    )
    const revisedDerived = [...revisedOutput.records()][0]
    expect(revisedDerived?.record.id).toBe(firstDerived?.record.id)
    expect(revisedDerived?.record_digest).not.toBe(firstDerived?.record_digest)

    const candidateBearingRewrite = V2Dataset.fromRecords([record(RECORD_1, 'new', true)])
    await expect(
      promptRewriteV2.run([data, candidateBearingRewrite], params, context(null, pureAllocator())),
    ).rejects.toThrow(/prompt-only/)

    const noOp = record(RECORD_2, 'old prompt')
    await expect(
      promptRewriteV2.run(
        [V2Dataset.fromRecords([noOp]), V2Dataset.fromRecords([noOp])],
        params,
        context(null, pureAllocator()),
      ),
    ).rejects.toThrow(/must change/)

    const forbiddenMutations: Array<(rewrite: PostTrainingRecordV2) => void> = [
      (rewrite) => {
        rewrite.source = {
          name: 'unexpected-source',
          kind: 'test',
          url: 'https://example.com/source',
          license: null,
          original_id: null,
        }
      },
      (rewrite) => {
        rewrite.lang = 'zh'
      },
      (rewrite) => {
        rewrite.tags = ['unexpected-tag']
      },
      (rewrite) => {
        rewrite.extra = { unexpected: true }
      },
      (rewrite) => {
        rewrite.lineage = {
          parent_refs: [{ id: RECORD_1, record_digest: 'f'.repeat(64) }],
          recipe: 'unexpected',
          recipe_revision: '1',
          run_id: RUN_ID,
          steps: [],
        }
      },
    ]
    for (const mutate of forbiddenMutations) {
      const base = record(RECORD_2, 'old prompt')
      const rewrite = record(RECORD_2, 'new prompt')
      mutate(rewrite)
      await expect(
        promptRewriteV2.run(
          [V2Dataset.fromRecords([base]), V2Dataset.fromRecords([rewrite])],
          params,
          context(null, pureAllocator()),
        ),
      ).rejects.toThrow(/only change/)
    }
  })

  test('operations reject wrong input count and honor cancellation', async () => {
    const data = baseDataset()
    await expect(
      appendEvidenceV2.run([data], AppendEvidenceV2ParamsSchema.parse({}), context(null)),
    ).rejects.toThrow(/exactly two/)

    const controller = new AbortController()
    const operationContext = createV2TransformContext({
      run_id: RUN_ID,
      identity_allocator: pureAllocator(),
      seed: null,
      limits: DEFAULT_V2_DATASET_LIMITS,
      working_set_budget_bytes: Number.MAX_SAFE_INTEGER,
      signal: controller.signal,
    })
    controller.abort()
    await expect(
      subsetV2.run([data], SubsetV2ParamsSchema.parse({ record_ids: [] }), operationContext),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

function cloneRecord(input: CanonicalRecordViewV2 | undefined): PostTrainingRecordV2 {
  if (!input) throw new TypeError('fixture record is missing')
  return structuredClone(input) as unknown as PostTrainingRecordV2
}
