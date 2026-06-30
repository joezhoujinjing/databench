import type { TransformParams } from '@databench/engine'
import { hashObj } from '@databench/hashing'

export interface TransformCacheKeyInput {
  readonly op: string
  readonly opVersion: string
  readonly inputs: readonly string[]
  readonly params: TransformParams
}

export function transformCacheKey(input: TransformCacheKeyInput): string {
  return hashObj({
    op: input.op,
    op_version: input.opVersion,
    inputs: [...input.inputs],
    params: input.params,
  })
}

export function recipeCacheKey(recipeName: string, fingerprint: string): string {
  return hashObj({
    op: `recipe:${recipeName}`,
    fingerprint,
  })
}
