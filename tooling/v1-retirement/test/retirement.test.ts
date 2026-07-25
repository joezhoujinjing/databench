import { describe, expect, test } from 'vitest'
import { auditRegisteredDatasetLayouts, V2AuditGateError } from '../src/retirement.js'
import type { V2AuditResult } from '../src/types.js'

const digestA = 'a'.repeat(64)
const digestB = 'b'.repeat(64)
const digestC = 'c'.repeat(64)

function successfulAudit(datasetVersion: string): V2AuditResult {
  return {
    dataset_version: datasetVersion,
    layout_version: 'record-json-v1',
    artifact_digest: digestC,
    artifact_size_bytes: 1,
    checks: {
      manifest: 'ok',
      artifact_digest: 'ok',
      parquet_schema: 'ok',
      record_digests: 'ok',
      dataset_version: 'ok',
    },
  }
}

describe('v2 retirement safety audit', () => {
  test('audits every registered dataset and aggregates failures', async () => {
    const visited: string[] = []
    const error = await auditRegisteredDatasetLayouts(
      [
        { datasetVersion: digestB, layoutVersion: 'record-json-v1' },
        { datasetVersion: digestA, layoutVersion: 'record-json-v1' },
        { datasetVersion: digestC, layoutVersion: 'record-json-v1' },
      ],
      async (datasetVersion) => {
        visited.push(datasetVersion)
        if (datasetVersion === digestC) return successfulAudit(datasetVersion)
        const failure = new Error('Parquet record_json is not a strict v2 record')
        failure.name = 'RecordJsonV1IntegrityError'
        Reflect.set(failure, 'reason', 'record_json_invalid')
        Reflect.set(failure, 'detail', { row_index: 0, column: 'record_json', nested: {} })
        throw failure
      },
    ).catch((caught: unknown) => caught)

    expect(visited).toEqual([digestA, digestB, digestC])
    expect(error).toBeInstanceOf(V2AuditGateError)
    expect((error as V2AuditGateError).failures).toEqual([
      {
        dataset_version: digestA,
        error_name: 'RecordJsonV1IntegrityError',
        message: 'Parquet record_json is not a strict v2 record',
        reason: 'record_json_invalid',
        detail: { row_index: 0, column: 'record_json' },
      },
      {
        dataset_version: digestB,
        error_name: 'RecordJsonV1IntegrityError',
        message: 'Parquet record_json is not a strict v2 record',
        reason: 'record_json_invalid',
        detail: { row_index: 0, column: 'record_json' },
      },
    ])
  })

  test('refuses an unrecognized v2 layout before auditing anything', async () => {
    let called = false
    await expect(
      auditRegisteredDatasetLayouts(
        [{ datasetVersion: digestA, layoutVersion: 'future-layout' }],
        async (datasetVersion) => {
          called = true
          return successfulAudit(datasetVersion)
        },
      ),
    ).rejects.toThrow(/unsupported v2 layout/)
    expect(called).toBe(false)
  })
})
