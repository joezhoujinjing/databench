import { z } from 'zod'
import { NonEmptyStringSchema } from './common.js'
import { JsonObjectSchema, JsonValueSchema } from './json-value.js'

const VerifierRouteSchema = NonEmptyStringSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

export const VerificationSchema = z.strictObject({
  verifier: VerifierRouteSchema,
  verifier_version: NonEmptyStringSchema,
  ground_truth: JsonValueSchema,
  constraint: JsonValueSchema,
  config: JsonObjectSchema,
})
export type VerificationV2 = z.infer<typeof VerificationSchema>
