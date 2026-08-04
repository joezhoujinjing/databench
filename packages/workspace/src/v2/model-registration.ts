import {
  type CatalogJsonValueV2,
  type CatalogModelArtifactRowV2,
  type CatalogModelRegistrationResultV2,
  type CatalogModelRowV2,
  type CatalogModelVersionSourceV2,
  type CreateModelRegistrationV2,
  V2CatalogConsistencyError,
  V2CatalogInputError,
  V2CatalogModelAliasConflictError,
  V2CatalogModelRegistrationConflictError,
} from '@databench/catalog'
import {
  canonicalJsonV2,
  deriveV2ModelIdFromCreateDigest,
  deriveV2ModelSourceEvidenceIdFromDigest,
  deriveV2ModelVersionIdFromCreateDigest,
  hashV2ModelCreate,
  hashV2ModelRegistrationPlanArtifact,
  hashV2ModelRegistrationPlanRepository,
  hashV2ModelRegistrationPlanService,
  hashV2ModelSourceEvidence,
  hashV2ModelSourceFingerprintArtifact,
  hashV2ModelSourceFingerprintRepository,
  hashV2ModelSourceFingerprintService,
  hashV2ModelVersionCreateArtifact,
  hashV2ModelVersionCreateRepository,
  hashV2ModelVersionCreateService,
  V2_MODEL_CREATE_PROFILE,
  V2_MODEL_REGISTRATION_PLAN_ARTIFACT_PROFILE,
  V2_MODEL_REGISTRATION_PLAN_REPOSITORY_PROFILE,
  V2_MODEL_REGISTRATION_PLAN_SERVICE_PROFILE,
  V2_MODEL_SOURCE_EVIDENCE_PROFILE,
  V2_MODEL_SOURCE_FINGERPRINT_ARTIFACT_PROFILE,
  V2_MODEL_SOURCE_FINGERPRINT_REPOSITORY_PROFILE,
  V2_MODEL_SOURCE_FINGERPRINT_SERVICE_PROFILE,
  V2_MODEL_VERSION_CREATE_ARTIFACT_PROFILE,
  V2_MODEL_VERSION_CREATE_REPOSITORY_PROFILE,
  V2_MODEL_VERSION_CREATE_SERVICE_PROFILE,
} from '@databench/hashing'
import {
  type CommitModelRegistrationRequestV2,
  CommitModelRegistrationRequestV2Schema,
  ConflictError,
  classifyModelVersionSourceV2,
  IntegrityError,
  type ModelArtifactRegistrationRequestV2,
  ModelArtifactRegistrationRequestV2Schema,
  ModelRegistrationCommitResultV2Schema,
  type ModelRegistrationInspectRequestV2,
  ModelRegistrationInspectRequestV2Schema,
  type ModelRegistrationPlanV2,
  ModelRegistrationPlanV2Schema,
  type ModelRegistrationWarningV2,
  type ModelRepositoryRegistrationRequestV2,
  ModelRepositoryRegistrationRequestV2Schema,
  type ModelServiceRegistrationRequestV2,
  ModelServiceRegistrationRequestV2Schema,
  NotFoundError,
  UnsupportedProfileError,
  ValidationError,
} from '@databench/schema'
import type { V2ModelRepositoryRuntime } from './model-repository.js'

export interface V2ModelRegistrationCatalog {
  getModel(namespaceId: string, modelId: string): Promise<CatalogModelRowV2 | null>
  getModelArtifact(
    namespaceId: string,
    artifactId: string,
  ): Promise<CatalogModelArtifactRowV2 | null>
  registerModelVersion(input: CreateModelRegistrationV2): Promise<CatalogModelRegistrationResultV2>
  replayModelRegistration(
    namespaceId: string,
    registrationDigest: string,
    planProfile: CreateModelRegistrationV2['planProfile'],
    normalizedRequest: { readonly [key: string]: CatalogJsonValueV2 },
  ): Promise<CatalogModelRegistrationResultV2 | null>
}

