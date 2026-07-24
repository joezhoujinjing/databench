import { canonicalJsonV2, compareJcsUtf16 } from '@databench/hashing'
import { z } from 'zod'
import { CandidateSchema } from './candidate.js'
import {
  addIssue,
  Bcp47LanguageTagSchema,
  findForbiddenJsonKey,
  hasDuplicate,
  NonEmptyStringSchema,
  normalizeMimeType,
  normalizeRfc3339Utc,
  RecordIdSchema,
} from './common.js'
import { ContentSchema, type ContentV2 } from './content.js'
import { JsonObjectSchema } from './json-value.js'
import type { FunctionCallPartSchema } from './part.js'
import { PreferenceRelationSchema, type PreferenceRelationV2 } from './preference.js'
import { LineageSchema, SourceInfoSchema } from './provenance.js'
import { ToolSchema, type ToolV2 } from './tool.js'
import {
  type CompiledToolInputSchemaV2,
  compileToolInputSchemaV2,
  ToolSchemaValidationErrorV2,
} from './tool-validation.js'
import { VerificationSchema } from './verification.js'

type FunctionCallPartV2 = z.infer<typeof FunctionCallPartSchema>
const PostTrainingRecordV2PayloadShape = {
  schema_version: z.literal('2.0.0'),
  contents: z.array(ContentSchema),
  candidates: z.array(CandidateSchema),
  preference_relations: z.array(PreferenceRelationSchema),
  tools: z.array(ToolSchema),
  verification: VerificationSchema.nullable(),
  source: SourceInfoSchema.nullable(),
  lang: Bcp47LanguageTagSchema.nullable(),
  lineage: LineageSchema.nullable(),
  tags: z.array(NonEmptyStringSchema),
  extra: JsonObjectSchema,
} as const

const PostTrainingRecordV2PayloadSchema = z.strictObject(PostTrainingRecordV2PayloadShape)
type PostTrainingRecordV2Payload = z.infer<typeof PostTrainingRecordV2PayloadSchema>

const PostTrainingRecordV2BaseSchema = PostTrainingRecordV2PayloadSchema.extend({
  id: RecordIdSchema,
})

export const PostTrainingRecordV2Schema = PostTrainingRecordV2BaseSchema.superRefine(
  validateRecord,
).meta({ id: 'PostTrainingRecordV2' })
export type PostTrainingRecordV2 = z.infer<typeof PostTrainingRecordV2Schema>

export const InitialPostTrainingRecordV2Schema = PostTrainingRecordV2PayloadSchema.superRefine(
  validateRecord,
).meta({ id: 'InitialPostTrainingRecordV2' })
export type InitialPostTrainingRecordV2 = z.infer<typeof InitialPostTrainingRecordV2Schema>

export function parseCanonicalRecordV2(input: unknown): PostTrainingRecordV2 {
  canonicalJsonV2(input)
  return PostTrainingRecordV2Schema.parse(input)
}

export function normalizeCanonicalRecordV2(input: unknown): PostTrainingRecordV2 {
  canonicalJsonV2(input)
  let cloned: unknown
  try {
    cloned = structuredClone(input)
  } catch {
    throw new TypeError('Canonical record draft must be structured-cloneable JSON data')
  }

  normalizeKnownFields(cloned)
  return parseCanonicalRecordV2(cloned)
}

