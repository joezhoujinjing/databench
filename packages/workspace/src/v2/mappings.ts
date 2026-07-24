import {
  type CatalogLayoutRowV2,
  type CatalogRefRowV2,
  type CatalogSnapshotRowV2,
  type RegisterLayoutV2,
  V2CatalogConsistencyError,
  V2CatalogImmutableConflictError,
  V2CatalogInputError,
  V2CatalogLineageCycleError,
  V2CatalogRefConflictError,
  V2CatalogTargetNotCommittedError,
} from '@databench/catalog'
import type { V2Dataset } from '@databench/engine'
import {
  createDatasetManifestV2,
  type DatasetLayoutIdentityV2,
  DatasetLayoutIdentityV2Schema,
  type DatasetManifestV2,
  datasetLayoutIdentityV2FromManifest,
  IntegrityError,
  NotFoundError,
  RefConflictErrorV2,
  type RefMetadataV2,
  RefMetadataV2Schema,
  ServiceUnavailableError,
  V2_RECORD_JSON_COLUMNS,
  ValidationError,
} from '@databench/schema'
import { v2ObjectKeys } from '@databench/store'

export function registrationFromCommittedDataset(
  dataset: V2Dataset,
  manifestInput: DatasetManifestV2,
): RegisterLayoutV2 {
  const identity = datasetLayoutIdentityV2FromManifest(manifestInput)
  assertDatasetMatchesLayout(dataset, identity)
  const keys = v2ObjectKeys(identity)
  return {
    snapshot: {
      version: dataset.version,
      identityProfile: dataset.identity.identity_profile,
      recordSchemaVersion: dataset.identity.record_schema_version,
      numRecords: BigInt(dataset.length),
    },
    layout: {
      datasetVersion: dataset.version,
      layoutVersion: identity.layout_version,
      artifactDigest: identity.artifact_digest,
      artifactSizeBytes: BigInt(identity.artifact_size_bytes),
      manifestKey: keys.manifest,
      columns: [...V2_RECORD_JSON_COLUMNS],
    },
    revisions: [...dataset.records()].map((revision) => ({
      recordId: revision.record.id,
      recordDigest: revision.record_digest,
      parents: (revision.record.lineage?.parent_refs ?? []).map((parent) => ({
        recordId: parent.id,
        recordDigest: parent.record_digest,
      })),
    })),
  }
}

export function layoutIdentityFromCatalog(
  snapshot: CatalogSnapshotRowV2,
  layout: CatalogLayoutRowV2,
): Readonly<DatasetLayoutIdentityV2> {
  try {
    if (layout.datasetVersion !== snapshot.version) {
      throw new Error('catalog snapshot/layout version mismatch')
    }
    if (
      layout.columns.length !== V2_RECORD_JSON_COLUMNS.length ||
      layout.columns.some((column, index) => column !== V2_RECORD_JSON_COLUMNS[index])
    ) {
      throw new Error('catalog layout columns mismatch')
    }
    const identity = Object.freeze(
      DatasetLayoutIdentityV2Schema.parse({
        identity_profile: snapshot.identityProfile,
        record_schema_version: snapshot.recordSchemaVersion,
        dataset_version: snapshot.version,
        num_records: storedBigIntToSafeNumber(snapshot.numRecords, 'num_records'),
        layout_version: layout.layoutVersion,
        artifact_digest: layout.artifactDigest,
        artifact_size_bytes: storedBigIntToSafeNumber(
          layout.artifactSizeBytes,
          'artifact_size_bytes',
        ),
      }),
    )
    if (layout.manifestKey !== v2ObjectKeys(identity).manifest) {
      throw new Error('catalog manifest key mismatch')
    }
    return identity
  } catch (error) {
    if (error instanceof IntegrityError) throw error
    throw new IntegrityError('Stored V2 catalog layout metadata is inconsistent', {
      reason: 'catalog_layout_invalid',
    })
  }
}

export function manifestFromCatalogIdentity(
  identity: DatasetLayoutIdentityV2,
): Readonly<DatasetManifestV2> {
  return createDatasetManifestV2(identity)
}

export function refMetadataFromCatalog(row: CatalogRefRowV2): RefMetadataV2 {
  return RefMetadataV2Schema.parse({
    name: row.name,
    version: row.version,
    num_records: storedBigIntToSafeNumber(row.numRecords, 'num_records'),
    message: row.message,
    updated_at: row.updatedAt.toISOString(),
  })
}

export function mapV2CatalogError(
  error: unknown,
  refConflictDatasetCommitted: boolean,
  targetExpectedCommitted = refConflictDatasetCommitted,
): never {
  if (error instanceof V2CatalogRefConflictError) {
    throw new RefConflictErrorV2({
      ref_name: error.refName,
      expected_version: error.expectedVersion,
      current_version: error.currentVersion,
      new_version: error.newVersion,
      new_dataset_committed: refConflictDatasetCommitted,
    })
  }
  if (error instanceof V2CatalogTargetNotCommittedError) {
    if (!targetExpectedCommitted) {
      throw new NotFoundError('V2 ref target is not a committed dataset', {
        dataset_version: error.version,
      })
    }
    throw new IntegrityError('Newly registered V2 dataset has no committed ref target', {
      reason: 'registered_layout_missing',
      dataset_version: error.version,
    })
  }
  if (error instanceof V2CatalogLineageCycleError) {
    throw new ValidationError('V2 record lineage would form a cycle', {
      issues: [
        {
          path: '/lineage/parent_refs',
          line: null,
          code: 'lineage_cycle',
          message: error.message,
        },
      ],
    })
  }
  if (
    error instanceof V2CatalogConsistencyError ||
    error instanceof V2CatalogImmutableConflictError ||
    error instanceof V2CatalogInputError
  ) {
    throw new IntegrityError('V2 catalog rejected canonical workspace metadata', {
      reason: error.name,
    })
  }
  throw new ServiceUnavailableError(
    'V2 Catalog operation is unavailable',
    { dependency: 'catalog' },
    { cause: error },
  )
}

function assertDatasetMatchesLayout(dataset: V2Dataset, identity: DatasetLayoutIdentityV2): void {
  if (
    dataset.version !== identity.dataset_version ||
    dataset.length !== identity.num_records ||
    dataset.identity.identity_profile !== identity.identity_profile ||
    dataset.identity.record_schema_version !== identity.record_schema_version
  ) {
    throw new IntegrityError('Committed V2 manifest does not match the prepared dataset', {
      reason: 'committed_manifest_dataset_mismatch',
    })
  }
}

function storedBigIntToSafeNumber(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IntegrityError(`Stored V2 ${field} is outside the safe integer range`, {
      reason: 'catalog_integer_out_of_range',
      field,
      actual: value.toString(),
    })
  }
  return Number(value)
}
