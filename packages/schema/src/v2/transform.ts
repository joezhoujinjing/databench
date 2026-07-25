import { z } from 'zod'
import { ConflictError } from '../errors.js'
import { DigestHexSchema, Rfc3339UtcSchema } from './common.js'
import {
  type DeterminismConflictDetailV2,
  DeterminismConflictDetailV2Schema,
  OpaqueCursorQueryV2Schema,
  RefNameV2Schema,
  RefOrVersionV2Schema,
  RefUpdateResultV2Schema,
} from './contracts.js'
import { JsonObjectSchema } from './json-value.js'
import { DatasetManifestV2Schema } from './manifest.js'

export const V2_TRANSFORM_MAX_INPUTS = 16
export const V2_TRANSFORM_REGISTRY_MAX_ITEMS = 128
export const V2_LINEAGE_DEFAULT_MAX_DEPTH = 8
export const V2_LINEAGE_MAX_DEPTH = 32
export const V2_LINEAGE_DEFAULT_MAX_NODES = 100
export const V2_LINEAGE_MAX_NODES = 1_000
// The lineage cursor is carried by a GET query in V12. Keep it within the same
// proxy-safe envelope as refs cursors; traversal state is replay counters, not
// an embedded frontier.
export const V2_LINEAGE_CURSOR_MAX_CHARS = 1_536

const TRANSFORM_NAME = /^[a-z][a-z0-9._-]{0,127}$/
const TRANSFORM_VERSION = /^[a-z0-9][a-z0-9._-]{0,127}$/
const RUN_ID = /^run_[0-9a-f]{64}$/

export const TransformNameV2Schema = z.string().regex(TRANSFORM_NAME)
export const TransformVersionV2Schema = z.string().regex(TRANSFORM_VERSION)
export const TransformInputRoleV2Schema = z.string().regex(TRANSFORM_NAME)
export type TransformInputRoleV2 = z.infer<typeof TransformInputRoleV2Schema>
export const RunIdV2Schema = z.string().regex(RUN_ID)

export const TransformDescriptorV2Schema = z
  .strictObject({
    name: TransformNameV2Schema,
    version: TransformVersionV2Schema,
    identity_mode: z.enum(['preserve', 'derive']),
    input_roles: z.array(TransformInputRoleV2Schema).min(1).max(V2_TRANSFORM_MAX_INPUTS),
    params_schema: JsonObjectSchema,
    params_example: JsonObjectSchema,
  })
  .meta({ id: 'TransformDescriptorV2' })
export type TransformDescriptorV2 = z.infer<typeof TransformDescriptorV2Schema>

export const TransformRegistryPageV2Schema = z
  .strictObject({
    items: z.array(TransformDescriptorV2Schema).max(V2_TRANSFORM_REGISTRY_MAX_ITEMS),
    total: z.number().int().safe().nonnegative().max(V2_TRANSFORM_REGISTRY_MAX_ITEMS),
  })
  .superRefine((page, context) => {
    if (page.total !== page.items.length) {
      context.addIssue({
        code: 'custom',
        path: ['total'],
        message: 'registry total must equal the complete item count',
      })
    }
    for (let index = 1; index < page.items.length; index += 1) {
      const previous = page.items[index - 1]
      const current = page.items[index]
      if (previous && current && previous.name >= current.name) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'name'],
          message: 'registry items must be strictly ASCII name sorted and unique',
        })
      }
    }
  })
  .meta({ id: 'TransformRegistryPageV2' })
export type TransformRegistryPageV2 = z.infer<typeof TransformRegistryPageV2Schema>

export const TransformParamsV2Schema = z
  .strictObject({ name: TransformNameV2Schema })
  .meta({ id: 'TransformParamsV2' })
export type TransformParamsV2 = z.infer<typeof TransformParamsV2Schema>

export const RunTransformRequestV2Schema = z
  .strictObject({
    inputs: z.array(RefOrVersionV2Schema).min(1).max(V2_TRANSFORM_MAX_INPUTS),
    params: JsonObjectSchema,
    ref: RefNameV2Schema.nullable(),
    expected_ref_version: DigestHexSchema.nullable(),
    message: z.string().min(1).nullable(),
  })
  .superRefine((request, context) => {
    if (request.ref === null && request.expected_ref_version !== null) {
      context.addIssue({
        code: 'custom',
        path: ['expected_ref_version'],
        message: 'expected_ref_version requires ref',
      })
    }
    if (request.ref === null && request.message !== null) {
      context.addIssue({ code: 'custom', path: ['message'], message: 'message requires ref' })
    }
  })
  .meta({ id: 'RunTransformRequestV2' })
export type RunTransformRequestV2 = z.infer<typeof RunTransformRequestV2Schema>

