import { z } from 'zod'
import { JsonIntegerSchema, JsonNumberSchema, jsonIntegerValue, jsonNumberValue } from './sample.js'

export const TargetFormatSchema = z.enum(['messages-jsonl', 'trl'])
export type TargetFormat = z.infer<typeof TargetFormatSchema>

export const RecipeSourceSchema = z.object({
  dataset: z.string(),
  weight: JsonNumberSchema.nullable().default(null),
  max_samples: JsonIntegerSchema.nullable().default(null),
})
export type RecipeSource = z.infer<typeof RecipeSourceSchema>

export const RecipeSchema = z.object({
  name: z.string(),
  sources: z.array(RecipeSourceSchema),
  target_format: TargetFormatSchema.default('messages-jsonl'),
  target_size: JsonIntegerSchema.nullable().default(null),
  seed: JsonIntegerSchema.default(0),
})
export type Recipe = z.infer<typeof RecipeSchema>

export function parseRecipe(value: unknown): Recipe {
  return RecipeSchema.parse(value)
}

export function toRecipeJson(value: Recipe | unknown): Record<string, unknown> {
  const recipe = parseRecipe(value)

  return {
    name: recipe.name,
    sources: recipe.sources.map((source) => ({
      dataset: source.dataset,
      weight: source.weight === null ? null : jsonNumberValue(source.weight),
      max_samples: source.max_samples === null ? null : jsonIntegerValue(source.max_samples),
    })),
    target_format: recipe.target_format,
    target_size: recipe.target_size === null ? null : jsonIntegerValue(recipe.target_size),
    seed: jsonIntegerValue(recipe.seed),
  }
}
