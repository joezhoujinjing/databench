import { DEFAULT_V2_DATASET_LIMITS, V2Dataset, type V2DatasetLimits } from '@databench/engine'
import {
  InitialPostTrainingRecordV2Schema,
  type PostTrainingRecordV2,
  RecordIdV2Schema,
  type RecordRevisionV2,
  ValidationError,
} from '@databench/schema'
import { z } from 'zod'
import type { V2TransformContext, V2TransformResourceEstimate } from './contracts.js'
import { defineV2Transform } from './registry.js'

const UINT32_MAX = 0xffff_ffff
const TRANSFORM_VERSION = '1'
const EXAMPLE_RECORD_ID = `rec_${'1'.repeat(64)}`
type CanonicalRecordViewV2 = RecordRevisionV2['record']

export const SubsetV2ParamsSchema = z
  .strictObject({ record_ids: z.array(RecordIdV2Schema) })
  .superRefine((params, context) => {
    assertStrictlySorted(params.record_ids, context, ['record_ids'], 'record IDs')
  })
export type SubsetV2Params = z.infer<typeof SubsetV2ParamsSchema>

export const SampleV2ParamsSchema = z.strictObject({
  count: z.number().int().safe().min(0),
  seed: z.number().int().safe().min(0).max(UINT32_MAX),
})
export type SampleV2Params = z.infer<typeof SampleV2ParamsSchema>

/** Payload is supplied by ordered input[1], never by run params. */
export const AppendEvidenceV2ParamsSchema = z.strictObject({})
export type AppendEvidenceV2Params = z.infer<typeof AppendEvidenceV2ParamsSchema>

/** Payload is supplied by ordered input[1], never by run params. */
export const SelectionUpdateV2ParamsSchema = z.strictObject({})
export type SelectionUpdateV2Params = z.infer<typeof SelectionUpdateV2ParamsSchema>

/** Prompt fields are supplied by ordered input[1], never by run params. */
export const PromptRewriteV2ParamsSchema = z.strictObject({})
export type PromptRewriteV2Params = z.infer<typeof PromptRewriteV2ParamsSchema>

export const subsetV2 = defineV2Transform<SubsetV2Params>({
  name: 'subset',
  version: TRANSFORM_VERSION,
  inputRoles: ['base'],
  paramsSchema: SubsetV2ParamsSchema,
  paramsExample: { record_ids: [EXAMPLE_RECORD_ID] },
  identityMode: 'preserve',
  rngSeed: () => null,
  estimateWorkingSet: estimateSingleInputSubsetWorkingSet,
  async run(inputs, params, context) {
    const input = requireSingleInput(inputs, 'subset')
    context.signal.throwIfAborted()
    const records = params.record_ids.map((recordId) => {
      const revision = input.get(recordId)
      if (!revision) throw invalidTarget('subset', 'record', recordId)
      return revision.record
    })
    context.signal.throwIfAborted()
    return V2Dataset.fromRecords(records, context.limits)
  },
})

export const sampleV2 = defineV2Transform<SampleV2Params>({
  name: 'sample',
  version: TRANSFORM_VERSION,
  inputRoles: ['base'],
  paramsSchema: SampleV2ParamsSchema,
  paramsExample: { count: 2, seed: 7 },
  identityMode: 'preserve',
  rngSeed: (params) => params.seed,
  estimateWorkingSet: estimateSingleInputSubsetWorkingSet,
  async run(inputs, params, context) {
    const input = requireSingleInput(inputs, 'sample')
    context.signal.throwIfAborted()
    const rng = context.seeded_rng
    if (!rng || rng.seed !== params.seed) {
      throw new TypeError('sample requires a deterministic context RNG with the normalized seed')
    }

    const revisions = [...input.records()]
    const count = Math.min(params.count, revisions.length)
    for (let index = 0; index < count; index += 1) {
      context.signal.throwIfAborted()
      const selected = index + rng.nextInt(revisions.length - index)
      const current = revisions[index]
      const selectedRevision = revisions[selected]
      if (!current || !selectedRevision) {
        throw new TypeError('sample selection index escaped the input dataset')
      }
      revisions[index] = selectedRevision
      revisions[selected] = current
    }
    context.signal.throwIfAborted()
    return V2Dataset.fromRecords(
      revisions.slice(0, count).map((revision) => revision.record),
      context.limits,
    )
  },
})

