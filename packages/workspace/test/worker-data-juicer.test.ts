import { describe, expect, test } from 'vitest'
import {
  compileBasicCleanWorkerParametersV1,
  DATA_JUICER_BATCH_CAPABILITY_V1,
  DATA_JUICER_BATCH_PARAMETER_SCHEMA_V1,
} from '../src/internal/worker/data-juicer.js'

describe('basic-clean@1 Worker compiler', () => {
  const job = {
    op: 'basic-clean',
    opVersion: '1',
    params: {},
    capabilityName: DATA_JUICER_BATCH_CAPABILITY_V1,
    capabilityVersion: '1',
  }

  test('emits the exact allowlisted Data-Juicer payload', () => {
    const payload = compileBasicCleanWorkerParametersV1(job)
    expect(payload.schemaName).toBe(DATA_JUICER_BATCH_PARAMETER_SCHEMA_V1)
    expect(payload.schemaVersion).toBe('1')
    expect(JSON.parse(new TextDecoder().decode(payload.utf8Json))).toEqual({
      np: 1,
      process: [
        { whitespace_normalization_mapper: {} },
        { text_length_filter: { min_len: 40 } },
        { document_deduplicator: { lowercase: false } },
      ],
    })
  })

  test.each([
    { ...job, op: 'custom' },
    { ...job, opVersion: '2' },
    { ...job, params: { minLength: 1 } },
    { ...job, capabilityName: 'fixture.copy' },
    { ...job, capabilityVersion: '2' },
  ])('rejects a job outside the fixed operation contract', (value) => {
    expect(() => compileBasicCleanWorkerParametersV1(value)).toThrow('fixed basic-clean@1')
  })
})