function validateRecord(
  record: PostTrainingRecordV2Payload & { readonly id?: string },
  context: z.RefinementCtx,
) {
  validateSystemContents(record.contents, context)
  validateAlternatingContents(record.contents, context, ['contents'])
  if (record.candidates.length > 0) {
    const lastShared = record.contents.at(-1)
    if (lastShared?.role !== 'user') {
      addIssue(context, ['contents'], 'Shared contents must end with user when candidates exist')
    }
  }

  const candidateIds = record.candidates.map((candidate) => candidate.id)
  if (hasDuplicate(candidateIds)) {
    addIssue(context, ['candidates'], 'Candidate IDs must be unique within a record')
  }

  const signalIds = record.candidates.flatMap((candidate) =>
    candidate.signals.map((signal) => signal.id),
  )
  if (hasDuplicate(signalIds)) {
    addIssue(context, ['candidates'], 'Signal IDs must be unique within a record')
  }

  const relationIds = record.preference_relations.map((relation) => relation.id)
  if (hasDuplicate(relationIds)) {
    addIssue(context, ['preference_relations'], 'Preference relation IDs must be unique')
  }

  const toolNames = record.tools.map((tool) => tool.name)
  if (hasDuplicate(toolNames)) {
    addIssue(context, ['tools'], 'Tool names must be unique within a record')
  }

  const toolValidators = compileTools(record.tools, context)
  const sharedState = validateTrajectory(record.contents, context, ['contents'], toolValidators)

  record.candidates.forEach((candidate, candidateIndex) => {
    validateTrajectory(
      candidate.contents,
      context,
      ['candidates', candidateIndex, 'contents'],
      toolValidators,
      sharedState,
    )
  })

  validatePreferences(record.preference_relations, new Set(candidateIds), context)
  validateLineage(record, context)
  validateCanonicalTags(record.tags, context)
  validateSensitivePayloads(record, context)
}

function validateSystemContents(contents: readonly ContentV2[], context: z.RefinementCtx): void {
  const systemIndices = contents.flatMap((content, index) =>
    content.role === 'system' ? [index] : [],
  )
  if (systemIndices.length > 1) {
    addIssue(context, ['contents'], 'A record may contain at most one system content')
  }
  for (const index of systemIndices) {
    if (index !== 0) {
      addIssue(context, ['contents', index, 'role'], 'System content must be contents[0]')
    }
  }
}

