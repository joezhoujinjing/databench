import type { CatalogModelArtifactImportRowV2, CatalogModelArtifactRowV2 } from '@databench/catalog'
import {
  canonicalJsonV2,
  hashArtifactBytes,
  hashV2ModelArtifactImportCreate,
  V2_MODEL_ARTIFACT_IMPORT_CREATE_PROFILE,
} from '@databench/hashing'
import {
  IntegrityError,
  type ModelArtifactImportV2,
  ModelArtifactImportV2Schema,
  type ModelArtifactManifestV2,
  ModelArtifactManifestV2Schema,
  type ModelArtifactV2,
  ModelArtifactV2Schema,
} from '@databench/schema'

const encoder = new TextEncoder()

export function modelArtifactImportFromCatalogV2(
  row: CatalogModelArtifactImportRowV2,
): ModelArtifactImportV2 {
  const expectedCreateDigest = hashV2ModelArtifactImportCreate({
    model_artifact_import_create_profile: V2_MODEL_ARTIFACT_IMPORT_CREATE_PROFILE,
    namespace: row.namespaceId,
    studio_session_id: row.studioSessionId,
    output_handle_digest: row.outputHandleDigest,
    artifact_kind: row.artifactKind,
    display_name: row.displayName,
    base_model: {
      reference: row.baseModelReference,
      revision: row.baseModelRevision,
    },
  })
  if (row.createDigest !== expectedCreateDigest) {
    throw new IntegrityError('Stored Model Artifact import identity is inconsistent', {
      reason: 'model_artifact_import_create_digest_mismatch',
      import_id: row.id,
    })
  }
  return ModelArtifactImportV2Schema.parse({
    id: row.id,
    create_digest: row.createDigest,
    status: row.status,
    studio_session_id: row.studioSessionId,
    artifact_kind: row.artifactKind,
    display_name: row.displayName,
    base_model: {
      reference: row.baseModelReference,
      revision: row.baseModelRevision,
    },
    output_snapshot_digest: row.outputSnapshotDigest,
    archive_digest: row.archiveDigest,
    archive_size_bytes:
      row.archiveSizeBytes === null
        ? null
        : storedBigIntToSafeNumber(row.archiveSizeBytes, 'archive_size_bytes'),
    manifest_digest: row.manifestDigest,
    artifact_id: row.artifactId,
    failure: row.failure,
    created_at: row.createdAt.toISOString(),
    staging_at: row.stagingAt?.toISOString() ?? null,
    finalizing_at: row.finalizingAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    failed_at: row.failedAt?.toISOString() ?? null,
    updated_at: row.updatedAt.toISOString(),
  })
}

export function modelArtifactFromCatalogV2(row: CatalogModelArtifactRowV2): ModelArtifactV2 {
  const manifest = verifiedManifest(row.manifest, row.manifestDigest, row.id)
  return ModelArtifactV2Schema.parse({
    id: row.id,
    display_name: row.displayName,
    artifact_kind: row.artifactKind,
    artifact_format: row.artifactFormat,
    archive_format: row.archiveFormat,
    archive_digest: row.archiveDigest,
    archive_size_bytes: storedBigIntToSafeNumber(row.archiveSizeBytes, 'archive_size_bytes'),
    manifest_digest: row.manifestDigest,
    manifest,
    source: {
      studio_session_id: row.sourceSessionId,
      import_id: row.sourceImportId,
    },
    dataset_lineage: {
      status: row.datasetLineageStatus,
      dataset_version: row.datasetVersion,
      dataset_export_digest: row.datasetExportDigest,
    },
    base_model: {
      reference: row.baseModelReference,
      revision: row.baseModelRevision,
      binding_status: row.baseModelBindingStatus,
    },
    upstream_commit: row.upstreamCommit,
    image_digest: row.imageDigest,
    created_at: row.createdAt.toISOString(),
  })
}

export function modelArtifactManifestDigestV2(manifest: ModelArtifactManifestV2): string {
  return hashArtifactBytes(encoder.encode(canonicalJsonV2(manifest)))
}

function verifiedManifest(
  input: unknown,
  expectedDigest: string,
  artifactId: string,
): ModelArtifactManifestV2 {
  const manifest = ModelArtifactManifestV2Schema.parse(input)
  const actualDigest = modelArtifactManifestDigestV2(manifest)
  if (actualDigest !== expectedDigest) {
    throw new IntegrityError('Stored Model Artifact manifest digest is inconsistent', {
      reason: 'model_artifact_manifest_digest_mismatch',
      artifact_id: artifactId,
    })
  }
  return manifest
}

function storedBigIntToSafeNumber(value: bigint, field: string): number {
  const converted = Number(value)
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new IntegrityError('Stored Model Artifact quantity is outside the wire range', {
      reason: 'model_artifact_quantity_invalid',
      field,
    })
  }
  return converted
}
