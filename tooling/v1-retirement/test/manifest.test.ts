import { describe, expect, test } from 'vitest'
import {
  createDatabaseRetirementPlan,
  createObjectRetirementPlan,
  createRetirementManifest,
  createV2Baseline,
  parseRetirementManifest,
} from '../src/manifest.js'

const digestA = 'a'.repeat(64)
const digestB = 'b'.repeat(64)

describe('retirement manifest', () => {
  test('sorts exact targets and produces stable digests', () => {
    const databaseTables = [
      {
        name: 'runs' as const,
        exists: true,
        row_count: '2',
        rows_digest: digestA,
        rows_md5: 'a'.repeat(32),
        total_bytes: '8192',
        foreign_keys: [],
      },
      {
        name: 'datasets' as const,
        exists: true,
        row_count: '1',
        rows_digest: digestB,
        rows_md5: 'b'.repeat(32),
        total_bytes: '8192',
        foreign_keys: [],
      },
      {
        name: 'refs' as const,
        exists: true,
        row_count: '0',
        rows_digest: digestA,
        rows_md5: 'a'.repeat(32),
        total_bytes: '8192',
        foreign_keys: [],
      },
      {
        name: 'vocabularies' as const,
        exists: true,
        row_count: '0',
        rows_digest: digestA,
        rows_md5: 'a'.repeat(32),
        total_bytes: '8192',
        foreign_keys: [],
      },
      {
        name: 'vocab_refs' as const,
        exists: true,
        row_count: '0',
        rows_digest: digestA,
        rows_md5: 'a'.repeat(32),
        total_bytes: '8192',
        foreign_keys: [],
      },
    ]
    const database = createDatabaseRetirementPlan('public', databaseTables)
    const targets = [
      {
        key: `objects/bb/${digestB}.parquet`,
        size: 2,
        etag: null,
        kind: 'dataset_parquet' as const,
      },
      {
        key: `objects/aa/${digestA}.manifest.json`,
        size: 1,
        etag: 'etag',
        kind: 'dataset_manifest' as const,
      },
    ]
    const first = createObjectRetirementPlan({
      provider: 's3',
      bucket: 'bucket',
      targets,
      unrecognizedLegacyPrefixObjects: [],
      protectedV2ObjectCount: 3,
    })
    const second = createObjectRetirementPlan({
      provider: 's3',
      bucket: 'bucket',
      targets: [...targets].reverse(),
      unrecognizedLegacyPrefixObjects: [],
      protectedV2ObjectCount: 3,
    })
    expect(first.digest).toBe(second.digest)
    expect(first.targets.map((target) => target.key)).toEqual(
      [...first.targets.map((target) => target.key)].sort(),
    )

    const baseline = createV2Baseline({ catalog: [], objects: [], audits: [] })
    expect(() =>
      createRetirementManifest({ database, objects: first, v2Baseline: baseline }),
    ).toThrow()
  })

  test('detects a tampered digest before a manifest can authorize deletion', () => {
    const emptyTables = ['datasets', 'runs', 'refs', 'vocabularies', 'vocab_refs'].map((name) => ({
      name: name as 'datasets',
      exists: false,
      row_count: '0',
      rows_digest: digestA,
      rows_md5: 'a'.repeat(32),
      total_bytes: '0',
      foreign_keys: [],
    }))
    const database = createDatabaseRetirementPlan('public', emptyTables)
    const objects = createObjectRetirementPlan({
      provider: 's3',
      bucket: 'bucket',
      targets: [],
      unrecognizedLegacyPrefixObjects: [],
      protectedV2ObjectCount: 0,
    })
    const catalog = [
      'identity_namespaces_v2',
      'identity_claims_v2',
      'dataset_snapshots_v2',
      'dataset_layouts_v2',
      'runs_v2',
      'run_inputs_v2',
      'record_revision_locations_v2',
      'record_parent_edges_v2',
      'refs_v2',
    ].map((table) => ({
      table: table as 'identity_namespaces_v2',
      row_count: '0',
      rows_digest: digestA,
    }))
    const baseline = createV2Baseline({ catalog, objects: [], audits: [] })
    const manifest = createRetirementManifest({ database, objects, v2Baseline: baseline })
    const tampered = structuredClone(manifest)
    tampered.objects.digest = digestB
    expect(() => parseRetirementManifest(tampered)).toThrow(/object digest/)
  })
})
