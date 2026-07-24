import { describe, expect, test } from 'vitest'
import { shouldShowPostTrainingV2Navigation } from '../api/capability.js'
import type { PostTrainingV2Capability } from '../api/types.js'
import { isV2RoutePath } from './match.js'

describe('V2 route isolation', () => {
  test('uses the V2 gate only for the V2 subtree', () => {
    expect(isV2RoutePath('/v2')).toBe(true)
    expect(isV2RoutePath('/v2/datasets')).toBe(true)
    expect(isV2RoutePath('/datasets')).toBe(false)
    expect(isV2RoutePath('/ingest')).toBe(false)
    expect(isV2RoutePath('/v2evil')).toBe(false)
  })

  test('shows navigation only for a ready capability', () => {
    expect(shouldShowPostTrainingV2Navigation({ status: 'loading' })).toBe(false)
    expect(shouldShowPostTrainingV2Navigation({ status: 'disabled' })).toBe(false)
    expect(shouldShowPostTrainingV2Navigation({ status: 'incompatible', missing: ['api'] })).toBe(
      false,
    )
    expect(
      shouldShowPostTrainingV2Navigation({
        capability: {} as PostTrainingV2Capability,
        status: 'ready',
      }),
    ).toBe(true)
  })
})
