import { describe, expect, test } from 'vitest'
import {
  createDatasetManifestV2,
  DatasetLineageV2Schema,
  DeterminismConflictErrorV2,
  LineagePageRequestV2Schema,
  RunMetadataV2Schema,
  RunTransformRequestV2Schema,
  RunTransformResultV2Schema,
  TransformDescriptorV2Schema,
  TransformJobV2Schema,
  V2_LINEAGE_DEFAULT_MAX_DEPTH,
  V2_LINEAGE_DEFAULT_MAX_NODES,
  V2_LINEAGE_MAX_NODES,
  V2_TRANSFORM_MAX_INPUTS,
} from '../src/index.js'

const INPUT = 'a'.repeat(64)
const OUTPUT = 'b'.repeat(64)
const CACHE_KEY = 'c'.repeat(64)
const manifest = createDatasetManifestV2({
  identity_profile: 'databench-v2-jcs-1',
  record_schema_version: '2.0.0',
  dataset_version: OUTPUT,
  num_records: 1,
  layout_version: 'record-json-v1',
  artifact_digest: 'd'.repeat(64),
  artifact_size_bytes: 123,
})
const run = {
  run_id: `run_${CACHE_KEY}`,
  cache_key: CACHE_KEY,
  op: 'subset',
  op_version: '1',
  input_dataset_versions: [INPUT],
  normalized_params: { record_ids: [`rec_${'1'.repeat(64)}`] },
  output_dataset_version: OUTPUT,
  created_at: '2026-07-23T12:00:00.000Z',
}

describe('V10 transform contracts', () => {
  test('accepts strict descriptors and rejects invalid identity metadata', () => {
    expect(
      TransformDescriptorV2Schema.parse({
        name: 'prompt-rewrite',
        version: '1',
        identity_mode: 'derive',
        input_roles: ['base', 'rewrite'],
        params_schema: { type: 'object', additionalProperties: false },
        params_example: {},
      }),
    ).toBeDefined()
    expect(
      TransformDescriptorV2Schema.safeParse({
        name: 'Prompt Rewrite',
        version: '1',
        identity_mode: 'dynamic',
        input_roles: [],
        params_schema: {},
        params_example: {},
      }).success,
    ).toBe(false)
  })

  test('keeps ordered inputs, params and optional ref CAS strict', () => {
    const request = {
      inputs: [INPUT, OUTPUT],
      params: { count: 1, seed: 7 },
      ref: 'main',
      expected_ref_version: INPUT,
      message: 'sample',
    }
    expect(RunTransformRequestV2Schema.parse(request)).toEqual(request)
    expect(RunTransformRequestV2Schema.safeParse({ ...request, ref: null }).success).toBe(false)
    expect(RunTransformRequestV2Schema.safeParse({ ...request, ref: OUTPUT }).success).toBe(false)
    expect(
      RunTransformRequestV2Schema.safeParse({
        ...request,
        inputs: Array.from({ length: V2_TRANSFORM_MAX_INPUTS + 1 }, () => INPUT),
      }).success,
    ).toBe(false)
    expect(RunTransformRequestV2Schema.safeParse({ ...request, unknown: true }).success).toBe(false)
  })

  test('binds run ID to cache key and all output identities', () => {
    expect(RunMetadataV2Schema.parse(run)).toEqual(run)
    expect(RunMetadataV2Schema.safeParse({ ...run, run_id: `run_${'e'.repeat(64)}` }).success).toBe(
      false,
    )
    expect(
      RunTransformResultV2Schema.parse({
        run,
        manifest,
        ref_update: { status: 'not_requested' },
        cache_hit: false,
      }),
    ).toBeDefined()
    expect(
      RunTransformResultV2Schema.safeParse({
        run: { ...run, output_dataset_version: INPUT },
        manifest,
        ref_update: { status: 'not_requested' },
        cache_hit: false,
      }).success,
    ).toBe(false)
  })

  test('exposes a typed determinism conflict detail', () => {
    const error = new DeterminismConflictErrorV2({
      cache_key: CACHE_KEY,
      existing_output_version: INPUT,
      attempted_output_version: OUTPUT,
      attempted_dataset_committed: true,
    })
    expect(error).toMatchObject({
      name: 'DeterminismConflictErrorV2',
      code: 'determinism_conflict',
      detail: { cache_key: CACHE_KEY, attempted_dataset_committed: true },
    })
  })
})