export const appendEvidenceV2 = defineV2Transform<AppendEvidenceV2Params>({
  name: 'append-evidence',
  version: TRANSFORM_VERSION,
  inputRoles: ['base', 'patch'],
  paramsSchema: AppendEvidenceV2ParamsSchema,
  paramsExample: {},
  identityMode: 'preserve',
  rngSeed: () => null,
  estimateWorkingSet: estimateTwoInputMutationWorkingSet,
  async run(inputs, _params, context) {
    const [base, patch] = requireTwoInputs(inputs, 'append-evidence')
    const changed = new Map<string, PostTrainingRecordV2>()
    for (const patchRevision of patch.records()) {
      context.signal.throwIfAborted()
      const baseRevision = base.get(patchRevision.record.id)
      if (!baseRevision) {
        throw invalidTarget('append-evidence', 'base record', patchRevision.record.id)
      }
      assertEvidenceAppendOnly(baseRevision.record, patchRevision.record)
      changed.set(
        patchRevision.record.id,
        structuredClone(patchRevision.record) as unknown as PostTrainingRecordV2,
      )
    }
    if (changed.size === 0) {
      throw new ValidationError('append-evidence patch input must contain at least one record')
    }
    addPreserveLineage(changed, context, 'append-evidence')
    return outputDataset(base, changed, context)
  },
})

export const selectionUpdateV2 = defineV2Transform<SelectionUpdateV2Params>({
  name: 'selection-update',
  version: TRANSFORM_VERSION,
  inputRoles: ['base', 'patch'],
  paramsSchema: SelectionUpdateV2ParamsSchema,
  paramsExample: {},
  identityMode: 'preserve',
  rngSeed: () => null,
  estimateWorkingSet: estimateTwoInputMutationWorkingSet,
  async run(inputs, _params, context) {
    const [base, patch] = requireTwoInputs(inputs, 'selection-update')
    const changed = new Map<string, PostTrainingRecordV2>()
    for (const patchRevision of patch.records()) {
      context.signal.throwIfAborted()
      const baseRevision = base.get(patchRevision.record.id)
      if (!baseRevision) {
        throw invalidTarget('selection-update', 'base record', patchRevision.record.id)
      }
      assertSelectionOnlyChange(baseRevision.record, patchRevision.record)
      changed.set(
        patchRevision.record.id,
        structuredClone(patchRevision.record) as unknown as PostTrainingRecordV2,
      )
    }
    if (changed.size === 0) {
      throw new ValidationError('selection-update patch input must contain at least one record')
    }
    addPreserveLineage(changed, context, 'selection-update')
    return outputDataset(base, changed, context)
  },
})

export const promptRewriteV2 = defineV2Transform<PromptRewriteV2Params>({
  name: 'prompt-rewrite',
  version: TRANSFORM_VERSION,
  inputRoles: ['base', 'rewrite'],
  paramsSchema: PromptRewriteV2ParamsSchema,
  paramsExample: {},
  identityMode: 'derive',
  rngSeed: () => null,
  estimateWorkingSet: estimateTwoInputMutationWorkingSet,
  async run(inputs, params, context) {
    const [base, rewriteInput] = requireTwoInputs(inputs, 'prompt-rewrite')
    const changed = new Map<string, PostTrainingRecordV2>()

    for (const rewriteRevision of rewriteInput.records()) {
      context.signal.throwIfAborted()
      const parent = base.get(rewriteRevision.record.id)
      if (!parent) {
        throw invalidTarget('prompt-rewrite', 'base record', rewriteRevision.record.id)
      }
      assertPromptOnlyRewrite(parent.record, rewriteRevision.record)

      const draft = structuredClone(parent.record) as unknown as Record<string, unknown>
      delete draft.id
      draft.contents = structuredClone(rewriteRevision.record.contents)
      draft.tools = structuredClone(rewriteRevision.record.tools)
      draft.verification = structuredClone(rewriteRevision.record.verification)
      draft.lineage = {
        parent_refs: [{ id: parent.record.id, record_digest: parent.record_digest }],
        recipe: 'prompt-rewrite',
        recipe_revision: TRANSFORM_VERSION,
        run_id: context.run_id,
        steps: [...(parent.record.lineage?.steps ?? []), transformStep('prompt-rewrite')],
      }
      const initialRecord = InitialPostTrainingRecordV2Schema.parse(draft)
      const entityId = RecordIdV2Schema.parse(
        await context.identity_allocator.deriveRecord({
          creation_profile: 'derived-record-v1',
          seed: {
            op: 'prompt-rewrite',
            op_version: TRANSFORM_VERSION,
            params,
            parent_ids: [parent.record.id],
            output_index: 0,
          },
          initial_record: initialRecord,
        }),
      )
      context.signal.throwIfAborted()
      if (entityId === parent.record.id) {
        throw new TypeError('Derived prompt rewrite allocator returned its parent record ID')
      }
      changed.set(parent.record.id, { id: entityId, ...initialRecord })
    }
    if (changed.size === 0) {
      throw new ValidationError('prompt-rewrite input must contain at least one record')
    }
    return outputDataset(base, changed, context)
  },
})

