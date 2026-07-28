export type CanonicalJsonPrimitive = null | boolean | string | number

export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject

export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue
}

export const V2_IDENTITY_PROFILE = 'databench-v2-jcs-1' as const
export const V2_RECORD_SCHEMA_VERSION = '2.0.0' as const
export const V2_EXPORT_FIDELITY_PROFILE = 'databench-export-fidelity-1' as const
export const V2_IDENTITY_CLAIM_PROFILE = 'databench-identity-claim-v1' as const
export const V2_IDENTITY_REQUEST_PROFILE = 'databench-identity-request-v1' as const

export type V2EntityKind = 'record' | 'candidate' | 'signal' | 'preference'

export type V2CreationProfile =
  | 'source-root-v1'
  | 'artifact-row-v1'
  | 'direct-root-v1'
  | 'derived-record-v1'
  | 'candidate-v1'
  | 'signal-event-v1'
  | 'preference-event-v1'

export interface SourceRootSeedV1 {
  readonly namespace: string
  readonly source: {
    readonly name: string
    readonly kind: string
    readonly original_id: string
  }
}

export interface ArtifactRowSeedV1 {
  readonly namespace: string
  readonly source_artifact_digest: string
  readonly row_index: number
}

export interface DirectRootSeedV1 {
  readonly namespace: string
  readonly idempotency_key_or_random_seed: string
}

export interface DerivedRecordSeedV1 {
  readonly op: string
  readonly op_version: string
  readonly params: CanonicalJsonObject
  readonly parent_ids: readonly string[]
  readonly output_index: number
}

export interface CandidateSeedV1 {
  readonly record_id: string
  readonly generation_run_id: string
  readonly output_index: number
}

export interface EventSeedV1 {
  readonly owner_id: string
  readonly producer: string
  readonly producer_event_key: string
}

export type RecordSeedV1 =
  | SourceRootSeedV1
  | ArtifactRowSeedV1
  | DirectRootSeedV1
  | DerivedRecordSeedV1

export type IdentityClaimMaterialV1 = RecordSeedV1 | CandidateSeedV1 | EventSeedV1

interface IdentityClaimHashInputBaseV1<
  EntityKind extends V2EntityKind,
  CreationProfile extends V2CreationProfile,
  ClaimMaterial extends IdentityClaimMaterialV1,
> {
  readonly claim_profile: typeof V2_IDENTITY_CLAIM_PROFILE
  readonly identity_profile: typeof V2_IDENTITY_PROFILE
  readonly namespace: string
  readonly entity_kind: EntityKind
  readonly creation_profile: CreationProfile
  readonly claim_material: ClaimMaterial
}

export type IdentityClaimHashInputV1 =
  | IdentityClaimHashInputBaseV1<'record', 'source-root-v1', SourceRootSeedV1>
  | IdentityClaimHashInputBaseV1<'record', 'artifact-row-v1', ArtifactRowSeedV1>
  | IdentityClaimHashInputBaseV1<'record', 'direct-root-v1', DirectRootSeedV1>
  | IdentityClaimHashInputBaseV1<'record', 'derived-record-v1', DerivedRecordSeedV1>
  | IdentityClaimHashInputBaseV1<'candidate', 'candidate-v1', CandidateSeedV1>
  | IdentityClaimHashInputBaseV1<'signal', 'signal-event-v1', EventSeedV1>
  | IdentityClaimHashInputBaseV1<'preference', 'preference-event-v1', EventSeedV1>

interface IdentityRequestHashInputBaseV1<
  EntityKind extends V2EntityKind,
  CreationProfile extends V2CreationProfile,
> {
  readonly request_profile: typeof V2_IDENTITY_REQUEST_PROFILE
  readonly identity_profile: typeof V2_IDENTITY_PROFILE
  readonly namespace: string
  readonly entity_kind: EntityKind
  readonly creation_profile: CreationProfile
  readonly normalized_request: CanonicalJsonValue
}

export type IdentityRequestHashInputV1 =
  | IdentityRequestHashInputBaseV1<'record', 'source-root-v1'>
  | IdentityRequestHashInputBaseV1<'record', 'artifact-row-v1'>
  | IdentityRequestHashInputBaseV1<'record', 'direct-root-v1'>
  | IdentityRequestHashInputBaseV1<'record', 'derived-record-v1'>
  | IdentityRequestHashInputBaseV1<'candidate', 'candidate-v1'>
  | IdentityRequestHashInputBaseV1<'signal', 'signal-event-v1'>
  | IdentityRequestHashInputBaseV1<'preference', 'preference-event-v1'>