function validateAlternatingContents(
  contents: readonly ContentV2[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  const start = contents[0]?.role === 'system' ? 1 : 0
  for (let index = start + 1; index < contents.length; index += 1) {
    if (contents[index]?.role === contents[index - 1]?.role) {
      addIssue(context, [...path, index, 'role'], 'Content roles must alternate')
    }
  }
}

interface TrajectoryState {
  readonly calls: Map<string, FunctionCallPartV2['function_call']>
  readonly responded: Set<string>
}

function validateTrajectory(
  contents: readonly ContentV2[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  toolValidators: ReadonlyMap<string, CompiledToolInputSchemaV2>,
  initial?: TrajectoryState,
): TrajectoryState {
  const calls = new Map(initial?.calls ?? [])
  const responded = new Set(initial?.responded ?? [])

  contents.forEach((content, contentIndex) => {
    content.parts.forEach((part, partIndex) => {
      const partPath = [...path, contentIndex, 'parts', partIndex]
      if (part.type === 'function_call') {
        if (content.role !== 'ai') {
          addIssue(context, [...partPath, 'function_call'], 'Function calls must be in ai content')
        }
        if (calls.has(part.function_call.id)) {
          addIssue(context, [...partPath, 'function_call', 'id'], 'Function call ID must be unique')
        } else {
          calls.set(part.function_call.id, part.function_call)
        }
        const validator = toolValidators.get(part.function_call.name)
        if (!validator) {
          addIssue(
            context,
            [...partPath, 'function_call', 'name'],
            'Function call must reference a declared tool',
          )
        } else {
          const errors = validator.validate(part.function_call.args)
          if (errors) {
            addIssue(
              context,
              [...partPath, 'function_call', 'args'],
              `Function args do not match input_schema: ${summarizeAjvErrors(errors)}`,
            )
          }
        }
      }
      if (part.type === 'function_response') {
        if (content.role !== 'user') {
          addIssue(
            context,
            [...partPath, 'function_response'],
            'Function responses must be in user content',
          )
        }
        const callId = part.function_response.call_id
        if (!calls.has(callId)) {
          addIssue(
            context,
            [...partPath, 'function_response', 'call_id'],
            'Response must reference an earlier call',
          )
        } else if (responded.has(callId)) {
          addIssue(
            context,
            [...partPath, 'function_response', 'call_id'],
            'Each call may have at most one response',
          )
        } else {
          responded.add(callId)
        }
      }
    })
  })

  return { calls, responded }
}

function compileTools(
  tools: readonly ToolV2[],
  context: z.RefinementCtx,
): Map<string, CompiledToolInputSchemaV2> {
  const validators = new Map<string, CompiledToolInputSchemaV2>()
  tools.forEach((tool, index) => {
    try {
      validators.set(tool.name, compileToolInputSchemaV2(tool.input_schema))
    } catch (error) {
      const message =
        error instanceof ToolSchemaValidationErrorV2
          ? error.message
          : 'Tool schema validation failed'
      addIssue(context, ['tools', index, 'input_schema'], message)
    }
  })
  return validators
}

function validatePreferences(
  relations: readonly PreferenceRelationV2[],
  candidateIds: ReadonlySet<string>,
  context: z.RefinementCtx,
): void {
  const byId = new Map<string, PreferenceRelationV2>()
  const superseded = new Set<string>()
  const successorCount = new Map<string, number>()

  relations.forEach((relation, index) => {
    if (!candidateIds.has(relation.left_candidate_id)) {
      addIssue(
        context,
        ['preference_relations', index, 'left_candidate_id'],
        'Unknown left candidate',
      )
    }
    if (!candidateIds.has(relation.right_candidate_id)) {
      addIssue(
        context,
        ['preference_relations', index, 'right_candidate_id'],
        'Unknown right candidate',
      )
    }

    if (relation.supersedes !== null) {
      const target = byId.get(relation.supersedes)
      if (!target) {
        addIssue(
          context,
          ['preference_relations', index, 'supersedes'],
          'Preference may only supersede an earlier relation',
        )
      } else if (
        preferencePairKey(target) !== preferencePairKey(relation) ||
        target.criterion !== relation.criterion ||
        target.status !== relation.status
      ) {
        addIssue(
          context,
          ['preference_relations', index, 'supersedes'],
          'Superseded preference must have the same pair, criterion, and status',
        )
      }
      superseded.add(relation.supersedes)
      successorCount.set(relation.supersedes, (successorCount.get(relation.supersedes) ?? 0) + 1)
    }
    byId.set(relation.id, relation)
  })

  for (const [id, count] of successorCount) {
    if (count > 1) {
      addIssue(
        context,
        ['preference_relations'],
        `Preference ${id} has more than one direct successor`,
      )
    }
  }

  const activeAdjudicated = new Set<string>()
  relations.forEach((relation, index) => {
    if (relation.status !== 'adjudicated' || superseded.has(relation.id)) {
      return
    }
    const key = `${preferencePairKey(relation)}\0${canonicalJsonV2(relation.criterion)}`
    if (activeAdjudicated.has(key)) {
      addIssue(
        context,
        ['preference_relations', index],
        'Only one active adjudicated relation is allowed per pair and criterion',
      )
    }
    activeAdjudicated.add(key)
  })
}

function validateLineage(
  record: PostTrainingRecordV2Payload & { readonly id?: string },
  context: z.RefinementCtx,
): void {
  if (!record.lineage) {
    return
  }
  const parentIds = record.lineage.parent_refs.map((parent) => parent.id)
  if (hasDuplicate(parentIds)) {
    addIssue(context, ['lineage', 'parent_refs'], 'Lineage parent logical IDs must be unique')
  }
  record.lineage.parent_refs.forEach((parent, index) => {
    if (record.id !== undefined && parent.id === record.id) {
      addIssue(
        context,
        ['lineage', 'parent_refs', index, 'id'],
        'A record cannot be its own parent',
      )
    }
  })
}

function validateCanonicalTags(tags: readonly string[], context: z.RefinementCtx): void {
  const normalized = [...new Set(tags)].sort(compareJcsUtf16)
  if (canonicalJsonV2(tags) !== canonicalJsonV2(normalized)) {
    addIssue(context, ['tags'], 'Canonical tags must be unique and sorted by the JCS comparator')
  }
}

function validateSensitivePayloads(
  record: PostTrainingRecordV2Payload,
  context: z.RefinementCtx,
): void {
  const check = (value: unknown, path: PropertyKey[], extra = new Set<string>()) => {
    const forbiddenPath = findForbiddenJsonKey(value, extra)
    if (forbiddenPath) {
      addIssue(
        context,
        [...path, ...forbiddenPath],
        'Canonical records must not contain credentials or execution endpoints',
      )
    }
  }

  check(record.extra, ['extra'])
  check(record.verification?.config, ['verification', 'config'])
  check(record.verification?.ground_truth, ['verification', 'ground_truth'])
  check(record.verification?.constraint, ['verification', 'constraint'])
  record.lineage?.steps.forEach((step, index) => {
    check(step.params, ['lineage', 'steps', index, 'params'])
  })
  record.candidates.forEach((candidate, candidateIndex) => {
    check(
      candidate.generator?.parameters,
      ['candidates', candidateIndex, 'generator', 'parameters'],
      new Set(['endpoint', 'headers', 'request_headers']),
    )
    candidate.signals.forEach((signal, signalIndex) => {
      if (signal.value.type === 'json') {
        check(signal.value.value, [
          'candidates',
          candidateIndex,
          'signals',
          signalIndex,
          'value',
          'value',
        ])
      }
    })
    checkContents(candidate.contents, ['candidates', candidateIndex, 'contents'])
  })

  checkContents(record.contents, ['contents'])

  function checkContents(contents: readonly ContentV2[], path: PropertyKey[]) {
    contents.forEach((content, contentIndex) => {
      content.parts.forEach((part, partIndex) => {
        check(part.part_metadata, [...path, contentIndex, 'parts', partIndex, 'part_metadata'])
        if (part.type === 'function_call') {
          check(part.function_call.args, [
            ...path,
            contentIndex,
            'parts',
            partIndex,
            'function_call',
            'args',
          ])
        }
        if (part.type === 'function_response') {
          check(part.function_response.response, [
            ...path,
            contentIndex,
            'parts',
            partIndex,
            'function_response',
            'response',
          ])
        }
      })
    })
  }
}

function preferencePairKey(relation: PreferenceRelationV2): string {
  return [relation.left_candidate_id, relation.right_candidate_id].sort().join('\0')
}

function summarizeAjvErrors(errors: readonly { instancePath: string; message?: string }[]): string {
  return errors
    .slice(0, 3)
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
}

function normalizeKnownFields(value: unknown): void {
  if (!isMutableObject(value)) {
    return
  }
  if (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string')) {
    value.tags = [...new Set(value.tags)].sort(compareJcsUtf16)
  }
  normalizeContents(value.contents)
  if (Array.isArray(value.candidates)) {
    for (const candidate of value.candidates) {
      if (!isMutableObject(candidate)) {
        continue
      }
      normalizeContents(candidate.contents)
      normalizeSignalTimes(candidate.signals)
    }
  }
  if (Array.isArray(value.preference_relations)) {
    for (const relation of value.preference_relations) {
      if (isMutableObject(relation) && typeof relation.created_at === 'string') {
        relation.created_at = normalizeRfc3339Utc(relation.created_at)
      }
    }
  }
  if (Array.isArray(value.tools)) {
    for (const tool of value.tools) {
      if (isMutableObject(tool) && tool.description === '') {
        tool.description = null
      }
    }
  }
}

function normalizeContents(value: unknown): void {
  if (!Array.isArray(value)) {
    return
  }
  for (const content of value) {
    if (!isMutableObject(content) || !Array.isArray(content.parts)) {
      continue
    }
    for (const part of content.parts) {
      if (
        isMutableObject(part) &&
        part.type === 'file_data' &&
        isMutableObject(part.file_data) &&
        typeof part.file_data.media_type === 'string'
      ) {
        part.file_data.media_type = normalizeMimeType(part.file_data.media_type)
      }
    }
  }
}

function normalizeSignalTimes(value: unknown): void {
  if (!Array.isArray(value)) {
    return
  }
  for (const signal of value) {
    if (isMutableObject(signal) && typeof signal.created_at === 'string') {
      signal.created_at = normalizeRfc3339Utc(signal.created_at)
    }
  }
}

function isMutableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
