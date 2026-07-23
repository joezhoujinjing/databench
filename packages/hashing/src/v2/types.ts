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

export interface IdentityClaimHashInputV1 {
  readonly claim_profile: typeof V2_IDENTITY_CLAIM_PROFILE
  readonly identity_profile: typeof V2_IDENTITY_PROFILE
  readonly namespace: string
  readonly entity_kind: V2EntityKind
  readonly creation_profile: V2CreationProfile
  readonly claim_material: IdentityClaimMaterialV1
}

export interface IdentityRequestHashInputV1 {
  readonly request_profile: typeof V2_IDENTITY_REQUEST_PROFILE
  readonly identity_profile: typeof V2_IDENTITY_PROFILE
  readonly namespace: string
  readonly entity_kind: V2EntityKind
  readonly creation_profile: V2CreationProfile
  readonly normalized_request: CanonicalJsonValue
}

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

export type V2RecordId = `rec_${string}`
export type V2CandidateId = `cand_${string}`
export type V2SignalId = `sig_${string}`
export type V2PreferenceId = `pref_${string}`