export interface ModelRegistrationCommitResultV2 {
  readonly registration_digest: string
  readonly model_id: string
  readonly model_version_id: string
  readonly source_fingerprint: string
  readonly alias: 'candidate' | 'staging' | 'production' | null
  readonly replayed: boolean
}

interface InspectedModelRegistrationV2 {
  readonly plan: ModelRegistrationPlanV2
  readonly catalogInput: CreateModelRegistrationV2
}

export async function inspectModelRegistrationV2(
  catalog: V2ModelRegistrationCatalog,
  namespaceId: string,
  requestInput: ModelRegistrationInspectRequestV2,
  repositoryRuntime?: V2ModelRepositoryRuntime,
  signal?: AbortSignal,
): Promise<ModelRegistrationPlanV2> {
  return (await inspectRegistration(catalog, namespaceId, requestInput, repositoryRuntime, signal))
    .plan
}

export async function commitModelRegistrationV2(
  catalog: V2ModelRegistrationCatalog,
  namespaceId: string,
  requestInput: CommitModelRegistrationRequestV2,
  repositoryRuntime?: V2ModelRepositoryRuntime,
  signal?: AbortSignal,
): Promise<ModelRegistrationCommitResultV2> {
  signal?.throwIfAborted()
  const request = CommitModelRegistrationRequestV2Schema.parse(requestInput)
  const replay = await catalog.replayModelRegistration(
    namespaceId,
    request.expected_registration_digest,
    planProfileForSource(request.request.source.kind),
    catalogJsonObject(request.request),
  )
  if (replay !== null) return registrationResult(replay)
  const inspected = await inspectRegistration(
    catalog,
    namespaceId,
    request.request,
    repositoryRuntime,
    signal,
  )
  if (request.expected_registration_digest !== inspected.plan.registration_digest) {
    throw new ConflictError('Model registration plan changed before commit', {
      reason: 'registration_digest_mismatch',
      expected_registration_digest: request.expected_registration_digest,
      current_registration_digest: inspected.plan.registration_digest,
    })
  }
  const source = inspected.plan.normalized_request.source
  if (source.kind === 'existing_service' || source.deployment !== undefined) {
    throw new UnsupportedProfileError(
      'Version-bound Model Deployment registration is not enabled in this implementation step',
      { reason: 'model_deployment_v2_not_enabled' },
    )
  }
  if (
    inspected.plan.normalized_request.alias !== undefined &&
    inspected.plan.classification.source_mutability !== 'immutable'
  ) {
    throw new ValidationError('Only immutable Model Versions can receive an alias', {
      issues: [
        {
          path: '/alias',
          line: null,
          code: 'model_alias_requires_immutable_source',
          message: 'The registered source is not verified immutable',
        },
      ],
    })
  }

  signal?.throwIfAborted()
  let result: CatalogModelRegistrationResultV2
  try {
    result = await catalog.registerModelVersion(inspected.catalogInput)
  } catch (error) {
    throw mapModelRegistrationCatalogError(error, inspected.plan.registration_digest)
  }
  signal?.throwIfAborted()
  return registrationResult(result)
}

async function inspectRegistration(
  catalog: V2ModelRegistrationCatalog,
  namespaceId: string,
  requestInput: ModelRegistrationInspectRequestV2,
  repositoryRuntime?: V2ModelRepositoryRuntime,
  signal?: AbortSignal,
): Promise<InspectedModelRegistrationV2> {
  signal?.throwIfAborted()
  const normalizedRequest = ModelRegistrationInspectRequestV2Schema.parse(requestInput)
  if (normalizedRequest.alias !== undefined && normalizedRequest.alias.alias !== 'candidate') {
    throw new UnsupportedProfileError('Only the candidate Model Alias is enabled', {
      reason: 'model_alias_not_enabled',
      alias: normalizedRequest.alias.alias,
    })
  }
  const model = await inspectModelTarget(catalog, namespaceId, normalizedRequest, signal)

  if (normalizedRequest.source.kind === 'databench_artifact') {
    return await inspectArtifactRegistration(
      catalog,
      namespaceId,
      ModelArtifactRegistrationRequestV2Schema.parse(normalizedRequest),
      model,
      signal,
    )
  }
  if (normalizedRequest.source.kind === 'repository_reference') {
    return await inspectRepositoryRegistration(
      namespaceId,
      ModelRepositoryRegistrationRequestV2Schema.parse(normalizedRequest),
      model,
      repositoryRuntime,
      signal,
    )
  }
  return inspectServiceRegistration(
    namespaceId,
    ModelServiceRegistrationRequestV2Schema.parse(normalizedRequest),
    model,
  )
}

