import { TextEncoder } from 'node:util'
import { canonicalJsonV2, hashArtifactBytes } from '@databench/hashing'
import {
  type DatabaseRetirementPlan,
  type DatabaseTablePlan,
  type ObjectMetadata,
  type ObjectRetirementPlan,
  type RetirementManifest,
  RetirementManifestSchema,
  type V2AuditResult,
  type V2Baseline,
  type V2CatalogFingerprint,
} from './types.js'

const textEncoder = new TextEncoder()

export function digestCanonicalValue(value: unknown): string {
  return hashArtifactBytes(textEncoder.encode(canonicalJsonV2(value)))
}

export function createDatabaseRetirementPlan(
  schema: string,
  tablesInput: readonly DatabaseTablePlan[],
): Readonly<DatabaseRetirementPlan> {
  const tables = [...tablesInput]
    .map((table) => ({
      ...table,
      foreign_keys: [...table.foreign_keys].sort(compareForeignKeys),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const totalRows = tables.reduce((total, table) => total + BigInt(table.row_count), 0n)
  const digest = digestCanonicalValue({
    manifest_version: 'databench-v1-database-retirement-plan-1',
    schema,
    tables: tables.map((table) => ({
      name: table.name,
      exists: table.exists,
      row_count: table.row_count,
      rows_digest: table.rows_digest,
      rows_md5: table.rows_md5,
      foreign_keys: table.foreign_keys,
    })),
  })
  return Object.freeze({
    schema,
    tables,
    total_rows: totalRows.toString(),
    digest,
  })
}

export function createObjectRetirementPlan(input: {
  readonly provider: ObjectRetirementPlan['provider']
  readonly bucket: string
  readonly targets: readonly ObjectRetirementPlan['targets'][number][]
  readonly unrecognizedLegacyPrefixObjects: readonly ObjectMetadata[]
  readonly protectedV2ObjectCount: number
}): Readonly<ObjectRetirementPlan> {
  const targets = [...input.targets].sort(compareObjects)
  const unrecognized = [...input.unrecognizedLegacyPrefixObjects].sort(compareObjects)
  const targetBytes = targets.reduce((total, object) => checkedAdd(total, object.size), 0)
  const digest = digestCanonicalValue({
    manifest_version: 'databench-v1-object-retirement-plan-1',
    provider: input.provider,
    bucket: input.bucket,
    targets,
  })
  return Object.freeze({
    provider: input.provider,
    bucket: input.bucket,
    targets,
    target_count: targets.length,
    target_bytes: targetBytes,
    unrecognized_legacy_prefix_objects: unrecognized,
    protected_v2_object_count: input.protectedV2ObjectCount,
    digest,
  })
}

export function createV2Baseline(input: {
  readonly catalog: readonly V2CatalogFingerprint[]
  readonly objects: readonly ObjectMetadata[]
  readonly audits: readonly V2AuditResult[]
}): Readonly<V2Baseline> {
  const catalog = [...input.catalog].sort((left, right) => left.table.localeCompare(right.table))
  const objects = [...input.objects].sort(compareObjects)
  const audits = [...input.audits].sort((left, right) =>
    left.dataset_version.localeCompare(right.dataset_version),
  )
  const digest = digestCanonicalValue({
    manifest_version: 'databench-v2-retirement-safety-baseline-1',
    catalog,
    objects,
    audits,
  })
  return Object.freeze({ catalog, objects, audits, digest })
}

export function createRetirementManifest(input: {
  readonly database: DatabaseRetirementPlan
  readonly objects: ObjectRetirementPlan
  readonly v2Baseline: V2Baseline
}): Readonly<RetirementManifest> {
  return RetirementManifestSchema.parse({
    manifest_version: 'databench-v1-retirement-preflight-1',
    database: input.database,
    objects: input.objects,
    v2_baseline: input.v2Baseline,
  })
}

export function parseRetirementManifest(value: unknown): RetirementManifest {
  const manifest = RetirementManifestSchema.parse(value)
  const database = createDatabaseRetirementPlan(manifest.database.schema, manifest.database.tables)
  if (database.digest !== manifest.database.digest) {
    throw new TypeError('retirement manifest database digest does not match its contents')
  }
  const objects = createObjectRetirementPlan({
    provider: manifest.objects.provider,
    bucket: manifest.objects.bucket,
    targets: manifest.objects.targets,
    unrecognizedLegacyPrefixObjects: manifest.objects.unrecognized_legacy_prefix_objects,
    protectedV2ObjectCount: manifest.objects.protected_v2_object_count,
  })
  if (objects.digest !== manifest.objects.digest) {
    throw new TypeError('retirement manifest object digest does not match its contents')
  }
  const baseline = createV2Baseline({
    catalog: manifest.v2_baseline.catalog,
    objects: manifest.v2_baseline.objects,
    audits: manifest.v2_baseline.audits,
  })
  if (baseline.digest !== manifest.v2_baseline.digest) {
    throw new TypeError('retirement manifest v2 baseline digest does not match its contents')
  }
  return manifest
}

function compareForeignKeys(
  left: DatabaseTablePlan['foreign_keys'][number],
  right: DatabaseTablePlan['foreign_keys'][number],
): number {
  return (
    left.source_table.localeCompare(right.source_table) ||
    left.target_table.localeCompare(right.target_table) ||
    left.name.localeCompare(right.name) ||
    left.definition.localeCompare(right.definition)
  )
}

function compareObjects(left: ObjectMetadata, right: ObjectMetadata): number {
  return left.key.localeCompare(right.key)
}

function checkedAdd(left: number, right: number): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('object retirement byte total exceeds the safe integer range')
  }
  return result
}
