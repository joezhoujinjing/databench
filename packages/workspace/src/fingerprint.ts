import { hashObj } from '@databench/hashing'
import { type Recipe, toRecipeJson } from '@databench/schema'

export function recipeFingerprint(
  recipe: Recipe | unknown,
  resolvedVersions: Record<string, string>,
): string {
  return hashObj({
    recipe: toRecipeJson(recipe),
    resolved: resolvedVersions,
  })
}