describe('P2 transform job contracts', () => {
  const queued = {
    id: `job_${CACHE_KEY}`,
    cache_key: CACHE_KEY,
    operation: { name: 'basic-clean', version: '1' },
    input_dataset_versions: [INPUT],
    status: 'queued',
    attempt: 0,
    progress: null,
    input_count: 1,
    output_count: null,
    output_dataset_version: null,
    cache_hit: false,
    error: null,
    created_at: '2026-07-25T12:00:00.000Z',
    started_at: null,
    finished_at: null,
  }

  test('binds the public job resource to its cache key and terminal state', () => {
    expect(TransformJobV2Schema.parse(queued)).toEqual(queued)
    expect(TransformJobV2Schema.safeParse({ ...queued, id: `job_${'d'.repeat(64)}` }).success).toBe(
      false,
    )
    expect(TransformJobV2Schema.safeParse({ ...queued, cache_hit: true }).success).toBe(false)
    expect(
      TransformJobV2Schema.safeParse({
        ...queued,
        status: 'completed',
        cache_hit: true,
        output_count: 1,
        output_dataset_version: OUTPUT,
        finished_at: '2026-07-25T12:01:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      TransformJobV2Schema.safeParse({
        ...queued,
        status: 'failed',
        finished_at: '2026-07-25T12:01:00.000Z',
      }).success,
    ).toBe(false)
  })
})

describe('V10 dataset lineage contracts', () => {
  test('materializes bounded defaults and rejects cursor/limit overflow', () => {
    expect(LineagePageRequestV2Schema.parse({ cursor: null })).toEqual({
      max_depth: V2_LINEAGE_DEFAULT_MAX_DEPTH,
      max_nodes: V2_LINEAGE_DEFAULT_MAX_NODES,
      cursor: null,
    })
    expect(
      LineagePageRequestV2Schema.safeParse({ max_depth: 33, max_nodes: 1, cursor: null }).success,
    ).toBe(false)
    expect(
      LineagePageRequestV2Schema.safeParse({ max_depth: 1, max_nodes: 1001, cursor: null }).success,
    ).toBe(false)
  })

  test('requires unique nodes/edges and a cursor exactly when truncated', () => {
    const node = { dataset_version: OUTPUT, manifest }
    const edge = {
      run_id: `run_${CACHE_KEY}`,
      input_dataset_versions: [INPUT],
      output_dataset_version: OUTPUT,
    }
    expect(
      DatasetLineageV2Schema.parse({
        root_dataset_version: OUTPUT,
        nodes: [node],
        edges: [edge],
        truncated: false,
        next_cursor: null,
      }),
    ).toBeDefined()
    expect(
      DatasetLineageV2Schema.safeParse({
        root_dataset_version: OUTPUT,
        nodes: [node, node],
        edges: [edge],
        truncated: false,
        next_cursor: null,
      }).success,
    ).toBe(false)
    expect(
      DatasetLineageV2Schema.safeParse({
        root_dataset_version: OUTPUT,
        nodes: [node],
        edges: [edge, edge],
        truncated: true,
        next_cursor: null,
      }).success,
    ).toBe(false)
  })

  test('rejects lineage response arrays above the global node and edge cap', () => {
    const versions = Array.from({ length: V2_LINEAGE_MAX_NODES + 1 }, (_, index) =>
      index.toString(16).padStart(64, '0'),
    )
    const oversizedNodes = DatasetLineageV2Schema.safeParse({
      root_dataset_version: OUTPUT,
      nodes: versions.map((datasetVersion) => ({
        dataset_version: datasetVersion,
        manifest: createDatasetManifestV2({
          identity_profile: 'databench-v2-jcs-1',
          record_schema_version: '2.0.0',
          dataset_version: datasetVersion,
          num_records: 0,
          layout_version: 'record-json-v1',
          artifact_digest: datasetVersion,
          artifact_size_bytes: 0,
        }),
      })),
      edges: [],
      truncated: false,
      next_cursor: null,
    })
    expect(oversizedNodes.success).toBe(false)
    if (oversizedNodes.success) throw new Error('oversized lineage nodes unexpectedly parsed')
    expect(oversizedNodes.error.issues).toContainEqual(
      expect.objectContaining({ code: 'too_big', path: ['nodes'] }),
    )

    const oversizedEdges = DatasetLineageV2Schema.safeParse({
      root_dataset_version: OUTPUT,
      nodes: [],
      edges: versions.map((cacheKey) => ({
        run_id: `run_${cacheKey}`,
        input_dataset_versions: [INPUT],
        output_dataset_version: OUTPUT,
      })),
      truncated: false,
      next_cursor: null,
    })
    expect(oversizedEdges.success).toBe(false)
    if (oversizedEdges.success) throw new Error('oversized lineage edges unexpectedly parsed')
    expect(oversizedEdges.error.issues).toContainEqual(
      expect.objectContaining({ code: 'too_big', path: ['edges'] }),
    )
  })
})
