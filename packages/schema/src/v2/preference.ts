import { z } from 'zod'
import { addIssue, CandidateIdSchema, PreferenceIdSchema, Rfc3339UtcSchema } from './common.js'
import { SignalSourceSchema } from './signal.js'

export const PreferenceOutcomeSchema = z.enum(['left', 'right', 'tie', 'abstain'])
export const PreferenceStatusSchema = z.enum(['observation', 'adjudicated'])

const PreferenceRelationPayloadShape = {
  left_candidate_id: CandidateIdSchema,
  right_candidate_id: CandidateIdSchema,
  outcome: PreferenceOutcomeSchema,
  status: PreferenceStatusSchema,
  criterion: z.string().nullable(),
  source: SignalSourceSchema,
  rationale: z.string().nullable(),
  created_at: Rfc3339UtcSchema.nullable(),
  supersedes: PreferenceIdSchema.nullable(),
} as const

export const PreferenceRelationSchema = z
  .strictObject({
    id: PreferenceIdSchema,
    ...PreferenceRelationPayloadShape,
  })
  .superRefine(validatePreferenceRelation)
export type PreferenceRelationV2 = z.infer<typeof PreferenceRelationSchema>

export const InitialPreferenceRelationV2Schema = z
  .strictObject(PreferenceRelationPayloadShape)
  .superRefine(validatePreferenceRelation)
export type InitialPreferenceRelationV2 = z.infer<typeof InitialPreferenceRelationV2Schema>

function validatePreferenceRelation(
  relation: z.infer<z.ZodObject<typeof PreferenceRelationPayloadShape>>,
  context: z.RefinementCtx,
): void {
  if (relation.left_candidate_id === relation.right_candidate_id) {
    addIssue(context, [], 'Preference candidates must be different')
  }
  if (relation.source.type === 'human' && relation.source.id.includes('@')) {
    addIssue(context, ['source', 'id'], 'Human source IDs must be anonymous internal identifiers')
  }
}