export const RunMetadataV2Schema = z
  .strictObject({
    run_id: RunIdV2Schema,
    cache_key: DigestHexSchema,
    op: TransformNameV2Schema,
    op_version: TransformVersionV2Schema,
    input_dataset_versions: z.array(DigestHexSchema).min(1).max(V2_TRANSFORM_MAX_INPUTS),
    normalized_params: JsonObjectSchema,
    output_dataset_version: DigestHexSchema,
    created_at: Rfc3339UtcSchema,
  })
  .superRefine((run, context) => {
    if (run.run_id !== `run_${run.cache_key}`) {
      context.addIssue({
        code: 'custom',
        path: ['run_id'],
        message: 'run_id must be derived from cache_key',
      })
    }
  })
  .meta({ id: 'RunMetadataV2' })
export type RunMetadataV2 = z.infer<typeof RunMetadataV2Schema>

export const RunTransformResultV2Schema = z
  .strictObject({
    run: RunMetadataV2Schema,
    manifest: DatasetManifestV2Schema,
    ref_update: RefUpdateResultV2Schema,
    cache_hit: z.boolean(),
  })
  .superRefine((result, context) => {
    if (
      result.run.output_dataset_version !== result.manifest.dataset_version ||
      (result.ref_update.status === 'updated' &&
        result.ref_update.current_version !== result.run.output_dataset_version)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['manifest', 'dataset_version'],
        message: 'run, manifest and updated ref must identify the same output dataset',
      })
    }
  })
  .meta({ id: 'RunTransformResultV2' })
export type RunTransformResultV2 = z.infer<typeof RunTransformResultV2Schema>

export class DeterminismConflictErrorV2 extends ConflictError {
  override readonly name = 'DeterminismConflictErrorV2'
  override readonly code = 'determinism_conflict'

  constructor(detailInput: DeterminismConflictDetailV2) {
    const detail = Object.freeze(DeterminismConflictDetailV2Schema.parse(detailInput))
    super(`V2 transform cache conflict for ${detail.cache_key}`, detail)
  }
}

export const LineagePageRequestV2Schema = z
  .strictObject({
    max_depth: z.coerce
      .number()
      .int()
      .safe()
      .min(0)
      .max(V2_LINEAGE_MAX_DEPTH)
      .default(V2_LINEAGE_DEFAULT_MAX_DEPTH),
    max_nodes: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(V2_LINEAGE_MAX_NODES)
      .default(V2_LINEAGE_DEFAULT_MAX_NODES),
    cursor: OpaqueCursorQueryV2Schema,
  })
  .meta({ id: 'LineagePageRequestV2' })
export type LineagePageRequestV2 = z.infer<typeof LineagePageRequestV2Schema>

export const DatasetLineageNodeV2Schema = z
  .strictObject({
    dataset_version: DigestHexSchema,
    manifest: DatasetManifestV2Schema,
  })
  .superRefine((node, context) => {
    if (node.dataset_version !== node.manifest.dataset_version) {
      context.addIssue({
        code: 'custom',
        path: ['manifest', 'dataset_version'],
        message: 'lineage node manifest must match dataset_version',
      })
    }
  })

export const DatasetLineageEdgeV2Schema = z.strictObject({
  run_id: RunIdV2Schema,
  input_dataset_versions: z.array(DigestHexSchema).min(1).max(V2_TRANSFORM_MAX_INPUTS),
  output_dataset_version: DigestHexSchema,
})

export const DatasetLineageV2Schema = z
  .strictObject({
    root_dataset_version: DigestHexSchema,
    nodes: z.array(DatasetLineageNodeV2Schema).max(V2_LINEAGE_MAX_NODES),
    edges: z.array(DatasetLineageEdgeV2Schema).max(V2_LINEAGE_MAX_NODES),
    truncated: z.boolean(),
    next_cursor: z.string().min(1).max(V2_LINEAGE_CURSOR_MAX_CHARS).nullable(),
  })
  .superRefine((lineage, context) => {
    const nodeVersions = new Set<string>()
    for (let index = 0; index < lineage.nodes.length; index += 1) {
      const version = lineage.nodes[index]?.dataset_version
      if (version === undefined) continue
      if (nodeVersions.has(version)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'dataset_version'],
          message: 'lineage dataset nodes must be unique',
        })
      }
      nodeVersions.add(version)
    }
    const runIds = new Set<string>()
    for (let index = 0; index < lineage.edges.length; index += 1) {
      const runId = lineage.edges[index]?.run_id
      if (runId === undefined) continue
      if (runIds.has(runId)) {
        context.addIssue({
          code: 'custom',
          path: ['edges', index, 'run_id'],
          message: 'lineage run edges must be unique',
        })
      }
      runIds.add(runId)
    }
    if (lineage.truncated !== (lineage.next_cursor !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['next_cursor'],
        message: 'truncated lineage must provide exactly one continuation cursor',
      })
    }
  })
  .meta({ id: 'DatasetLineageV2' })
export type DatasetLineageV2 = z.infer<typeof DatasetLineageV2Schema>