export interface DatasetIdentityEnvelopeV2 {
  readonly identity_profile: typeof V2_IDENTITY_PROFILE
  readonly record_schema_version: typeof V2_RECORD_SCHEMA_VERSION
  readonly record_digests: readonly string[]
}

export interface TransformCacheIdentityV1 {
  readonly identity_profile: typeof V2_IDENTITY_PROFILE
  readonly op: string
  readonly op_version: string
  readonly input_dataset_versions: readonly string[]
  readonly params: CanonicalJsonObject
}

export const V2_EVALUATION_RUN_CREATE_PROFILE = 'evaluation-run-create-v1' as const

export interface EvaluationRunCreateIdentityV1 {
  readonly evaluation_run_create_profile: typeof V2_EVALUATION_RUN_CREATE_PROFILE
  readonly provider: 'evalscope'
  readonly provider_task_id: string
  readonly dataset_version: string
  readonly source_ref: string | null
  readonly converter: V2ConverterName
  readonly converter_version: string
  readonly normalized_options: CanonicalJsonObject
  readonly fidelity_digest: string
  readonly benchmark: string
  readonly model_name: string | null
  readonly evalscope_commit: string | null
}

export const V2_SWIFT_STUDIO_SESSION_CREATE_PROFILE = 'swift-studio-session-create-v1' as const

export interface SwiftStudioSessionCreateIdentityV1 {
  readonly swift_studio_session_create_profile: typeof V2_SWIFT_STUDIO_SESSION_CREATE_PROFILE
  readonly namespace: string
  readonly dataset_version: string
  readonly converter: 'ms-swift'
  readonly converter_version: string
  readonly normalized_options: CanonicalJsonObject
  readonly fidelity_digest: string
  readonly output_count: number
  readonly provider: 'swift-studio'
  readonly upstream_commit: string
  readonly image_digest: string
  readonly runtime_capability_digest: string
}

export const V2_MODEL_ARTIFACT_IMPORT_CREATE_PROFILE = 'model-artifact-import-create-v1' as const

export interface ModelArtifactImportCreateIdentityV1 {
  readonly model_artifact_import_create_profile: typeof V2_MODEL_ARTIFACT_IMPORT_CREATE_PROFILE
  readonly namespace: string
  readonly studio_session_id: string
  readonly output_handle_digest: string
  readonly artifact_kind: 'lora_adapter'
  readonly display_name: string
  readonly base_model: {
    readonly reference: string
    readonly revision: string | null
  }
}

export type V2ConverterName =
  | 'canonical-jsonl'
  | 'evalscope-general-qa'
  | 'trl-sft'
  | 'trl-dpo'
  | 'trl-grpo-rlvr'
  | 'ms-swift'

export type V2FidelityAction = 'transformed' | 'dropped'
export type V2FidelityImpact = 'none' | 'informational' | 'semantic'

export interface V2FidelityChange {
  readonly path: string
  readonly action: V2FidelityAction
  readonly impact: V2FidelityImpact
  readonly reason: string
}

export interface V2ExportFidelity {
  readonly preserved: readonly string[]
  readonly changes: readonly V2FidelityChange[]
}

/**
 * The complete approval identity from TECHNICAL-DESIGN §15.3. Display-only
 * fields such as suggested_filename are deliberately not part of this type.
 */
export interface ExportFidelityIdentityV1 {
  readonly export_fidelity_profile: typeof V2_EXPORT_FIDELITY_PROFILE
  readonly identity_profile: typeof V2_IDENTITY_PROFILE
  readonly dataset_version: string
  readonly converter: V2ConverterName
  readonly converter_version: string
  readonly normalized_options: CanonicalJsonObject
  readonly media_type: string
  readonly output_count: number
  readonly config_hints: CanonicalJsonObject
  readonly fidelity: V2ExportFidelity
}

export type V2RecordId = `rec_${string}`
export type V2CandidateId = `cand_${string}`
export type V2SignalId = `sig_${string}`
export type V2PreferenceId = `pref_${string}`
