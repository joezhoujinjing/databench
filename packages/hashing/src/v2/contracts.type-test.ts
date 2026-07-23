import {
  type DatasetIdentityEnvelopeV2,
  hashV2DatasetIdentity,
  hashV2IdentityClaimKey,
  V2_IDENTITY_CLAIM_PROFILE,
  V2_IDENTITY_PROFILE,
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
