import { z } from 'zod'
import { NonEmptyStringSchema, NullableNonEmptyStringSchema } from './common.js'
import { JsonObjectSchema } from './json-value.js'

export const ToolSchema = z.strictObject({
  name: NonEmptyStringSchema,
  description: NullableNonEmptyStringSchema,
  input_schema: JsonObjectSchema,
})
export type ToolV2 = z.infer<typeof ToolSchema>
