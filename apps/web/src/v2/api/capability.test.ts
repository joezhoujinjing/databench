import { describe, expect, test } from 'vitest'
import { ApiError } from '@/api/errors.js'
import { classifyPostTrainingV2, missingRequiredProfiles } from './capability.js'
import type { CapabilitiesV2Envelope, PostTrainingV2Capability } from './types.js'

const readyCapability = {
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
} satisfies PostTrainingV2Capability

const capabilities = {
  api_version: 'v2',
  min_client: '0.1.0',
  post_training_v2: readyCapability,
} satisfies CapabilitiesV2Envelope

function state(overrides: Partial<Parameters<typeof classifyPostTrainingV2>[0]> = {}) {
  return classifyPostTrainingV2({
    capabilities,
    compatibility: { status: 'ok' },
    error: null,
    isError: false,
    isLoading: false,
    ...overrides,
  })
}

describe('Post-training V2 capability state', () => {
  test('distinguishes loading, absent, disabled, auth, network and client errors', () => {
    expect(state({ isLoading: true }).status).toBe('loading')
    expect(
      state({
        capabilities: {
          api_version: capabilities.api_version,
          min_client: capabilities.min_client,
        } as CapabilitiesV2Envelope,
      }).status,
    ).toBe('absent')
    expect(
      state({
        capabilities: {
          ...capabilities,
          post_training_v2: { ...readyCapability, enabled: false },
        },
      }).status,
    ).toBe('disabled')
    expect(
      state({
        error: new ApiError({ code: 'unauthorized', message: 'auth', status: 401 }),
        isError: true,
      }).status,
    ).toBe('unauthorized')
    expect(
      state({
        error: new ApiError({ code: 'forbidden', message: 'no', status: 403 }),
        isError: true,
      }).status,
    ).toBe('forbidden')
    expect(
      state({
        error: new ApiError({ code: 'unreachable', message: 'offline', status: 0 }),
        isError: true,
      }).status,
    ).toBe('network_error')
    expect(state({ error: new Error('down'), isError: true }).status).toBe('server_error')
    expect(state({ compatibility: { apiVersion: 'v9', status: 'api_unsupported' } }).status).toBe(
      'client_incompatible',
    )
  })

  test('requires every locked protocol profile but accepts future extras and no converters', () => {
    expect(state().status).toBe('ready')
    expect(missingRequiredProfiles(readyCapability)).toEqual([])

    for (const key of [
      'api_versions',
      'record_schema_versions',
      'identity_profiles',
      'layout_versions',
      'export_fidelity_profiles',
    ] as const) {
      const incompatible = { ...readyCapability, [key]: [] } as PostTrainingV2Capability
      expect(missingRequiredProfiles(incompatible)).toHaveLength(1)
    }
  })
})
