import { describe, expect, test } from 'vitest'
import { FEATURES, isFeatureEnabled, isModuleEnabled } from './capabilities.js'
import type { Capabilities } from './types.js'

describe('feature flags', () => {
  test('uses strict feature checks for concrete feature use', () => {
    expect(isFeatureEnabled(undefined, FEATURES.transforms)).toBe(false)
    expect(isFeatureEnabled(capabilities(), FEATURES.transforms)).toBe(true)
    expect(isFeatureEnabled(capabilities(), FEATURES.vocabularies)).toBe(false)
  })

  test('keeps modules visible before handshake and hides explicit false features', () => {
    expect(isModuleEnabled(undefined, FEATURES.transforms)).toBe(true)
    expect(isModuleEnabled(capabilities(), FEATURES.transforms)).toBe(true)
    expect(isModuleEnabled(capabilities(), FEATURES.vocabularies)).toBe(false)
  })
})

function capabilities(): Capabilities {
  return {
    api_version: 'v1',
    features: {
      annotation: false,
      export: true,
      jsonl_ingest: true,
      lineage: true,
      recipes: true,
      synthesis: false,
      transforms: true,
      vocabularies: false,
    },
    min_client: '0.1.0',
  }
}
