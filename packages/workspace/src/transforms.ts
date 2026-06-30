import type { Transform } from '@databench/engine'
import { BUILTIN_TRANSFORMS } from '@databench/ops'

export type TransformRegistry = Readonly<Record<string, Transform>>

export const TRANSFORMS: TransformRegistry = BUILTIN_TRANSFORMS

export function listTransforms(registry: TransformRegistry = TRANSFORMS): Transform[] {
  return Object.values(registry)
}

export function getTransform(
  name: string,
  registry: TransformRegistry = TRANSFORMS,
): Transform | null {
  return registry[name] ?? null
}
