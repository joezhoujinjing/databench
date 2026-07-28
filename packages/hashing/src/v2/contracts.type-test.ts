import {
  type DatasetIdentityEnvelopeV2,
  type ExportFidelityIdentityV1,
  hashV2DatasetIdentity,
  hashV2ExportFidelity,
  hashV2IdentityClaimKey,
  hashV2ModelArtifactImportCreate,
  hashV2SwiftStudioSessionCreate,
  type ModelArtifactImportCreateIdentityV1,
  type SwiftStudioSessionCreateIdentityV1,
  V2_IDENTITY_CLAIM_PROFILE,
  V2_IDENTITY_PROFILE,
  V2_MODEL_ARTIFACT_IMPORT_CREATE_PROFILE,
  V2_SWIFT_STUDIO_SESSION_CREATE_PROFILE,
} from '../index.js'

const datasetIdentity: DatasetIdentityEnvelopeV2 = {
  identity_profile: V2_IDENTITY_PROFILE,
  record_schema_version: '2.0.0',
  record_digests: [],
}
hashV2DatasetIdentity(datasetIdentity)

const snapshotWithMetadata = {
  ...datasetIdentity,
  dataset_version: '0'.repeat(64),
  created_at: '2026-07-23T00:00:00Z',
}
// @ts-expect-error Snapshot metadata is not part of the dataset identity envelope.
hashV2DatasetIdentity(snapshotWithMetadata)

const exportFidelityIdentity: ExportFidelityIdentityV1 = {
  export_fidelity_profile: 'databench-export-fidelity-1',
  identity_profile: V2_IDENTITY_PROFILE,
  dataset_version: '0'.repeat(64),
  converter: 'canonical-jsonl',
  converter_version: '1.0.0',
  normalized_options: {},
  media_type: 'application/x-ndjson',
  output_count: 0,
  config_hints: {},
  fidelity: { preserved: [], changes: [] },
}

// @ts-expect-error Display-only fields are not part of the approval identity.
hashV2ExportFidelity({ ...exportFidelityIdentity, suggested_filename: 'dataset.jsonl' })

const swiftStudioSessionIdentity: SwiftStudioSessionCreateIdentityV1 = {
  swift_studio_session_create_profile: V2_SWIFT_STUDIO_SESSION_CREATE_PROFILE,
  namespace: '11111111-1111-4111-8111-111111111111',
  dataset_version: '0'.repeat(64),
  converter: 'ms-swift',
  converter_version: '1.0.0',
  normalized_options: {},
  fidelity_digest: '1'.repeat(64),
  output_count: 1,
  provider: 'swift-studio',
  upstream_commit: '2'.repeat(40),
  image_digest: '3'.repeat(64),
  runtime_capability_digest: '4'.repeat(64),
}
hashV2SwiftStudioSessionCreate(swiftStudioSessionIdentity)

// @ts-expect-error Display-only Ref labels are not part of Session create identity.
hashV2SwiftStudioSessionCreate({ ...swiftStudioSessionIdentity, display_ref: 'main' })

const modelArtifactImportIdentity: ModelArtifactImportCreateIdentityV1 = {
  model_artifact_import_create_profile: V2_MODEL_ARTIFACT_IMPORT_CREATE_PROFILE,
  namespace: '11111111-1111-4111-8111-111111111111',
  studio_session_id: '22222222-2222-4222-8222-222222222222',
  output_handle_digest: '0'.repeat(64),
  artifact_kind: 'lora_adapter',
  display_name: 'adapter',
  base_model: { reference: 'Qwen/Qwen3-0.6B', revision: null },
}
hashV2ModelArtifactImportCreate(modelArtifactImportIdentity)

// @ts-expect-error Mutable output paths are not part of the import identity.
hashV2ModelArtifactImportCreate({ ...modelArtifactImportIdentity, output_path: '/workspace/out' })

// @ts-expect-error Candidate claims cannot use a source-root profile and record seed.
hashV2IdentityClaimKey({
  claim_profile: V2_IDENTITY_CLAIM_PROFILE,
  identity_profile: V2_IDENTITY_PROFILE,
  namespace: '018f0f3e-7b4a-7c12-8d33-123456789abc',
  entity_kind: 'candidate',
  creation_profile: 'source-root-v1',
  claim_material: {
    namespace: '018f0f3e-7b4a-7c12-8d33-123456789abc',
    source: { name: 'demo', kind: 'jsonl', original_id: 'row-1' },
  },
})