interface InspectedModelTargetV2 {
  readonly id: string
  readonly createDigest: string | null
  readonly catalogTarget: CreateModelRegistrationV2['target']
}

async function inspectModelTarget(
  catalog: V2ModelRegistrationCatalog,
  namespaceId: string,
  request: ModelRegistrationInspectRequestV2,
  signal?: AbortSignal,
): Promise<InspectedModelTargetV2> {
  if (request.target.kind === 'existing_model') {
    const stored = await catalog.getModel(namespaceId, request.target.model_id)
    signal?.throwIfAborted()
    if (stored === null) {
      throw new NotFoundError('Model registration target was not found', {
        model_id: request.target.model_id,
      })
    }
    if (stored.archivedAt !== null) {
      throw new ConflictError('Archived Model cannot receive a new Version', {
        reason: 'model_archived',
        model_id: stored.id,
      })
    }
    return {
      id: stored.id,
      createDigest: null,
      catalogTarget: { kind: 'existing_model', modelId: stored.id },
    }
  }

  const createDigest = hashV2ModelCreate({
    model_create_profile: V2_MODEL_CREATE_PROFILE,
    namespace: namespaceId,
    key: request.target.key,
  })
  const id = deriveV2ModelIdFromCreateDigest(createDigest)
  return {
    id,
    createDigest,
    catalogTarget: {
      kind: 'create_model',
      model: {
        id,
        namespaceId,
        key: request.target.key,
        createProfile: V2_MODEL_CREATE_PROFILE,
        createDigest,
        displayName: request.target.display_name,
        description: request.target.description,
        taskFamily: request.target.task_family,
        tags: request.target.tags,
      },
    },
  }
}

