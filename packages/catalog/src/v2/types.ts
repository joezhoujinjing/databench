export type CatalogEntityKindV2 = 'record' | 'candidate' | 'signal' | 'preference'

export type CatalogCreationProfileV2 =
  | 'source-root-v1'
  | 'artifact-row-v1'
  | 'direct-root-v1'
  | 'derived-record-v1'
  | 'candidate-v1'
  | 'signal-event-v1'
  | 'preference-event-v1'

export type CatalogJsonValueV2 =
  | null
  | boolean
  | number
  | string
  | readonly CatalogJsonValueV2[]
  | { readonly [key: string]: CatalogJsonValueV2 }

export interface CatalogIdentityClaimInputV2 {
  readonly namespaceId: string
  readonly entityKind: CatalogEntityKindV2
  readonly claimKeyDigest: string
  readonly claimProfile: 'databench-identity-claim-v1'
  readonly requestProfile: 'databench-identity-request-v1'
  readonly creationProfile: CatalogCreationProfileV2
  readonly entityId: string
  readonly requestDigest: string
}

export interface CatalogIdentityClaimRowV2 extends CatalogIdentityClaimInputV2 {
  readonly createdAt: Date
}

export type CatalogIdentityClaimResultV2 =
  | { readonly status: 'created'; readonly row: CatalogIdentityClaimRowV2 }
  | { readonly status: 'existing_claim'; readonly row: CatalogIdentityClaimRowV2 }
  | { readonly status: 'existing_entity'; readonly row: CatalogIdentityClaimRowV2 }

export interface CatalogSnapshotInputV2 {
  readonly version: string
  readonly identityProfile: string
  readonly recordSchemaVersion: string
  readonly numRecords: bigint
}

export interface CatalogSnapshotRowV2 extends CatalogSnapshotInputV2 {
  readonly createdAt: Date
}

export interface CatalogLayoutInputV2 {
  readonly datasetVersion: string
  readonly layoutVersion: string
  readonly artifactDigest: string
  readonly artifactSizeBytes: bigint
  readonly manifestKey: string
  readonly columns: readonly string[]
}

export interface CatalogLayoutRowV2 extends CatalogLayoutInputV2 {
  readonly committedAt: Date
}

export interface CatalogParentRevisionV2 {
  readonly recordId: string
  readonly recordDigest: string
}

export interface CatalogRecordRevisionV2 {
  readonly recordId: string
  readonly recordDigest: string
  readonly parents: readonly CatalogParentRevisionV2[]
}

export interface CatalogRecordParentRowV2 {
  readonly position: number
  readonly parentRecordId: string
  readonly parentRecordDigest: string
}

export interface RegisterLayoutV2 {
  readonly snapshot: CatalogSnapshotInputV2
  readonly layout: CatalogLayoutInputV2
  readonly revisions: readonly CatalogRecordRevisionV2[]
}

export interface CatalogRunInputV2 {
  readonly id: string
  readonly cacheKey: string
  readonly op: string
  readonly opVersion: string
  readonly params: Readonly<Record<string, CatalogJsonValueV2>>
  readonly inputVersions: readonly string[]
  readonly outputVersion: string
}

export interface CatalogRunRowV2 extends CatalogRunInputV2 {
  readonly lineageSequence: bigint
  readonly createdAt: Date
}

export interface CatalogRunPageV2 {
  readonly rows: readonly CatalogRunRowV2[]
  readonly nextCacheKey: string | null
}

export interface RegisterTransformResultV2 extends RegisterLayoutV2 {
  readonly run: CatalogRunInputV2
}

export interface CompleteTransformJobV2 extends RegisterTransformResultV2 {
  readonly job: TransformJobLeaseV2
  readonly outputCount: bigint
}

export interface ClearCompletedTransformJobStagingV2 {
  readonly id: string
  readonly attempt: number
  readonly outputVersion: string
  readonly inputKey: string
  readonly outputKey: string
}

