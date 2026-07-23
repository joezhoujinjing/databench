import { z } from 'zod'
import { FiniteNumberSchema } from './common.js'
import { PartSchema } from './part.js'

export const ContentRoleSchema = z.enum(['user', 'ai'])
export type ContentRoleV2 = z.infer<typeof ContentRoleSchema>

export const ContentSchema = z.strictObject({
  role: ContentRoleSchema,
  parts: z.array(PartSchema).min(1),
  loss_weight: FiniteNumberSchema.nonnegative().nullable(),
})
export type ContentV2 = z.infer<typeof ContentSchema>