async function inspectArtifactRegistration(
  catalog: V2ModelRegistrationCatalog,
  namespaceId: string,
  request: ModelArtifactRegistrationRequestV2,
  model: InspectedModelTargetV2,
  signal?: AbortSignal,
): Promise<InspectedModelRegistrationV2> {
  const artifact = await catalog.getModelArtifact(namespaceId, request.source.artifact_id)
  signal?.throwIfAborted()
  if (artifact === null) {
    throw new NotFoundError('Model Artifact registration source was not found', {
      artifact_id: request.source.artifact_id,
    })
  }
  assertArtifactNamespace(artifact, namespaceId)
  const sourceFingerprint = hashV2ModelSourceFingerprintArtifact({
    source_fingerprint_profile: V2_MODEL_SOURCE_FINGERPRINT_ARTIFACT_PROFILE,
    artifact_id: artifact.id,
    artifact_kind: artifact.artifactKind,
    artifact_format: artifact.artifactFormat,
    archive_digest: artifact.archiveDigest,
    manifest_digest: artifact.manifestDigest,
  })
  const versionCreateDigest = hashV2ModelVersionCreateArtifact({
    model_version_create_profile: V2_MODEL_VERSION_CREATE_ARTIFACT_PROFILE,
    namespace: namespaceId,
    model_id: model.id,
    version_label: request.version_label,
    source_fingerprint: sourceFingerprint,
    base_model_reference: artifact.baseModelReference,
    base_model_revision: artifact.baseModelRevision,
    base_model_binding_status: artifact.baseModelBindingStatus,
  })
  const classification = classifyModelVersionSourceV2(request.source)
  const registrationDigest = hashV2ModelRegistrationPlanArtifact({
    plan_profile: V2_MODEL_REGISTRATION_PLAN_ARTIFACT_PROFILE,
    namespace: namespaceId,
    normalized_request: request,
    model_id: model.id,
    model_create_digest: model.createDigest,
    source_fingerprint: sourceFingerprint,
    version_create_digest: versionCreateDigest,
    classification,
  })
  const warnings: ModelRegistrationWarningV2[] = []
  if (artifact.datasetLineageStatus !== 'verified') {
    warnings.push({
      code: 'dataset_lineage_unverified',
      path: '/source/artifact_id',
      message: 'The Artifact does not provide verified Dataset training lineage',
    })
  }
  appendDeploymentDeferredWarning(request, warnings)
  return finalizeInspection({
    namespaceId,
    request,
    model,
    planProfile: V2_MODEL_REGISTRATION_PLAN_ARTIFACT_PROFILE,
    versionProfile: V2_MODEL_VERSION_CREATE_ARTIFACT_PROFILE,
    versionCreateDigest,
    sourceFingerprint,
    classification,
    warnings,
    registrationDigest,
    baseModelReference: artifact.baseModelReference,
    baseModelRevision: artifact.baseModelRevision,
    baseModelBindingStatus: artifact.baseModelBindingStatus,
    source: {
      kind: 'databench_artifact',
      artifactId: artifact.id,
      artifactKind: artifact.artifactKind,
      artifactFormat: artifact.artifactFormat,
      archiveDigest: artifact.archiveDigest,
      manifestDigest: artifact.manifestDigest,
    },
  })
}

async function inspectRepositoryRegistration(
  namespaceId: string,
  request: ModelRepositoryRegistrationRequestV2,
  model: InspectedModelTargetV2,
  repositoryRuntime?: V2ModelRepositoryRuntime,
  signal?: AbortSignal,
): Promise<InspectedModelRegistrationV2> {
  const sourceFingerprint = hashV2ModelSourceFingerprintRepository({
    source_fingerprint_profile: V2_MODEL_SOURCE_FINGERPRINT_REPOSITORY_PROFILE,
    provider: request.source.provider,
    repository_id: request.source.repository_id,
    revision: request.source.revision,
    revision_kind: request.source.revision_kind,
  })
  const versionCreateDigest = hashV2ModelVersionCreateRepository({
    model_version_create_profile: V2_MODEL_VERSION_CREATE_REPOSITORY_PROFILE,
    namespace: namespaceId,
    model_id: model.id,
    version_label: request.version_label,
    source_fingerprint: sourceFingerprint,
    base_model_reference: request.source.base_model?.reference ?? null,
    base_model_revision: request.source.base_model?.revision ?? null,
  })
  const versionId = deriveV2ModelVersionIdFromCreateDigest(versionCreateDigest)
  const resolvedEvidence = await repositoryRuntime?.resolve(
    {
      provider: request.source.provider,
      repositoryId: request.source.repository_id,
      revision: request.source.revision,
      revisionKind: request.source.revision_kind,
    },
    signal,
  )
  signal?.throwIfAborted()
  const initialEvidence =
    resolvedEvidence === undefined || resolvedEvidence === null
      ? null
      : modelSourceEvidenceCatalogInput(namespaceId, versionId, resolvedEvidence)
  const classification = classifyModelVersionSourceV2(
    request.source,
    resolvedEvidence === undefined || resolvedEvidence === null ? [] : [resolvedEvidence],
    initialEvidence?.evidenceDigest ?? null,
  )
  const registrationDigest = hashV2ModelRegistrationPlanRepository({
    plan_profile: V2_MODEL_REGISTRATION_PLAN_REPOSITORY_PROFILE,
    namespace: namespaceId,
    normalized_request: request,
    model_id: model.id,
    model_create_digest: model.createDigest,
    source_fingerprint: sourceFingerprint,
    version_create_digest: versionCreateDigest,
    classification,
  })
  const warnings: ModelRegistrationWarningV2[] = [
    {
      code:
        classification.source_mutability === 'mutable'
          ? 'repository_revision_mutable'
          : 'repository_revision_unverified',
      path: '/source/revision',
      message:
        classification.source_mutability === 'mutable'
          ? 'The declared repository revision is mutable'
          : 'The repository revision is declared-only and has not been provider verified',
    },
  ]
  if (request.source.provider === 'hugging_face') {
    warnings.push({
      code: 'repository_provider_not_enabled',
      path: '/source/provider',
      message: 'Hugging Face runtime resolution is not enabled in this implementation step',
    })
  } else if (resolvedEvidence === null || resolvedEvidence === undefined) {
    warnings.push({
      code: 'repository_declared_only',
      path: '/source/revision',
      message:
        'Repository resolution is offline; this reference will be registered as declared-only',
    })
  } else if (resolvedEvidence.result !== 'verified') {
    warnings.push({
      code: `repository_resolution_${resolvedEvidence.result}`,
      path: '/source/revision',
      message:
        'Repository metadata could not verify the declared revision; registration remains allowed',
    })
  }
  appendDeploymentDeferredWarning(request, warnings)
  return finalizeInspection({
    namespaceId,
    request,
    model,
    planProfile: V2_MODEL_REGISTRATION_PLAN_REPOSITORY_PROFILE,
    versionProfile: V2_MODEL_VERSION_CREATE_REPOSITORY_PROFILE,
    versionCreateDigest,
    sourceFingerprint,
    classification,
    warnings,
    registrationDigest,
    baseModelReference: request.source.base_model?.reference ?? null,
    baseModelRevision: request.source.base_model?.revision ?? null,
    baseModelBindingStatus: null,
    source: {
      kind: 'repository_reference',
      provider: request.source.provider,
      repositoryId: request.source.repository_id,
      revision: request.source.revision,
      revisionKind: request.source.revision_kind,
    },
    initialEvidence,
  })
}