export interface CompareAndSetRefV2 {
  readonly namespaceId: string
  readonly name: string
  readonly newVersion: string
  readonly expectedVersion: string | null
  readonly message: string | null
}

export interface DeleteRefV2 {
  readonly namespaceId: string
  readonly name: string
  readonly expectedVersion: string
}

export type DeleteRefResultV2 =
  | { readonly status: 'deleted' | 'already_deleted'; readonly row: CatalogRefRowV2 }
  | { readonly status: 'missing' }

export interface RestoreRefV2 {
  readonly namespaceId: string
  readonly name: string
  readonly expectedVersion: string
}

export type RestoreRefResultV2 =
  | { readonly status: 'restored' | 'already_active'; readonly row: CatalogRefRowV2 }
  | { readonly status: 'missing' }

export interface CatalogRefRowV2 {
  readonly namespaceId: string
  readonly name: string
  readonly version: string
  readonly numRecords: bigint
  readonly message: string | null
  readonly updatedAt: Date
  readonly deletedAt: Date | null
}

export interface CatalogRefPageV2 {
  readonly rows: readonly CatalogRefRowV2[]
  readonly nextName: string | null
}

export type CatalogTransformJobStatusV2 =
  | 'queued'
  | 'leased'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface CatalogTransformJobProgressV2 {
  readonly phase: string
  readonly completedUnits: bigint
  readonly totalUnits: bigint | null
}

