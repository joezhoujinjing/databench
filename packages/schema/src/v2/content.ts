import { z } from 'zod'
import { FiniteNumberSchema } from './common.js'
import { PartSchema } from './part.js'

export const ContentRoleSchema = z.enum(['system', 'user', 'ai'])
export type ContentRoleV2 = z.infer<typeof ContentRoleSchema>

export const ContentSchema = z
  .strictObject({
    role: ContentRoleSchema,
    parts: z.array(PartSchema).min(1),
    loss_weight: FiniteNumberSchema.nonnegative().nullable(),
  })
  .superRefine((content, context) => {
    if (content.role !== 'system') {
      return
    }
    if (content.loss_weight !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['loss_weight'],
        message: 'System content loss_weight must be 0',
      })
    }
    if (content.parts.length !== 1 || content.parts[0]?.type !== 'text') {
      context.addIssue({
        code: 'custom',
        path: ['parts'],
        message: 'System content must contain exactly one text part',
      })
    }
  })
export type ContentV2 = z.infer<typeof ContentSchema>
