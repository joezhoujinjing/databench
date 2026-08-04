import type {
  CatalogModelAliasRowV2,
  CatalogModelDeploymentAdoptionResultV2,
  CatalogModelListItemV2,
  CatalogModelRowV2,
  CatalogModelSourceEvidenceRowV2,
  CatalogModelVersionListItemV2,
  CatalogModelVersionRowV2,
  CatalogModelVersionSourceV2,
} from '@databench/catalog'
import {
  type ModelAliasV2,
  ModelAliasV2Schema,
  type ModelDeploymentAdoptionV2,
  ModelDeploymentAdoptionV2Schema,
  type ModelListItemV2,
  ModelListItemV2Schema,
  type ModelSourceClassificationV2Schema,
  type ModelV2,
  ModelV2Schema,
  type ModelVersionV2,
  ModelVersionV2Schema,
} from '@databench/schema'
import type { z } from 'zod'

type ModelSourceClassificationV2 = z.infer<typeof ModelSourceClassificationV2Schema>

export function modelFromCatalogV2(row: CatalogModelRowV2): ModelV2 {
  return ModelV2Schema.parse({
    id: row.id,
    key: row.key,
    display_name: row.displayName,
    description: row.description,
    task_family: row.taskFamily,
    tags: row.tags,
    metadata_revision: Number(row.metadataRevision),
    archived_at: row.archivedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  })
}

export function modelListItemFromCatalogV2(row: CatalogModelListItemV2): ModelListItemV2 {
  const candidateClassification =
    row.candidate === null
      ? null
      : classifyCatalogModelSourceV2(row.candidate.source, row.candidate.evidence)
  return ModelListItemV2Schema.parse({
    model: modelFromCatalogV2(row.model),
    candidate:
      row.candidate === null || candidateClassification === null
        ? null
        : {
            version_id: row.candidate.version.id,
            version_label: row.candidate.version.versionLabel,
            source_kind: row.candidate.version.sourceKind,
            source_mutability: candidateClassification.source_mutability,
            verification_level: candidateClassification.verification_level,
            base_model_reference: row.candidate.version.baseModelReference,
          },
    version_count: row.versionCount,
    adopted_deployment_count: row.adoptedDeploymentCount,
    healthy_adopted_deployment_count: row.healthyAdoptedDeploymentCount,
  })
}

export function modelVersionFromCatalogV2(row: CatalogModelVersionListItemV2): ModelVersionV2 {
  return ModelVersionV2Schema.parse({
    id: row.version.id,
    model_id: row.version.modelId,
    version_label: row.version.versionLabel,
    source_kind: row.version.sourceKind,
    source_fingerprint: row.version.sourceFingerprint,
    base_model:
      row.version.baseModelReference === null
        ? null
        : {
            reference: row.version.baseModelReference,
            revision: row.version.baseModelRevision,
          },
    base_model_binding_status: row.version.baseModelBindingStatus,
    classification: classifyCatalogModelSourceV2(row.source, row.evidence),
    source: modelVersionSourceFromCatalogV2(row.source),
    repository_observation:
      row.source.kind === 'repository_reference'
        ? repositoryObservationFromCatalogV2(row.evidence)
        : null,
    created_at: row.version.createdAt.toISOString(),
  })
}

export function modelAliasFromCatalogV2(row: CatalogModelAliasRowV2): ModelAliasV2 {
  return ModelAliasV2Schema.parse({
    alias: row.alias,
    version_id: row.versionId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  })
}

export function modelDeploymentAdoptionFromCatalogV2(
  result: CatalogModelDeploymentAdoptionResultV2,
): ModelDeploymentAdoptionV2 {
  return ModelDeploymentAdoptionV2Schema.parse({
    adoption_profile: result.row.adoptionProfile,
    adoption_digest: result.row.adoptionDigest,
    model_id: result.row.modelId,
    model_version_id: result.row.modelVersionId,
    deployment_id: result.row.deploymentId,
    deployment_digest: result.row.deploymentDigest,
    artifact_id: result.row.artifactId,
    adopted_at: result.row.adoptedAt.toISOString(),
    replayed: result.replayed,
  })
}

