import { z } from 'zod'
import {
  Bcp47LanguageTagSchema,
  DigestHexSchema,
  NonNegativeSafeIntegerSchema,
  RecordIdSchema,
} from './common.js'
import type { PostTrainingRecordV2 } from './record.js'
import type { RecordRevisionV2 } from './revision.js'

export const V2_RECORD_PREVIEW_MAX_CODE_POINTS = 240

export const EligibilityReasonCodeV2Schema = z
  .enum([
    'selected_candidate_missing',
    'adjudicated_directional_preference_missing',
    'verification_missing',
  ])
  .meta({ id: 'EligibilityReasonCodeV2' })
export type EligibilityReasonCodeV2 = z.infer<typeof EligibilityReasonCodeV2Schema>

export const TaskEligibilityV2Schema = z
  .strictObject({
    eligible: z.boolean(),
    output_count: NonNegativeSafeIntegerSchema,
    reason_codes: z.array(EligibilityReasonCodeV2Schema),
  })
  .superRefine((eligibility, context) => {
    if (eligibility.eligible !== eligibility.output_count > 0) {
      context.addIssue({
        code: 'custom',
        path: ['eligible'],
        message: 'eligible must be true exactly when output_count is positive',
      })
    }
    if (eligibility.eligible !== (eligibility.reason_codes.length === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['reason_codes'],
        message: 'eligible tasks must have no reason codes and ineligible tasks must explain why',
      })
    }
  })
  .meta({ id: 'TaskEligibilityV2' })
export type TaskEligibilityV2 = z.infer<typeof TaskEligibilityV2Schema>

export const RecordEligibilityV2Schema = z
  .strictObject({
    sft: TaskEligibilityV2Schema,
    dpo: TaskEligibilityV2Schema,
    rlvr_grpo: TaskEligibilityV2Schema,
  })
  .superRefine((eligibility, context) => {
    validateTaskReasonCode(
      eligibility.sft,
      'selected_candidate_missing',
      ['sft', 'reason_codes'],
      context,
    )
    validateTaskReasonCode(
      eligibility.dpo,
      'adjudicated_directional_preference_missing',
      ['dpo', 'reason_codes'],
      context,
    )
    validateTaskReasonCode(
      eligibility.rlvr_grpo,
      'verification_missing',
      ['rlvr_grpo', 'reason_codes'],
      context,
    )
  })
  .meta({ id: 'RecordEligibilityV2' })
export type RecordEligibilityV2 = z.infer<typeof RecordEligibilityV2Schema>

const RecordPreviewV2Schema = z.string().superRefine((preview, context) => {
  if (exceedsPreviewCodePointLimit(preview)) {
    context.addIssue({
      code: 'custom',
      message: `preview must contain at most ${V2_RECORD_PREVIEW_MAX_CODE_POINTS} Unicode code points`,
    })
  }
})

export const RecordSummaryV2Schema = z
  .strictObject({
    record_id: RecordIdSchema,
    record_digest: DigestHexSchema,
    lang: Bcp47LanguageTagSchema.nullable(),
    candidate_count: NonNegativeSafeIntegerSchema,
    signal_count: NonNegativeSafeIntegerSchema,
    selected_count: NonNegativeSafeIntegerSchema,
    eligibility: RecordEligibilityV2Schema,
    preview: RecordPreviewV2Schema.nullable(),
  })
  .superRefine((summary, context) => {
    if (summary.selected_count > summary.candidate_count) {
      context.addIssue({
        code: 'custom',
        path: ['selected_count'],
        message: 'selected_count cannot exceed candidate_count',
      })
    }
    if (summary.selected_count !== summary.eligibility.sft.output_count) {
      context.addIssue({
        code: 'custom',
        path: ['selected_count'],
        message: 'selected_count must equal the SFT output count',
      })
    }
  })
  .meta({ id: 'RecordSummaryV2' })
export type RecordSummaryV2 = z.infer<typeof RecordSummaryV2Schema>

export type RecordProjectionSourceV2 = PostTrainingRecordV2 | RecordRevisionV2['record']

export function deriveRecordEligibilityV2(record: RecordProjectionSourceV2): RecordEligibilityV2 {
  const supersededPreferenceIds = new Set(
    record.preference_relations.flatMap((relation) =>
      relation.supersedes === null ? [] : [relation.supersedes],
    ),
  )
  const sftOutputCount = record.candidates.reduce(
    (count, candidate) => count + Number(candidate.selected === true),
    0,
  )
  let dpoOutputCount = 0
  for (const relation of record.preference_relations) {
    if (
      !supersededPreferenceIds.has(relation.id) &&
      relation.status === 'adjudicated' &&
      (relation.outcome === 'left' || relation.outcome === 'right')
    ) {
      dpoOutputCount += 1
    }
  }
  const rlvrGrpoOutputCount = Number(record.verification !== null)

  return RecordEligibilityV2Schema.parse({
    sft: taskEligibility(sftOutputCount, 'selected_candidate_missing'),
    dpo: taskEligibility(dpoOutputCount, 'adjudicated_directional_preference_missing'),
    rlvr_grpo: taskEligibility(rlvrGrpoOutputCount, 'verification_missing'),
  })
}

export function deriveRecordPreviewV2(record: RecordProjectionSourceV2): string | null {
  for (const content of record.contents) {
    for (const part of content.parts) {
      if (part.type === 'text' && part.text.length > 0) {
        let preview = ''
        let codePoints = 0
        for (const codePoint of part.text) {
          if (codePoints >= V2_RECORD_PREVIEW_MAX_CODE_POINTS) {
            break
          }
          preview += codePoint
          codePoints += 1
        }
        return preview
      }
    }
  }
  return null
}

function exceedsPreviewCodePointLimit(value: string): boolean {
  let codePoints = 0
  for (const _codePoint of value) {
    codePoints += 1
    if (codePoints > V2_RECORD_PREVIEW_MAX_CODE_POINTS) {
      return true
    }
  }
  return false
}

export function createRecordSummaryV2(revision: RecordRevisionV2): RecordSummaryV2 {
  const record = revision.record
  const eligibility = deriveRecordEligibilityV2(record)
  return RecordSummaryV2Schema.parse({
    record_id: record.id,
    record_digest: revision.record_digest,
    lang: record.lang,
    candidate_count: record.candidates.length,
    signal_count: record.candidates.reduce(
      (count, candidate) => count + candidate.signals.length,
      0,
    ),
    selected_count: eligibility.sft.output_count,
    eligibility,
    preview: deriveRecordPreviewV2(record),
  })
}

function taskEligibility(
  outputCount: number,
  missingReason: EligibilityReasonCodeV2,
): TaskEligibilityV2 {
  return outputCount > 0
    ? { eligible: true, output_count: outputCount, reason_codes: [] }
    : { eligible: false, output_count: 0, reason_codes: [missingReason] }
}

function validateTaskReasonCode(
  eligibility: TaskEligibilityV2,
  missingReason: EligibilityReasonCodeV2,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const expected = eligibility.eligible ? [] : [missingReason]
  if (
    eligibility.reason_codes.length !== expected.length ||
    eligibility.reason_codes.some((reason, index) => reason !== expected[index])
  ) {
    context.addIssue({
      code: 'custom',
      path,
      message: eligibility.eligible
        ? 'eligible task must not have a missing-input reason'
        : `ineligible task must use reason code ${missingReason}`,
    })
  }
}
