import { z } from 'zod'
import {
  CandidateIdSchema,
  FiniteNumberSchema,
  NonEmptyStringSchema,
  NonNegativeSafeIntegerSchema,
  NullableNonEmptyStringSchema,
} from './common.js'
import { ContentSchema } from './content.js'
import { JsonObjectSchema } from './json-value.js'
import { SignalSchema } from './signal.js'

export const GeneratorInfoSchema = z.strictObject({
  provider: NullableNonEmptyStringSchema,
  model: NonEmptyStringSchema,
  revision: NullableNonEmptyStringSchema,
  parameters: JsonObjectSchema,
})
export type GeneratorInfoV2 = z.infer<typeof GeneratorInfoSchema>

export const CandidateSchema = z.strictObject({
  id: CandidateIdSchema,
  contents: z.array(ContentSchema).min(1),
  finish_reason: z.string().nullable(),
  rank: NonNegativeSafeIntegerSchema.nullable(),
  selected: z.boolean().nullable(),
  signals: z.array(SignalSchema),
  generator: GeneratorInfoSchema.nullable(),
  token_count: NonNegativeSafeIntegerSchema.nullable(),
  avg_logprobs: FiniteNumberSchema.nullable(),
})
export type CandidateV2 = z.infer<typeof CandidateSchema>
