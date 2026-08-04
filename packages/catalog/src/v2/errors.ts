export type V2CatalogImmutableKind = 'snapshot' | 'layout' | 'record_parents'

export class V2CatalogInputError extends Error {
  override readonly name = 'V2CatalogInputError'
}

export class V2CatalogConsistencyError extends Error {
  override readonly name = 'V2CatalogConsistencyError'

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options)
  }
}

export class V2CatalogImmutableConflictError extends Error {
  override readonly name = 'V2CatalogImmutableConflictError'
  readonly kind: V2CatalogImmutableKind
  readonly key: string

  constructor(kind: V2CatalogImmutableKind, key: string) {
    super(`Immutable V2 catalog ${kind} metadata conflicts for ${key}`)
    this.kind = kind
    this.key = key
  }
}

export class V2CatalogDeterminismConflictError extends Error {
  override readonly name = 'V2CatalogDeterminismConflictError'
  readonly cacheKey: string

  constructor(cacheKey: string) {
    super(`Immutable V2 run metadata conflicts for cache key ${cacheKey}`)
    this.cacheKey = cacheKey
  }
}

export class V2CatalogTransformJobLeaseError extends Error {
  override readonly name = 'V2CatalogTransformJobLeaseError'

  constructor(readonly jobId: string) {
    super(`Transform job is not owned by the current finalizing lease: ${jobId}`)
  }
}

export class V2CatalogLineageCycleError extends Error {
  override readonly name = 'V2CatalogLineageCycleError'
  readonly recordId: string
  readonly recordDigest: string

  constructor(recordId: string, recordDigest: string) {
    super(`V2 record lineage would form a cycle at ${recordId}`)
    this.recordId = recordId
    this.recordDigest = recordDigest
  }
}

export class V2CatalogRefConflictError extends Error {
  override readonly name = 'V2CatalogRefConflictError'
  readonly namespaceId: string
  readonly refName: string
  readonly expectedVersion: string | null
  readonly currentVersion: string | null
  readonly newVersion: string

  constructor(input: {
    readonly namespaceId: string
    readonly refName: string
    readonly expectedVersion: string | null
    readonly currentVersion: string | null
    readonly newVersion: string
  }) {
    super(`V2 ref compare-and-set conflict for ${input.refName}`)
    this.namespaceId = input.namespaceId
    this.refName = input.refName
    this.expectedVersion = input.expectedVersion
    this.currentVersion = input.currentVersion
    this.newVersion = input.newVersion
  }
}

export class V2CatalogRefStateConflictError extends Error {
  override readonly name = 'V2CatalogRefStateConflictError'
  readonly namespaceId: string
  readonly refName: string
  readonly expectedVersion: string
  readonly currentVersion: string
  readonly currentState: 'active' | 'deleted'
  readonly operation: 'delete' | 'restore'

  constructor(input: {
    readonly namespaceId: string
    readonly refName: string
    readonly expectedVersion: string
    readonly currentVersion: string
    readonly currentState: 'active' | 'deleted'
    readonly operation: 'delete' | 'restore'
  }) {
    super(`V2 ref ${input.operation} compare-and-set conflict for ${input.refName}`)
    this.namespaceId = input.namespaceId
    this.refName = input.refName
    this.expectedVersion = input.expectedVersion
    this.currentVersion = input.currentVersion
    this.currentState = input.currentState
    this.operation = input.operation
  }
}

export class V2CatalogTargetNotCommittedError extends Error {
  override readonly name = 'V2CatalogTargetNotCommittedError'
  readonly version: string

  constructor(version: string) {
    super(`V2 ref target has no committed catalog layout: ${version}`)
    this.version = version
  }
}

export type V2CatalogSwiftStudioSessionConflictReason =
  | 'active_session_exists'
  | 'create_request_mismatch'
  | 'invalid_transition'
  | 'terminal_body_mismatch'

export class V2CatalogSwiftStudioSessionConflictError extends Error {
  override readonly name = 'V2CatalogSwiftStudioSessionConflictError'

  constructor(
    readonly reason: V2CatalogSwiftStudioSessionConflictReason,
    readonly sessionId: string,
    readonly status: 'preparing' | 'ready' | 'closing' | 'closed' | 'failed',
    readonly requestedStatus: 'ready' | 'closing' | 'closed' | 'failed' | null,
  ) {
    super(`Swift Studio Session conflict (${reason}) for ${sessionId}`)
  }
}

export type V2CatalogModelArtifactImportConflictReason =
  | 'create_request_mismatch'
  | 'output_already_imported'
  | 'invalid_transition'
  | 'terminal_body_mismatch'
  | 'archive_identity_mismatch'

export class V2CatalogModelArtifactImportConflictError extends Error {
  override readonly name = 'V2CatalogModelArtifactImportConflictError'

  constructor(
    readonly reason: V2CatalogModelArtifactImportConflictReason,
    readonly importId: string,
    readonly status: 'requested' | 'staging' | 'finalizing' | 'completed' | 'failed',
    readonly requestedStatus: 'staging' | 'finalizing' | 'completed' | 'failed' | null,
  ) {
    super(`Model Artifact import conflict (${reason}) for ${importId}`)
  }
}

export class V2CatalogModelDeploymentAdmissionError extends Error {
  override readonly name = 'V2CatalogModelDeploymentAdmissionError'

  constructor(
    readonly reason: 'disabled',
    readonly deploymentId: string,
  ) {
    super(`Model Deployment admission rejected (${reason}) for ${deploymentId}`)
  }
}

export type V2CatalogModelRegistrationConflictReason =
  | 'request_mismatch'
  | 'model_key_conflict'
  | 'model_target_not_found'
  | 'version_label_conflict'
  | 'source_fingerprint_conflict'
  | 'alias_conflict'

export class V2CatalogModelRegistrationConflictError extends Error {
  override readonly name = 'V2CatalogModelRegistrationConflictError'

  constructor(
    readonly reason: V2CatalogModelRegistrationConflictReason,
    readonly registrationDigest: string,
  ) {
    super(`Model registration conflict (${reason}) for ${registrationDigest}`)
  }
}

export class V2CatalogModelMetadataConflictError extends Error {
  override readonly name = 'V2CatalogModelMetadataConflictError'

  constructor(
    readonly modelId: string,
    readonly expectedMetadataRevision: bigint,
    readonly currentMetadataRevision: bigint,
  ) {
    super(`Model metadata compare-and-set conflict for ${modelId}`)
  }
}

export class V2CatalogModelAliasConflictError extends Error {
  override readonly name = 'V2CatalogModelAliasConflictError'

  constructor(
    readonly modelId: string,
    readonly alias: 'candidate' | 'staging' | 'production',
    readonly expectedVersionId: string | null,
    readonly currentVersionId: string | null,
    readonly newVersionId: string,
  ) {
    super(`Model alias compare-and-set conflict for ${modelId}/${alias}`)
  }
}

export class V2CatalogModelDeploymentAdoptionConflictError extends Error {
  override readonly name = 'V2CatalogModelDeploymentAdoptionConflictError'

  constructor(
    readonly deploymentId: string,
    readonly currentModelVersionId: string,
    readonly requestedModelVersionId: string,
  ) {
    super(`Model Deployment adoption conflict for ${deploymentId}`)
  }
}
