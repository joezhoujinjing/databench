import { describe, expect, test } from 'vitest'
import type { Capabilities } from './types.js'
import { checkCompatibility, compareSemver, majorOf } from './version.js'

describe('version compatibility', () => {
  test('parses supported API major formats', () => {
    expect(majorOf('v1')).toBe(1)
    expect(majorOf('1')).toBe(1)
    expect(majorOf('1.4.0')).toBe(1)
    expect(majorOf('vx')).toBeNull()
  })

  test('compares semver parts with missing segments as zero', () => {
    expect(compareSemver('0.1', '0.1.0')).toBe(0)
    expect(compareSemver('0.1.1', '0.1.0')).toBe(1)
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1)
  })

  test('checks API major and min client compatibility', () => {
    expect(checkCompatibility(capabilities({ api_version: 'v1', min_client: '0.1.0' }))).toEqual({
      status: 'ok',
    })
    expect(checkCompatibility(capabilities({ api_version: 'v2', min_client: '0.1.0' }))).toEqual({
      apiVersion: 'v2',
      status: 'api_unsupported',
    })
    expect(checkCompatibility(capabilities({ api_version: 'v1', min_client: '0.2.0' }))).toEqual({
      currentClient: '0.1.0',
      minClient: '0.2.0',
      status: 'client_too_old',
    })
  })
})

function capabilities(overrides: Partial<Capabilities>): Capabilities {
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
    ...overrides,
  }
}
