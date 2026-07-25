import { z } from 'zod'
import { GeneratorInfoSchema } from './candidate.js'
import {
  Bcp47LanguageTagSchema,
  NonEmptyStringSchema,
  NonNegativeSafeIntegerSchema,
  Rfc3339UtcSchema,
} from './common.js'
import { ContentSchema } from './content.js'
import { JsonObjectSchema } from './json-value.js'
import { PreferenceOutcomeSchema, PreferenceStatusSchema } from './preference.js'
import { LineageSchema, SourceInfoSchema } from './provenance.js'
import { PostTrainingRecordV2Schema } from './record.js'
import { SignalKindSchema, SignalSourceSchema, SignalValueSchema } from './signal.js'
import { ToolSchema } from './tool.js'
import { VerificationSchema } from './verification.js'

export const CANONICAL_DRAFT_FORMAT_V1 = 'canonical-draft-jsonl-v1' as const
export const CANONICAL_DRAFT_SCHEMA_VERSION_V1 = '1.0.0' as const

const NullableIndexSchema = NonNegativeSafeIntegerSchema.nullable()

export const CanonicalDraftSignalV1Schema = z.strictObject({
  name: NonEmptyStringSchema,
  kind: SignalKindSchema,
  value: SignalValueSchema,
  source: SignalSourceSchema,
  rationale: z.string().nullable().default(null),
  created_at: Rfc3339UtcSchema.nullable().default(null),
  supersedes_index: NullableIndexSchema.default(null),
})
export type CanonicalDraftSignalV1 = z.infer<typeof CanonicalDraftSignalV1Schema>

export const CanonicalDraftCandidateV1Schema = z.strictObject({
  contents: z.array(ContentSchema).min(1),
  finish_reason: z.string().nullable().default(null),
  rank: NonNegativeSafeIntegerSchema.nullable().default(null),
  selected: z.boolean().nullable().default(null),
  signals: z.array(CanonicalDraftSignalV1Schema).default(() => []),
  generator: GeneratorInfoSchema.nullable().default(null),
  token_count: NonNegativeSafeIntegerSchema.nullable().default(null),
  avg_logprobs: z.number().finite().nullable().default(null),
})
export type CanonicalDraftCandidateV1 = z.infer<typeof CanonicalDraftCandidateV1Schema>

export const CanonicalDraftPreferenceV1Schema = z.strictObject({
  left_candidate_index: NonNegativeSafeIntegerSchema,
  right_candidate_index: NonNegativeSafeIntegerSchema,
  outcome: PreferenceOutcomeSchema,
  status: PreferenceStatusSchema,
  criterion: z.string().nullable().default(null),
  source: SignalSourceSchema,
  rationale: z.string().nullable().default(null),
  created_at: Rfc3339UtcSchema.nullable().default(null),
  supersedes_index: NullableIndexSchema.default(null),
})
export type CanonicalDraftPreferenceV1 = z.infer<typeof CanonicalDraftPreferenceV1Schema>

const CanonicalDraftRecordV1BaseSchema = z.strictObject({
  draft_schema_version: z.literal(CANONICAL_DRAFT_SCHEMA_VERSION_V1),
  schema_version: z.literal('2.0.0'),
  contents: z.array(ContentSchema),
  candidates: z.array(CanonicalDraftCandidateV1Schema).default(() => []),
  preference_relations: z.array(CanonicalDraftPreferenceV1Schema).default(() => []),
  tools: z.array(ToolSchema).default(() => []),
  verification: VerificationSchema.nullable().default(null),
  source: SourceInfoSchema.nullable().default(null),
  lang: Bcp47LanguageTagSchema.nullable().default(null),
  lineage: LineageSchema.nullable().default(null),
  tags: z.array(NonEmptyStringSchema).default(() => []),
  extra: JsonObjectSchema.default(() => ({})),
})

