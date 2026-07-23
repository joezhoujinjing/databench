import { z } from 'zod'
import { CandidateIdSchema, PreferenceIdSchema, Rfc3339UtcSchema } from './common.js'
import { SignalSourceSchema } from './signal.js'

export const PreferenceOutcomeSchema = z.enum(['left', 'right', 'tie', 'abstain'])
export const PreferenceStatusSchema = z.enum(['observation', 'adjudicated'])

export const PreferenceRelationSchema = z.strictObject({
  id: PreferenceIdSchema,
  left_candidate_id: CandidateIdSchema,
  right_candidate_id: CandidateIdSchema,
  outcome: PreferenceOutcomeSchema,
  status: PreferenceStatusSchema,
  criterion: z.string().nullable(),
  source: SignalSourceSchema,
  rationale: z.string().nullable(),
  created_at: Rfc3339UtcSchema.nullable(),
  supersedes: PreferenceIdSchema.nullable(),
})
export type PreferenceRelationV2 = z.infer<typeof PreferenceRelationSchema>