function estimateSingleInputSubsetWorkingSet(
  inputs: readonly V2Dataset[],
): Readonly<V2TransformResourceEstimate> {
  const input = requireSingleInput(inputs, 'transform estimator')
  return Object.freeze({
    outputUpperBoundBytes: input.canonicalBytes,
    frameEstimateBytes: input.canonicalBytes,
  })
}

function estimateTwoInputMutationWorkingSet(
  inputs: readonly V2Dataset[],
  _params: object,
  limits: Readonly<V2DatasetLimits> = DEFAULT_V2_DATASET_LIMITS,
): Readonly<V2TransformResourceEstimate> {
  requireTwoInputs(inputs, 'transform estimator')
  validateEstimateLimit(limits.max_canonical_bytes)
  return Object.freeze({
    outputUpperBoundBytes: limits.max_canonical_bytes,
    frameEstimateBytes: limits.max_canonical_bytes,
  })
}

function assertEvidenceAppendOnly(base: CanonicalRecordViewV2, patch: CanonicalRecordViewV2): void {
  const baseProjection = evidenceInvariantProjection(base)
  const patchProjection = evidenceInvariantProjection(patch)
  if (!jsonEqual(baseProjection, patchProjection)) {
    throw new ValidationError(
      'append-evidence patch may only append candidate signals or preference relations',
      { record_id: base.id },
    )
  }

  let appended = patch.preference_relations.length - base.preference_relations.length
  assertArrayPrefix(base.preference_relations, patch.preference_relations, 'preference relations')
  for (let index = 0; index < base.candidates.length; index += 1) {
    const baseCandidate = base.candidates[index]
    const patchCandidate = patch.candidates[index]
    if (!baseCandidate || !patchCandidate) {
      throw new ValidationError('append-evidence candidate structure changed unexpectedly')
    }
    assertArrayPrefix(baseCandidate.signals, patchCandidate.signals, 'candidate signals')
    appended += patchCandidate.signals.length - baseCandidate.signals.length
  }
  if (appended <= 0) {
    throw new ValidationError('append-evidence patch must append at least one evidence event')
  }
}

function assertSelectionOnlyChange(
  base: CanonicalRecordViewV2,
  patch: CanonicalRecordViewV2,
): void {
  if (!jsonEqual(selectionInvariantProjection(base), selectionInvariantProjection(patch))) {
    throw new ValidationError('selection-update patch may only change candidate selected/rank', {
      record_id: base.id,
    })
  }
  const changed = base.candidates.some((candidate, index) => {
    const patched = patch.candidates[index]
    return patched && (candidate.selected !== patched.selected || candidate.rank !== patched.rank)
  })
  if (!changed) {
    throw new ValidationError('selection-update patch must change selected or rank')
  }
}

function assertPromptOnlyRewrite(
  base: CanonicalRecordViewV2,
  rewrite: CanonicalRecordViewV2,
): void {
  if (
    base.candidates.length > 0 ||
    base.preference_relations.length > 0 ||
    rewrite.candidates.length > 0 ||
    rewrite.preference_relations.length > 0
  ) {
    throw new ValidationError(
      'prompt-rewrite only accepts prompt-only records without candidates or preferences',
      { record_id: base.id },
    )
  }
  if (!jsonEqual(promptInvariantProjection(base), promptInvariantProjection(rewrite))) {
    throw new ValidationError('prompt-rewrite input may only change contents/tools/verification', {
      record_id: base.id,
    })
  }
  if (
    jsonEqual(
      [base.contents, base.tools, base.verification],
      [rewrite.contents, rewrite.tools, rewrite.verification],
    )
  ) {
    throw new ValidationError('prompt-rewrite input must change at least one prompt field')
  }
}