function inspectServiceRegistration(
  namespaceId: string,
  request: ModelServiceRegistrationRequestV2,
  model: InspectedModelTargetV2,
): InspectedModelRegistrationV2 {
  const sourceFingerprint = hashV2ModelSourceFingerprintService({
    source_fingerprint_profile: V2_MODEL_SOURCE_FINGERPRINT_SERVICE_PROFILE,
    provider: request.source.provider,
    external_model_ref: request.source.external_model_ref,
    external_version_ref: request.source.external_version_ref,
    declared_reference_kind: request.source.declared_reference_kind,
  })
  const versionCreateDigest = hashV2ModelVersionCreateService({
    model_version_create_profile: V2_MODEL_VERSION_CREATE_SERVICE_PROFILE,
    namespace: namespaceId,
    model_id: model.id,
    version_label: request.version_label,
    source_fingerprint: sourceFingerprint,
    base_model_reference: request.source.base_model?.reference ?? null,
    base_model_revision: request.source.base_model?.revision ?? null,
  })
  const classification = classifyModelVersionSourceV2(request.source)
  const registrationDigest = hashV2ModelRegistrationPlanService({
    plan_profile: V2_MODEL_REGISTRATION_PLAN_SERVICE_PROFILE,
    namespace: namespaceId,
    normalized_request: request,
    model_id: model.id,
    model_create_digest: model.createDigest,
    source_fingerprint: sourceFingerprint,
    version_create_digest: versionCreateDigest,
    classification,
  })
  return finalizeInspection({
    namespaceId,
    request,
    model,
    planProfile: V2_MODEL_REGISTRATION_PLAN_SERVICE_PROFILE,
    versionProfile: V2_MODEL_VERSION_CREATE_SERVICE_PROFILE,
    versionCreateDigest,
    sourceFingerprint,
    classification,
    warnings: [
      {
        code:
          classification.source_mutability === 'mutable'
            ? 'service_reference_mutable'
            : 'service_reference_unverified',
        path: '/source/external_version_ref',
        message:
          classification.source_mutability === 'mutable'
            ? 'The declared service version reference is mutable'
            : 'The service version reference is operator-attested and not content verified',
      },
      {
        code: 'model_deployment_deferred',
        path: '/source/deployment',
        message: 'Version-bound Model Deployment creation is deferred to its implementation step',
      },
    ],
    registrationDigest,
    baseModelReference: request.source.base_model?.reference ?? null,
    baseModelRevision: request.source.base_model?.revision ?? null,
    baseModelBindingStatus: null,
    source: {
      kind: 'existing_service',
      provider: request.source.provider,
      externalModelRef: request.source.external_model_ref,
      externalVersionRef: request.source.external_version_ref,
      declaredReferenceKind: request.source.declared_reference_kind,
    },
  })
}