export function classifyCatalogModelSourceV2(
  source: CatalogModelVersionSourceV2,
  evidence: readonly CatalogModelSourceEvidenceRowV2[],
): ModelSourceClassificationV2 {
  if (source.kind === 'databench_artifact') {
    return {
      source_mutability: 'immutable',
      verification_level: 'content_verified',
      evidence_digest: null,
    }
  }
  const expectedRevision =
    source.kind === 'repository_reference' ? source.revision : source.externalVersionRef
  const matchingVerifiedIndex = evidence.findLastIndex(
    (entry) =>
      entry.result === 'verified' &&
      entry.evidenceKind === 'provider_resolution' &&
      (source.kind === 'repository_reference' && source.revisionKind === 'tag'
        ? entry.observedRevision !== null
        : entry.observedRevision === expectedRevision) &&
      entry.responseDigest !== null,
  )
  const driftIndex = evidence.findLastIndex((entry) => entry.result === 'revision_mismatch')
  const verified = matchingVerifiedIndex >= 0 && matchingVerifiedIndex > driftIndex
  const declaredMutable =
    (source.kind === 'repository_reference' && source.revisionKind === 'tag') ||
    (source.kind === 'existing_service' && source.declaredReferenceKind === 'mutable_alias')
  const exactRepositoryReference =
    source.kind === 'repository_reference' &&
    (source.revisionKind === 'commit' || source.revisionKind === 'digest')
  const classificationEvidence =
    driftIndex > matchingVerifiedIndex ? evidence[driftIndex] : evidence[matchingVerifiedIndex]
  return {
    source_mutability: declaredMutable
      ? 'mutable'
      : exactRepositoryReference && verified
        ? 'immutable'
        : 'unknown',
    verification_level: verified ? 'provider_verified' : 'operator_attested',
    evidence_digest: classificationEvidence?.evidenceDigest ?? null,
  }
}

function repositoryObservationFromCatalogV2(evidence: readonly CatalogModelSourceEvidenceRowV2[]) {
  const latest = evidence.at(-1)
  return {
    availability:
      latest === undefined
        ? 'unobserved'
        : latest.result === 'verified'
          ? 'available'
          : latest.result === 'not_found'
            ? 'not_found'
            : latest.result === 'unavailable'
              ? 'unavailable'
              : 'invalid',
    license: latest?.license ?? null,
    cache_status: latest?.cacheStatus ?? 'unknown',
    evidence_count: evidence.length,
    latest_evidence:
      latest === undefined
        ? null
        : {
            evidence_digest: latest.evidenceDigest,
            evidence_kind: latest.evidenceKind,
            adapter: latest.adapter,
            adapter_version: latest.adapterVersion,
            observed_revision: latest.observedRevision,
            observed_at: latest.observedAt.toISOString(),
            result: latest.result,
            response_digest: latest.responseDigest,
            license: latest.license,
            cache_status: latest.cacheStatus,
          },
    materialization: { state: 'not_materialized', handoff: 'future_import_job' },
  } as const
}

function modelVersionSourceFromCatalogV2(source: CatalogModelVersionSourceV2) {
  if (source.kind === 'databench_artifact') {
    return {
      kind: source.kind,
      artifact_id: source.artifactId,
      artifact_kind: source.artifactKind,
      artifact_format: source.artifactFormat,
      archive_digest: source.archiveDigest,
      manifest_digest: source.manifestDigest,
    }
  }
  if (source.kind === 'repository_reference') {
    return {
      kind: source.kind,
      provider: source.provider,
      repository_id: source.repositoryId,
      revision: source.revision,
      revision_kind: source.revisionKind,
    }
  }
  return {
    kind: source.kind,
    provider: source.provider,
    external_model_ref: source.externalModelRef,
    external_version_ref: source.externalVersionRef,
    declared_reference_kind: source.declaredReferenceKind,
  }
}

export function modelVersionItem(
  version: CatalogModelVersionRowV2,
  source: CatalogModelVersionSourceV2,
  evidence: readonly CatalogModelSourceEvidenceRowV2[],
): CatalogModelVersionListItemV2 {
  return { version, source, evidence }
}