export const CanonicalDraftRecordV1Schema = CanonicalDraftRecordV1BaseSchema.superRefine(
  validateCanonicalDraftRecordV1,
).meta({ id: 'CanonicalDraftRecordV1' })
export type CanonicalDraftRecordV1 = z.infer<typeof CanonicalDraftRecordV1Schema>

declare const canonicalDraftPreviewRecordBrand: unique symbol
export type CanonicalDraftPreviewRecordV1 = {
  readonly [canonicalDraftPreviewRecordBrand]: true
}

export function canonicalPreviewRecordFromDraftV1(
  draftInput: CanonicalDraftRecordV1,
  dataRowIndex: number,
): CanonicalDraftPreviewRecordV1 {
  if (!Number.isSafeInteger(dataRowIndex) || dataRowIndex < 0) {
    throw new TypeError('Canonical draft data row index must be a non-negative safe integer')
  }
  const draft = CanonicalDraftRecordV1Schema.parse(draftInput)
  return PostTrainingRecordV2Schema.parse(
    materializeSyntheticRecord(draft, dataRowIndex),
  ) as unknown as CanonicalDraftPreviewRecordV1
}

function validateCanonicalDraftRecordV1(
  draft: z.infer<typeof CanonicalDraftRecordV1BaseSchema>,
  context: z.RefinementCtx,
): void {
  validateIndexes(draft, context)
  const canonical = PostTrainingRecordV2Schema.safeParse(materializeSyntheticRecord(draft, 0))
  if (!canonical.success) {
    for (const issue of canonical.error.issues) {
      context.addIssue({
        code: 'custom',
        path: canonicalPathToDraftPath(issue.path),
        message: sanitizeCanonicalDraftIssueMessage(issue.message),
      })
    }
  }
}

function validateIndexes(
  draft: z.infer<typeof CanonicalDraftRecordV1BaseSchema>,
  context: z.RefinementCtx,
): void {
  draft.candidates.forEach((candidate, candidateIndex) => {
    candidate.signals.forEach((signal, signalIndex) => {
      if (signal.supersedes_index !== null && signal.supersedes_index >= signalIndex) {
        context.addIssue({
          code: 'custom',
          path: ['candidates', candidateIndex, 'signals', signalIndex, 'supersedes_index'],
          message: 'Signal may only supersede an earlier signal index',
        })
      }
    })
  })

  draft.preference_relations.forEach((preference, preferenceIndex) => {
    for (const key of ['left_candidate_index', 'right_candidate_index'] as const) {
      if (preference[key] >= draft.candidates.length) {
        context.addIssue({
          code: 'custom',
          path: ['preference_relations', preferenceIndex, key],
          message: `${key} is out of range`,
        })
      }
    }
    if (preference.left_candidate_index === preference.right_candidate_index) {
      context.addIssue({
        code: 'custom',
        path: ['preference_relations', preferenceIndex],
        message: 'Preference candidate indexes must be different',
      })
    }
    if (preference.supersedes_index !== null && preference.supersedes_index >= preferenceIndex) {
      context.addIssue({
        code: 'custom',
        path: ['preference_relations', preferenceIndex, 'supersedes_index'],
        message: 'Preference may only supersede an earlier preference index',
      })
    }
  })
}