function finalizeInspection(input: {
  readonly namespaceId: string
  readonly request: ModelRegistrationInspectRequestV2
  readonly model: InspectedModelTargetV2
  readonly planProfile: CreateModelRegistrationV2['planProfile']
  readonly versionProfile: CreateModelRegistrationV2['version']['createProfile']
  readonly versionCreateDigest: string
  readonly sourceFingerprint: string
  readonly classification: ModelRegistrationPlanV2['classification']
  readonly warnings: readonly ModelRegistrationWarningV2[]
  readonly registrationDigest: string
  readonly baseModelReference: string | null
  readonly baseModelRevision: string | null
  readonly baseModelBindingStatus: CreateModelRegistrationV2['version']['baseModelBindingStatus']
  readonly source: CatalogModelVersionSourceV2
  readonly initialEvidence?: CreateModelRegistrationV2['initialEvidence']
}): InspectedModelRegistrationV2 {
  const versionId = deriveV2ModelVersionIdFromCreateDigest(input.versionCreateDigest)
  const plan = ModelRegistrationPlanV2Schema.parse({
    plan_profile: input.planProfile,
    normalized_request: input.request,
    model_id: input.model.id,
    model_create_digest: input.model.createDigest,
    source_fingerprint: input.sourceFingerprint,
    version_create_digest: input.versionCreateDigest,
    classification: input.classification,
    warnings: input.warnings,
    registration_digest: input.registrationDigest,
  })
  return Object.freeze({
    plan: Object.freeze(plan),
    catalogInput: {
      namespaceId: input.namespaceId,
      registrationDigest: input.registrationDigest,
      planProfile: input.planProfile,
      normalizedRequest: catalogJsonObject(input.request),
      target: input.model.catalogTarget,
      version: {
        id: versionId,
        namespaceId: input.namespaceId,
        modelId: input.model.id,
        versionLabel: input.request.version_label,
        sourceKind: input.request.source.kind,
        createProfile: input.versionProfile,
        createDigest: input.versionCreateDigest,
        sourceFingerprint: input.sourceFingerprint,
        baseModelReference: input.baseModelReference,
        baseModelRevision: input.baseModelRevision,
        baseModelBindingStatus: input.baseModelBindingStatus,
      },
      source: input.source,
      initialEvidence: input.initialEvidence ?? null,
      alias:
        input.request.alias === undefined
          ? null
          : {
              alias: input.request.alias.alias,
              expectedVersionId: input.request.alias.expected_version_id,
            },
    },
  })
}