function evidenceInvariantProjection(record: CanonicalRecordViewV2): unknown {
  const projected = structuredClone(record) as unknown as PostTrainingRecordV2
  projected.preference_relations = []
  for (const candidate of projected.candidates) candidate.signals = []
  return projected
}

function selectionInvariantProjection(record: CanonicalRecordViewV2): unknown {
  const projected = structuredClone(record) as unknown as PostTrainingRecordV2
  for (const candidate of projected.candidates) {
    candidate.selected = null
    candidate.rank = null
  }
  return projected
}

function promptInvariantProjection(record: CanonicalRecordViewV2): unknown {
  const projected = structuredClone(record) as unknown as PostTrainingRecordV2
  projected.contents = []
  projected.tools = []
  projected.verification = null
  return projected
}

function assertArrayPrefix(
  base: readonly unknown[],
  patch: readonly unknown[],
  label: string,
): void {
  if (patch.length < base.length) {
    throw new ValidationError(`append-evidence cannot remove ${label}`)
  }
  for (let index = 0; index < base.length; index += 1) {
    if (!jsonEqual(base[index], patch[index])) {
      throw new ValidationError(`append-evidence cannot replace or reorder existing ${label}`)
    }
  }
}

function addPreserveLineage(
  changed: ReadonlyMap<string, PostTrainingRecordV2>,
  context: V2TransformContext,
  name: string,
): void {
  for (const record of changed.values()) {
    record.lineage = {
      parent_refs: structuredClone(record.lineage?.parent_refs ?? []),
      recipe: record.lineage?.recipe ?? null,
      recipe_revision: record.lineage?.recipe_revision ?? null,
      run_id: context.run_id,
      steps: [...(record.lineage?.steps ?? []), transformStep(name)],
    }
  }
}

function transformStep(name: string) {
  return { name, version: TRANSFORM_VERSION, params: {} }
}

function outputDataset(
  base: V2Dataset,
  changed: ReadonlyMap<string, PostTrainingRecordV2>,
  context: V2TransformContext,
): V2Dataset {
  context.signal.throwIfAborted()
  const records = [...base.records()].map(
    (revision) => changed.get(revision.record.id) ?? revision.record,
  )
  const output = V2Dataset.fromRecords(records, context.limits)
  context.signal.throwIfAborted()
  return output
}

function requireSingleInput(inputs: readonly V2Dataset[], operation: string): V2Dataset {
  if (inputs.length !== 1 || !(inputs[0] instanceof V2Dataset)) {
    throw new ValidationError(`${operation} requires exactly one V2 dataset input`, {
      expected: 1,
      actual: inputs.length,
    })
  }
  return inputs[0]
}

function requireTwoInputs(
  inputs: readonly V2Dataset[],
  operation: string,
): readonly [V2Dataset, V2Dataset] {
  if (
    inputs.length !== 2 ||
    !(inputs[0] instanceof V2Dataset) ||
    !(inputs[1] instanceof V2Dataset)
  ) {
    throw new ValidationError(`${operation} requires exactly two ordered V2 dataset inputs`, {
      expected: 2,
      actual: inputs.length,
    })
  }
  return [inputs[0], inputs[1]]
}

function invalidTarget(operation: string, kind: string, id: string): ValidationError {
  return new ValidationError(`${operation} references an unknown ${kind}`, {
    operation,
    target_kind: kind,
    target_id: id,
  })
}

function assertStrictlySorted(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous !== undefined && current !== undefined && previous >= current) {
      context.addIssue({
        code: 'custom',
        path: [...path, index],
        message: `${label} must be unique and strictly ASCII sorted`,
      })
    }
  }
}

function validateEstimateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Transform output upper bound must be a non-negative safe integer')
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => jsonEqual(value, right[index]))
  }
  const leftObject = left as Record<string, unknown>
  const rightObject = right as Record<string, unknown>
  const leftKeys = Object.keys(leftObject).sort()
  const rightKeys = Object.keys(rightObject).sort()
  if (!jsonEqual(leftKeys, rightKeys)) return false
  return leftKeys.every((key) => jsonEqual(leftObject[key], rightObject[key]))
}
