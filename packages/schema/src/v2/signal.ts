import { z } from 'zod'
import {
  addIssue,
  FiniteNumberSchema,
  NonEmptyStringSchema,
  NullableNonEmptyStringSchema,
  Rfc3339UtcSchema,
  SignalIdSchema,
} from './common.js'
import { JsonValueSchema } from './json-value.js'

export const SignalSourceTypeSchema = z.enum(['human', 'ai', 'verifier', 'heuristic', 'imported'])

export const SignalSourceSchema = z.strictObject({
  type: SignalSourceTypeSchema,
  id: NonEmptyStringSchema,
  version: NullableNonEmptyStringSchema,
})
export type SignalSourceV2 = z.infer<typeof SignalSourceSchema>

const NumberSignalValueSchema = z
  .strictObject({
    type: z.literal('number'),
    value: FiniteNumberSchema,
    scale_min: FiniteNumberSchema.nullable(),
    scale_max: FiniteNumberSchema.nullable(),
    higher_is_better: z.boolean().nullable(),
  })
  .superRefine((value, context) => {
    const bothNull = value.scale_min === null && value.scale_max === null
    const bothNumbers = value.scale_min !== null && value.scale_max !== null
    if (!bothNull && !bothNumbers) {
      addIssue(context, ['scale_min'], 'scale_min and scale_max must both be null or numbers')
      return
    }
    if (value.scale_min !== null && value.scale_max !== null) {
      const scaleMin = value.scale_min
      const scaleMax = value.scale_max
      if (scaleMin >= scaleMax) {
        addIssue(context, ['scale_max'], 'scale_max must be greater than scale_min')
      }
      if (value.value < scaleMin || value.value > scaleMax) {
        addIssue(context, ['value'], 'signal value must be within the declared scale')
      }
    }
  })

export const SignalValueSchema = z.discriminatedUnion('type', [
  NumberSignalValueSchema,
  z.strictObject({ type: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ type: z.literal('category'), value: NonEmptyStringSchema }),
  z.strictObject({ type: z.literal('json'), value: JsonValueSchema }),
])
export type SignalValueV2 = z.infer<typeof SignalValueSchema>

export const SignalKindSchema = z.enum([
  'rating',
  'reward',
  'verdict',
  'safety',
  'logprob',
  'other',
])

export const SignalSchema = z.strictObject({
  id: SignalIdSchema,
  name: NonEmptyStringSchema,
  kind: SignalKindSchema,
  value: SignalValueSchema,
  source: SignalSourceSchema,
  rationale: z.string().nullable(),
  created_at: Rfc3339UtcSchema.nullable(),
  supersedes: SignalIdSchema.nullable(),
})
export type SignalV2 = z.infer<typeof SignalSchema>
