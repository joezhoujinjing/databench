import { describe, expect, test } from 'vitest'
import type { Capabilities } from './types.js'
import { checkCompatibility, compareSemver, majorOf } from './version.js'

describe('version compatibility', () => {
  test('parses supported API major formats', () => {
    expect(majorOf('v1')).toBe(1)
    expect(majorOf('2')).toBe(2)
    expect(majorOf('2.4.0')).toBe(2)
    expect(majorOf('vx')).toBeNull()
  })

  test('compares semver parts with missing segments as zero', () => {
    expect(compareSemver('0.1', '0.1.0')).toBe(0)
    expect(compareSemver('0.1.1', '0.1.0')).toBe(1)
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1)
  })

  test('checks API major and min client compatibility', () => {
    expect(checkCompatibility(capabilities({ api_version: 'v2', min_client: '0.1.0' }))).toEqual({
      status: 'ok',
    })
    expect(
      checkCompatibility({ ...capabilities({}), api_version: 'v1' } as unknown as Capabilities),
    ).toEqual({
      apiVersion: 'v1',
      status: 'api_unsupported',
    })
    expect(checkCompatibility(capabilities({ api_version: 'v2', min_client: '0.2.0' }))).toEqual({
      currentClient: '0.1.0',
      minClient: '0.2.0',
      status: 'client_too_old',
    })
  })
})

function capabilities(overrides: Partial<Capabilities>): Capabilities {
  return {
    api_version: 'v2',
    min_client: '0.1.0',
    post_training_v2: {
      api_versions: ['2'],
      converters: [],
      enabled: true,
      export_fidelity_profiles: ['databench-export-fidelity-1'],
      identity_profiles: ['databench-v2-jcs-1'],
      layout_versions: ['record-json-v1'],
      limits: {
        max_canonical_bytes: 1,
        max_concurrent_transforms: 1,
        max_json_schema_bytes: 1,
        max_json_schema_nodes: 1,
        max_lineage_depth: 1,
        max_lineage_nodes: 1,
        max_nesting_depth: 1,
        max_record_bytes: 1,
        max_request_bytes: 1,
        max_snapshot_records: 1,
        max_transform_inputs: 1,
        max_transform_working_set_bytes: 1,
      },
      record_schema_versions: ['2.0.0'],
    },
    ...overrides,
  }
}