function modelSourceEvidenceCatalogInput(
  namespaceId: string,
  modelVersionId: string,
  observation: import('@databench/schema').ModelSourceEvidenceV2,
): NonNullable<CreateModelRegistrationV2['initialEvidence']> {
  const evidenceDigest = hashV2ModelSourceEvidence({
    evidence_profile: V2_MODEL_SOURCE_EVIDENCE_PROFILE,
    namespace: namespaceId,
    model_version_id: modelVersionId,
    evidence_kind: observation.evidence_kind,
    adapter: observation.adapter,
    adapter_version: observation.adapter_version,
    observed_revision: observation.observed_revision,
    result: observation.result,
    response_digest: observation.response_digest,
    license: observation.license,
    cache_status: observation.cache_status,
  })
  return {
    id: deriveV2ModelSourceEvidenceIdFromDigest(evidenceDigest),
    namespaceId,
    modelVersionId,
    evidenceProfile: V2_MODEL_SOURCE_EVIDENCE_PROFILE,
    evidenceDigest,
    evidenceKind: observation.evidence_kind,
    adapter: observation.adapter,
    adapterVersion: observation.adapter_version,
    observedRevision: observation.observed_revision,
    observedAt: new Date(observation.observed_at),
    result: observation.result,
    responseDigest: observation.response_digest,
    license: observation.license,
    cacheStatus: observation.cache_status,
  }
}

function planProfileForSource(
  kind: ModelRegistrationInspectRequestV2['source']['kind'],
): CreateModelRegistrationV2['planProfile'] {
  return kind === 'databench_artifact'
    ? V2_MODEL_REGISTRATION_PLAN_ARTIFACT_PROFILE
    : kind === 'repository_reference'
      ? V2_MODEL_REGISTRATION_PLAN_REPOSITORY_PROFILE
      : V2_MODEL_REGISTRATION_PLAN_SERVICE_PROFILE
}

function registrationResult(
  result: CatalogModelRegistrationResultV2,
): ModelRegistrationCommitResultV2 {
  return ModelRegistrationCommitResultV2Schema.parse({
    registration_digest: result.claim.registrationDigest,
    model_id: result.model.id,
    model_version_id: result.version.id,
    source_fingerprint: result.version.sourceFingerprint,
    alias: result.alias?.alias ?? null,
    replayed: result.replayed,
  })
}

function appendDeploymentDeferredWarning(
  request: ModelArtifactRegistrationRequestV2 | ModelRepositoryRegistrationRequestV2,
  warnings: ModelRegistrationWarningV2[],
): void {
  if (request.source.deployment === undefined) return
  warnings.push({
    code: 'model_deployment_deferred',
    path: '/source/deployment',
    message: 'Version-bound Model Deployment creation is deferred to its implementation step',
  })
}

function catalogJsonObject(value: object): { readonly [key: string]: CatalogJsonValueV2 } {
  return JSON.parse(canonicalJsonV2(value)) as { readonly [key: string]: CatalogJsonValueV2 }
}

function assertArtifactNamespace(artifact: CatalogModelArtifactRowV2, namespaceId: string): void {
  if (artifact.namespaceId !== namespaceId) {
    throw new IntegrityError('Catalog returned a Model Artifact from another namespace', {
      reason: 'model_artifact_namespace_mismatch',
    })
  }
}

function mapModelRegistrationCatalogError(error: unknown, registrationDigest: string): unknown {
  if (error instanceof V2CatalogModelRegistrationConflictError) {
    return new ConflictError('Model registration conflicts with existing immutable state', {
      reason: error.reason,
      registration_digest: error.registrationDigest,
    })
  }
  if (error instanceof V2CatalogModelAliasConflictError) {
    return new ConflictError('Model alias compare-and-set failed', {
      reason: 'alias_conflict',
      model_id: error.modelId,
      alias: error.alias,
      expected_version_id: error.expectedVersionId,
      current_version_id: error.currentVersionId,
      new_version_id: error.newVersionId,
      registration_digest: registrationDigest,
    })
  }
  if (error instanceof V2CatalogInputError) {
    return new ConflictError('Model registration source changed before commit', {
      reason: 'registration_source_conflict',
      registration_digest: registrationDigest,
    })
  }
  if (error instanceof V2CatalogConsistencyError) {
    return new IntegrityError('Stored Model registry state is inconsistent', {
      reason: 'model_registry_catalog_inconsistent',
      registration_digest: registrationDigest,
    })
  }
  return error
}
