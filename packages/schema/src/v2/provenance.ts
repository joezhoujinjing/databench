import { z } from 'zod'
import {
  addIssue,
  DigestHexSchema,
  NonEmptyStringSchema,
  NullableNonEmptyStringSchema,
  RecordIdSchema,
  StableUriSchema,
} from './common.js'
import { JsonObjectSchema } from './json-value.js'

export const SourceInfoSchema = z.strictObject({
  name: NonEmptyStringSchema,
  kind: NonEmptyStringSchema,
  url: StableUriSchema.nullable(),
  license: NullableNonEmptyStringSchema,
  original_id: NullableNonEmptyStringSchema,
})
export type SourceInfoV2 = z.infer<typeof SourceInfoSchema>

export const TransformationStepSchema = z.strictObject({
  name: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  params: JsonObjectSchema,
})
export type TransformationStepV2 = z.infer<typeof TransformationStepSchema>

export const ParentRevisionRefSchema = z.strictObject({
  id: RecordIdSchema,
  record_digest: DigestHexSchema,
})
export type ParentRevisionRefV2 = z.infer<typeof ParentRevisionRefSchema>

export const LineageSchema = z
  .strictObject({
    parent_refs: z.array(ParentRevisionRefSchema),
    recipe: NullableNonEmptyStringSchema,
    recipe_revision: NullableNonEmptyStringSchema,
    run_id: NullableNonEmptyStringSchema,
    steps: z.array(TransformationStepSchema),
  })
  .superRefine((lineage, context) => {
    if ((lineage.recipe === null) !== (lineage.recipe_revision === null)) {
      addIssue(
        context,
        ['recipe_revision'],
        'recipe and recipe_revision must both be null or strings',
      )
    }
    if (
      lineage.parent_refs.length === 0 &&
      lineage.recipe === null &&
      lineage.recipe_revision === null &&
      lineage.run_id === null &&
      lineage.steps.length === 0
    ) {
      addIssue(context, [], 'lineage must not be an empty placeholder')
    }
  })
export type LineageV2 = z.infer<typeof LineageSchema>