export interface CatalogTransformJobErrorV2 {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export type CatalogTransformJobResultRefStatusV2 = 'pending' | 'updated' | 'conflict'

export interface CatalogTransformJobResultRefV2 {
  readonly namespaceId: string
  readonly name: string
  readonly status: CatalogTransformJobResultRefStatusV2
  readonly version: string | null
}

export interface CreateTransformJobV2 {
  readonly id: string
  readonly cacheKey: string
  readonly op: string
  readonly opVersion: string
  readonly params: Readonly<Record<string, CatalogJsonValueV2>>
  readonly inputVersion: string
  readonly capabilityName: string
  readonly capabilityVersion: string
  readonly inputCount: bigint
  readonly resultRefNamespaceId: string | null
  readonly resultRefName: string | null
}

export interface CatalogTransformJobRowV2 extends CreateTransformJobV2 {
  readonly status: CatalogTransformJobStatusV2
  readonly attempt: number
  readonly leaseOwner: string | null
  readonly leaseToken: Uint8Array | null
  readonly leaseExpiresAt: Date | null
  readonly progress: CatalogTransformJobProgressV2 | null
  readonly inputKey: string | null
  readonly outputKey: string | null
  readonly outputCount: bigint | null
  readonly outputVersion: string | null
  readonly resultRef: CatalogTransformJobResultRefV2 | null
  readonly cacheHit: boolean
  readonly error: CatalogTransformJobErrorV2 | null
  readonly createdAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  readonly updatedAt: Date
}

export interface CatalogTransformJobCursorV2 {
  readonly createdAt: Date
  readonly id: string
}

export interface CatalogTransformJobPageV2 {
  readonly rows: readonly CatalogTransformJobRowV2[]
  readonly nextCursor: CatalogTransformJobCursorV2 | null
}

export interface ClaimTransformJobV2 {
  readonly leaseOwner: string
  readonly leaseDurationMs: number
}

export interface TransformJobLeaseV2 {
  readonly id: string
  readonly attempt: number
  readonly leaseToken: Uint8Array
}

export interface UpdateTransformJobProgressV2 extends TransformJobLeaseV2 {
  readonly progress: CatalogTransformJobProgressV2
}

export interface SetTransformJobStagingKeysV2 extends TransformJobLeaseV2 {
  readonly inputKey: string
  readonly outputKey: string
}

export interface FailTransformJobV2 extends TransformJobLeaseV2 {
  readonly error: CatalogTransformJobErrorV2
}

export type CatalogEvaluationRunStatusV2 =
  | 'prepared'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type CatalogEvaluationArchiveStatusV2 =
  | 'not_requested'
  | 'pending'
  | 'uploading'
  | 'available'
  | 'failed'

export interface CatalogEvaluationMetricV2 {
  readonly dataset: string
  readonly subset: string | null
  readonly metricId: string | null
  readonly outputKey: string | null
  readonly metric: string
  readonly score: number | null
  readonly sampleCount: number | null
  readonly categories: readonly string[]
}

export interface CatalogEvaluationRunErrorV2 {
  readonly phase: string
  readonly code: string
  readonly message: string
}

export interface CreateEvaluationRunV2 {
  readonly namespaceId: string
  readonly provider: 'evalscope'
  readonly providerTaskId: string
  readonly createProfile:
    | 'evaluation-run-create-v1'
    | 'evaluation-run-create-v2'
    | 'evaluation-run-create-v3'
    | 'evaluation-run-create-v4'
  readonly createRequestDigest: string
  readonly datasetVersion: string
  readonly sourceRef: string | null
  readonly converter: string
  readonly converterVersion: string
  readonly converterOptions: Readonly<Record<string, CatalogJsonValueV2>>
  readonly fidelityDigest: string
  readonly benchmark: string
  readonly modelName: string | null
  readonly modelDeploymentId: string | null
  readonly modelArtifactId: string | null
  readonly modelDeploymentDigest: string | null
  readonly evalscopeCommit: string | null
  readonly scoringConfig: Readonly<Record<string, CatalogJsonValueV2>> | null
  readonly primaryMetricId: string | null
  readonly primaryOutputKey: string | null
}

export interface CatalogEvaluationRunRowV2 extends CreateEvaluationRunV2 {
  readonly id: string
  readonly providerReportIds: readonly string[] | null
  readonly status: CatalogEvaluationRunStatusV2
  readonly metrics: readonly CatalogEvaluationMetricV2[] | null
  readonly error: CatalogEvaluationRunErrorV2 | null
  readonly archiveStatus: CatalogEvaluationArchiveStatusV2
  readonly archiveAttempt: number
  readonly resultArtifactKey: string | null
  readonly resultArtifactDigest: string | null
  readonly resultArtifactSizeBytes: bigint | null
  readonly archiveError: CatalogEvaluationRunErrorV2 | null
  readonly createdAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  readonly updatedAt: Date
}

export interface CatalogEvaluationRunCursorV2 {
  readonly createdAt: Date
  readonly id: string
}

export interface CatalogEvaluationRunPageV2 {
  readonly rows: readonly CatalogEvaluationRunRowV2[]
  readonly nextCursor: CatalogEvaluationRunCursorV2 | null
}

export interface CatalogEvaluationRunListFilterV2 {
  readonly datasetVersion: string | null
  readonly modelDeploymentId: string | null
  readonly status: CatalogEvaluationRunStatusV2 | null
}

export type TransitionEvaluationRunV2 =
  | {
      readonly namespaceId: string
      readonly id: string
      readonly status: 'running'
    }
  | {
      readonly namespaceId: string
      readonly id: string
      readonly status: 'completed'
      readonly metrics: readonly CatalogEvaluationMetricV2[]
      readonly providerReportIds: readonly string[]
    }
  | {
      readonly namespaceId: string
      readonly id: string
      readonly status: 'failed' | 'cancelled'
      readonly error: CatalogEvaluationRunErrorV2
    }

export type CatalogSwiftStudioSessionStatusV2 =
  | 'preparing'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'failed'

export interface CatalogSwiftStudioSessionFailureV2 {
  readonly phase: string
  readonly code: string
  readonly message: string
}

export interface CreateSwiftStudioSessionV2 {
  readonly namespaceId: string
  readonly createDigest: string
  readonly datasetVersion: string
  readonly displayRef: string | null
  readonly converter: 'ms-swift'
  readonly converterVersion: '1.0.0'
  readonly normalizedOptions: Readonly<Record<string, CatalogJsonValueV2>>
  readonly fidelityDigest: string
  readonly exportOutputCount: bigint
  readonly provider: 'swift-studio'
  readonly providerSessionId: string
  readonly upstreamCommit: string
  readonly imageDigest: string
  readonly runtimeCapabilityDigest: string
}

export interface CatalogSwiftStudioSessionRowV2 extends CreateSwiftStudioSessionV2 {
  readonly id: string
  readonly status: CatalogSwiftStudioSessionStatusV2
  readonly exportDigest: string | null
  readonly exportSizeBytes: bigint | null
  readonly failure: CatalogSwiftStudioSessionFailureV2 | null
  readonly preparationOwnerToken: string
  readonly preparationAbandonedAt: Date | null
  readonly preparationExpiresAt: Date
  readonly createdAt: Date
  readonly readyAt: Date | null
  readonly closedAt: Date | null
  readonly updatedAt: Date
}

export interface CatalogSwiftStudioSessionCreateResultV2 {
  readonly row: CatalogSwiftStudioSessionRowV2
  readonly created: boolean
}

export interface CatalogSwiftStudioSessionPreparationClaimResultV2 {
  readonly row: CatalogSwiftStudioSessionRowV2 | null
  readonly claimed: boolean
}

export interface CatalogSwiftStudioSessionCursorV2 {
  readonly createdAt: Date
  readonly id: string
}

export interface CatalogSwiftStudioSessionPageV2 {
  readonly rows: readonly CatalogSwiftStudioSessionRowV2[]
  readonly nextCursor: CatalogSwiftStudioSessionCursorV2 | null
}

export interface CatalogSwiftStudioSessionListFilterV2 {
  readonly datasetVersion: string | null
  readonly status: CatalogSwiftStudioSessionStatusV2 | null
}

export type TransitionSwiftStudioSessionV2 =
  | {
      readonly namespaceId: string
      readonly id: string
      readonly preparationOwnerToken: string
      readonly status: 'ready'
      readonly exportDigest: string
      readonly exportSizeBytes: bigint
    }
  | {
      readonly namespaceId: string
      readonly id: string
      readonly status: 'closing' | 'closed'
    }
  | {
      readonly namespaceId: string
      readonly id: string
      readonly preparationOwnerToken: string
      readonly status: 'failed'
      readonly failure: CatalogSwiftStudioSessionFailureV2
    }

export type CatalogModelArtifactKindV2 = 'lora_adapter'
export type CatalogModelArtifactFormatV2 = 'swift-lora-adapter-v1'
export type CatalogModelArtifactArchiveFormatV2 = 'deterministic-tar-zst-v1'
export type CatalogModelArtifactDatasetLineageStatusV2 =
  | 'verified'
  | 'external_or_unverified'
  | 'not_applicable'
export type CatalogModelArtifactBaseModelBindingStatusV2 = 'verified' | 'declared' | 'unresolved'
export type CatalogModelArtifactImportStatusV2 =
  | 'requested'
  | 'staging'
  | 'finalizing'
  | 'completed'
  | 'failed'

export interface CatalogModelArtifactImportFailureV2 {
  readonly phase: string
  readonly code: string
  readonly message: string
}

export interface CatalogModelArtifactManifestFileV2 {
  readonly path: string
  readonly digest: string
  readonly size_bytes: number
}

export interface CatalogModelArtifactDatasetLineageV2 {
  readonly status: CatalogModelArtifactDatasetLineageStatusV2
  readonly dataset_version: string | null
  readonly dataset_export_digest: string | null
}

export interface CatalogModelArtifactBaseModelV2 {
  readonly reference: string
  readonly revision: string | null
  readonly binding_status: CatalogModelArtifactBaseModelBindingStatusV2
}

export interface CatalogModelArtifactTrainingSummaryV2 {
  readonly train_stage: string | null
  readonly tuner_type: 'lora'
  readonly lora_rank: number | null
  readonly lora_alpha: number | null
  readonly lora_dropout: number | null
  readonly num_train_epochs: number | null
  readonly max_steps: number | null
  readonly learning_rate: number | null
  readonly max_length: number | null
  readonly dtype: string | null
  readonly seed: number | null
  readonly redacted_fields_count: number
}

export interface CatalogModelArtifactManifestV2 {
  readonly manifest_version: 'model-artifact-manifest-v1'
  readonly artifact_kind: CatalogModelArtifactKindV2
  readonly artifact_format: CatalogModelArtifactFormatV2
  readonly archive_format: CatalogModelArtifactArchiveFormatV2
  readonly archive_digest: string
  readonly archive_size_bytes: number
  readonly output_snapshot_digest: string
  readonly files: readonly CatalogModelArtifactManifestFileV2[]
  readonly source: {
    readonly studio_session_id: string
    readonly upstream_commit: string
    readonly image_digest: string
  }
  readonly dataset_lineage: CatalogModelArtifactDatasetLineageV2
  readonly base_model: CatalogModelArtifactBaseModelV2
  readonly training_summary: CatalogModelArtifactTrainingSummaryV2
  readonly created_at: string
  readonly created_by: 'databench'
}

export interface CreateModelArtifactImportV2 {
  readonly namespaceId: string
  readonly createDigest: string
  readonly studioSessionId: string
  readonly outputHandleDigest: string
  readonly artifactKind: CatalogModelArtifactKindV2
  readonly displayName: string
  readonly baseModelReference: string
  readonly baseModelRevision: string | null
}

export interface CatalogModelArtifactImportRowV2 extends CreateModelArtifactImportV2 {
  readonly id: string
  readonly status: CatalogModelArtifactImportStatusV2
  readonly providerImportId: string | null
  readonly outputSnapshotDigest: string | null
  readonly stagingObjectKey: string | null
  readonly archiveDigest: string | null
  readonly archiveSizeBytes: bigint | null
  readonly manifestDigest: string | null
  readonly manifest: CatalogModelArtifactManifestV2 | null
  readonly datasetLineageStatus: CatalogModelArtifactDatasetLineageStatusV2 | null
  readonly datasetVersion: string | null
  readonly datasetExportDigest: string | null
  readonly baseModelBindingStatus: CatalogModelArtifactBaseModelBindingStatusV2 | null
  readonly artifactId: string | null
  readonly failure: CatalogModelArtifactImportFailureV2 | null
  readonly createdAt: Date
  readonly stagingAt: Date | null
  readonly finalizingAt: Date | null
  readonly completedAt: Date | null
  readonly failedAt: Date | null
  readonly stagingCleanedAt: Date | null
  readonly updatedAt: Date
}

export interface CatalogModelArtifactImportCreateResultV2 {
  readonly row: CatalogModelArtifactImportRowV2
  readonly created: boolean
}

export type TransitionModelArtifactImportV2 =
  | {
      readonly namespaceId: string
      readonly id: string
      readonly status: 'staging'
      readonly providerImportId: string
      readonly outputSnapshotDigest: string
    }
  | {
      readonly namespaceId: string
      readonly id: string
      readonly status: 'finalizing'
      readonly stagingObjectKey: string
      readonly archiveDigest: string
      readonly archiveSizeBytes: bigint
      readonly manifestDigest: string
      readonly manifest: CatalogModelArtifactManifestV2
      readonly datasetLineageStatus: CatalogModelArtifactDatasetLineageStatusV2
      readonly datasetVersion: string | null
      readonly datasetExportDigest: string | null
      readonly baseModelBindingStatus: CatalogModelArtifactBaseModelBindingStatusV2
    }
  | {
      readonly namespaceId: string
      readonly id: string
      readonly status: 'failed'
      readonly failure: CatalogModelArtifactImportFailureV2
    }

export interface FinalizeModelArtifactImportV2 {
  readonly namespaceId: string
  readonly id: string
  readonly objectLocator: string
}

export interface CatalogModelArtifactRowV2 {
  readonly id: string
  readonly namespaceId: string
  readonly displayName: string
  readonly artifactKind: CatalogModelArtifactKindV2
  readonly artifactFormat: CatalogModelArtifactFormatV2
  readonly archiveFormat: CatalogModelArtifactArchiveFormatV2
  readonly archiveDigest: string
  readonly archiveSizeBytes: bigint
  readonly objectLocator: string
  readonly manifestDigest: string
  readonly manifest: CatalogModelArtifactManifestV2
  readonly sourceKind: 'swift_studio_session'
  readonly sourceSessionId: string
  readonly sourceImportId: string
  readonly datasetLineageStatus: CatalogModelArtifactDatasetLineageStatusV2
  readonly datasetVersion: string | null
  readonly datasetExportDigest: string | null
  readonly baseModelReference: string
  readonly baseModelRevision: string | null
  readonly baseModelBindingStatus: CatalogModelArtifactBaseModelBindingStatusV2
  readonly upstreamCommit: string
  readonly imageDigest: string
  readonly createdAt: Date
}

export interface CatalogModelArtifactFinalizeResultV2 {
  readonly artifactImport: CatalogModelArtifactImportRowV2
  readonly artifact: CatalogModelArtifactRowV2
}

export interface CatalogModelArtifactCursorV2 {
  readonly createdAt: Date
  readonly id: string
}

export interface CatalogModelArtifactPageV2 {
  readonly rows: readonly CatalogModelArtifactRowV2[]
  readonly nextCursor: CatalogModelArtifactCursorV2 | null
}

export interface CatalogModelArtifactListFilterV2 {
  readonly datasetVersion: string | null
  readonly artifactKind: CatalogModelArtifactKindV2 | null
}

export type CatalogModelDeploymentProviderV2 = 'openai_compatible'
export type CatalogModelDeploymentAuthModeV2 = 'none'
export type CatalogModelDeploymentStatusV2 = 'active' | 'disabled'
export type CatalogModelDeploymentHealthStatusV2 = 'unknown' | 'healthy' | 'unhealthy'

export interface CreateModelDeploymentV2 {
  readonly namespaceId: string
  readonly createDigest: string
  readonly artifactId: string
  readonly provider: CatalogModelDeploymentProviderV2
  readonly displayName: string
  readonly servedModelName: string
  readonly endpointBaseUrl: string
  readonly authMode: CatalogModelDeploymentAuthModeV2
}

export interface CatalogModelDeploymentRowV2 extends CreateModelDeploymentV2 {
  readonly id: string
  readonly status: CatalogModelDeploymentStatusV2
  readonly healthStatus: CatalogModelDeploymentHealthStatusV2
  readonly healthCheckedAt: Date | null
  readonly healthError: string | null
  readonly createdAt: Date
  readonly disabledAt: Date | null
  readonly updatedAt: Date
}

export interface CatalogModelDeploymentCursorV2 {
  readonly createdAt: Date
  readonly id: string
}

export interface CatalogModelDeploymentListFilterV2 {
  readonly artifactId: string | null
  readonly status: CatalogModelDeploymentStatusV2 | null
}

export interface CatalogModelDeploymentPageV2 {
  readonly rows: readonly CatalogModelDeploymentRowV2[]
  readonly nextCursor: CatalogModelDeploymentCursorV2 | null
}

export interface CatalogModelDeploymentHealthV2 {
  readonly status: Exclude<CatalogModelDeploymentHealthStatusV2, 'unknown'>
  readonly error: string | null
}

export interface PrepareEvaluationRunArchiveV2 {
  readonly namespaceId: string
  readonly id: string
}

export interface MarkEvaluationRunArchiveUploadingV2 extends PrepareEvaluationRunArchiveV2 {
  readonly archiveAttempt: number
}

export interface FinalizeEvaluationRunArchiveV2 extends MarkEvaluationRunArchiveUploadingV2 {
  readonly resultArtifactKey: string
  readonly resultArtifactDigest: string
  readonly resultArtifactSizeBytes: bigint
}

export interface FailEvaluationRunArchiveV2 extends MarkEvaluationRunArchiveUploadingV2 {
  readonly error: CatalogEvaluationRunErrorV2
}