function materializeSyntheticRecord(
  draft: z.infer<typeof CanonicalDraftRecordV1BaseSchema>,
  dataRowIndex: number,
): unknown {
  let signalOrdinal = 0
  const candidates = draft.candidates.map((candidate, candidateIndex) => {
    const signalIds = candidate.signals.map(() => {
      const id = syntheticId('sig', dataRowIndex, signalOrdinal)
      signalOrdinal += 1
      return id
    })
    return {
      id: syntheticId('cand', dataRowIndex, candidateIndex),
      contents: candidate.contents,
      finish_reason: candidate.finish_reason,
      rank: candidate.rank,
      selected: candidate.selected,
      signals: candidate.signals.map((signal, signalIndex) => ({
        id: signalIds[signalIndex],
        name: signal.name,
        kind: signal.kind,
        value: signal.value,
        source: signal.source,
        rationale: signal.rationale,
        created_at: signal.created_at,
        supersedes:
          signal.supersedes_index === null
            ? null
            : (signalIds[signal.supersedes_index] ?? invalidSyntheticId('sig')),
      })),
      generator: candidate.generator,
      token_count: candidate.token_count,
      avg_logprobs: candidate.avg_logprobs,
    }
  })
  const preferenceIds = draft.preference_relations.map((_preference, preferenceIndex) =>
    syntheticId('pref', dataRowIndex, preferenceIndex),
  )
  return {
    schema_version: draft.schema_version,
    id: syntheticRecordId(draft, dataRowIndex),
    contents: draft.contents,
    candidates,
    preference_relations: draft.preference_relations.map((preference, preferenceIndex) => ({
      id: preferenceIds[preferenceIndex],
      left_candidate_id:
        candidates[preference.left_candidate_index]?.id ?? invalidSyntheticId('cand'),
      right_candidate_id:
        candidates[preference.right_candidate_index]?.id ?? invalidSyntheticId('cand'),
      outcome: preference.outcome,
      status: preference.status,
      criterion: preference.criterion,
      source: preference.source,
      rationale: preference.rationale,
      created_at: preference.created_at,
      supersedes:
        preference.supersedes_index === null
          ? null
          : (preferenceIds[preference.supersedes_index] ?? invalidSyntheticId('pref')),
    })),
    tools: draft.tools,
    verification: draft.verification,
    source: draft.source,
    lang: draft.lang,
    lineage: draft.lineage,
    tags: draft.tags,
    extra: draft.extra,
  }
}

function syntheticRecordId(
  draft: z.infer<typeof CanonicalDraftRecordV1BaseSchema>,
  dataRowIndex: number,
): string {
  const parentIds = new Set(draft.lineage?.parent_refs.map(({ id }) => id) ?? [])
  for (let localIndex = 0; localIndex <= parentIds.size; localIndex += 1) {
    const id = syntheticId('rec', dataRowIndex, localIndex)
    if (!parentIds.has(id)) return id
  }
  throw new TypeError('Unable to allocate an internal canonical draft preview record ID')
}

function syntheticId(
  prefix: 'cand' | 'pref' | 'rec' | 'sig',
  dataRowIndex: number,
  localIndex: number,
): string {
  const rowHex = BigInt(dataRowIndex).toString(16).padStart(32, '0')
  const localHex = BigInt(localIndex).toString(16).padStart(32, '0')
  return `${prefix}_${rowHex}${localHex}`
}

function invalidSyntheticId(prefix: 'cand' | 'pref' | 'sig'): string {
  return `${prefix}_${'f'.repeat(64)}`
}

function sanitizeCanonicalDraftIssueMessage(message: string): string {
  return message.replace(/\b(?:cand|pref|rec|sig)_[0-9a-f]{64}\b/g, '[internal preview ID]')
}

function canonicalPathToDraftPath(path: readonly PropertyKey[]): PropertyKey[] {
  const mapped = [...path]
  if (mapped[0] === 'id') return []
  if (mapped[0] === 'candidates' && typeof mapped[1] === 'number') {
    if (mapped[2] === 'id') return mapped.slice(0, 2)
    if (mapped[2] === 'signals' && typeof mapped[3] === 'number') {
      if (mapped[4] === 'id') return mapped.slice(0, 4)
      if (mapped[4] === 'supersedes') mapped[4] = 'supersedes_index'
    }
  }
  if (mapped[0] === 'preference_relations' && typeof mapped[1] === 'number') {
    if (mapped[2] === 'id') return mapped.slice(0, 2)
    if (mapped[2] === 'left_candidate_id') mapped[2] = 'left_candidate_index'
    if (mapped[2] === 'right_candidate_id') mapped[2] = 'right_candidate_index'
    if (mapped[2] === 'supersedes') mapped[2] = 'supersedes_index'
  }
  return mapped
}
