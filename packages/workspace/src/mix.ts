import { bankersRound, concatDatasetFrames, Dataset, type PolarsDataFrame } from '@databench/engine'
import {
  COLUMNS,
  jsonIntegerValue,
  jsonNumberValue,
  parseRecipe,
  type Recipe,
  type RecipeSource,
} from '@databench/schema'

export interface RecipeFrame {
  readonly source: RecipeSource
  readonly frame: PolarsDataFrame
}

export function sourceCount(height: number, source: RecipeSource): number {
  const maxSamples = source.max_samples === null ? null : jsonIntegerValue(source.max_samples)

  return maxSamples === null ? height : Math.min(height, maxSamples)
}

export function mix(recipeLike: Recipe | unknown, frames: readonly RecipeFrame[]): Dataset {
  const recipe = parseRecipe(recipeLike)
  const baseCounts = frames.map(({ source, frame }) => sourceCount(frame.height, source))
  const counts =
    recipe.target_size === null ? baseCounts : weightedCounts(recipe, frames, baseCounts)
  const parts: PolarsDataFrame[] = []
  const seed = jsonIntegerValue(recipe.seed)

  for (const [{ frame }, count] of zip(frames, counts)) {
    let sub = frame.select(...COLUMNS)
    if (count < frame.height) {
      sub = sub.sample(count, undefined, false, seed)
    }
    parts.push(sub)
  }

  const combined = concatDatasetFrames(parts)
  return Dataset.fromFrame(combined, recipe.name)
}

function weightedCounts(
  recipe: Recipe,
  frames: readonly RecipeFrame[],
  baseCounts: readonly number[],
): number[] {
  const targetSize = recipe.target_size === null ? null : jsonIntegerValue(recipe.target_size)

  if (targetSize === null) {
    return [...baseCounts]
  }

  const totalWeight = frames.reduce((total, { source }) => total + sourceWeight(source), 0)

  return frames.map(({ source }, index) => {
    const share = sourceWeight(source) / totalWeight
    return Math.min(baseCounts[index] ?? 0, bankersRound(share * targetSize))
  })
}

function sourceWeight(source: RecipeSource): number {
  return source.weight === null ? 1.0 : jsonNumberValue(source.weight) || 1.0
}

function zip<T, U>(left: readonly T[], right: readonly U[]): Array<[T, U]> {
  return left.map((item, index) => [item, right[index] as U])
}
