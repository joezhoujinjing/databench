import { TextEncoder } from 'node:util'
import { digest } from '../blake3.js'
import { canonicalJsonV2 } from './canonical-json.js'
import type {
  CandidateSeedV1,
  CanonicalJsonValue,
  DatasetIdentityEnvelopeV2,
  EventSeedV1,
  IdentityClaimHashInputV1,
  IdentityRequestHashInputV1,
  RecordSeedV1,
  TransformCacheIdentityV1,
  V2CandidateId,
  V2PreferenceId,
  V2RecordId,
  V2SignalId,
} from './types.js'

const textEncoder = new TextEncoder()

const DOMAIN = {
  recordId: 'databench.id.databench-v2-jcs-1.record.v1\0',
  candidateId: 'databench.id.databench-v2-jcs-1.candidate.v1\0',
  signalId: 'databench.id.databench-v2-jcs-1.signal.v1\0',
  preferenceId: 'databench.id.databench-v2-jcs-1.preference.v1\0',
  record: 'databench.record.databench-v2-jcs-1\0',
  dataset: 'databench.dataset.databench-v2-jcs-1\0',
  transformCache: 'databench.transform-cache.databench-v2-jcs-1\0',
  identityClaim: 'databench.identity-claim-key.databench-v2-jcs-1.v1\0',
  identityRequest: 'databench.identity-request.databench-v2-jcs-1.v1\0',
  exportFidelity: 'databench.export-fidelity.databench-export-fidelity-1\0',
} as const

export function deriveV2RecordId(seed: RecordSeedV1): V2RecordId {
  return `rec_${hashDomain(DOMAIN.recordId, seed)}`
}

export function deriveV2CandidateId(seed: CandidateSeedV1): V2CandidateId {
  return `cand_${hashDomain(DOMAIN.candidateId, seed)}`
}

export function deriveV2SignalId(seed: EventSeedV1): V2SignalId {
  return `sig_${hashDomain(DOMAIN.signalId, seed)}`
}

export function deriveV2PreferenceId(seed: EventSeedV1): V2PreferenceId {
  return `pref_${hashDomain(DOMAIN.preferenceId, seed)}`
}

export function hashV2IdentityClaimKey(identity: IdentityClaimHashInputV1): string {
  return hashDomain(DOMAIN.identityClaim, {
    claim_profile: identity.claim_profile,
    identity_profile: identity.identity_profile,
    namespace: identity.namespace,
    entity_kind: identity.entity_kind,
    creation_profile: identity.creation_profile,
    claim_material: identity.claim_material,
  })
}

export function hashV2IdentityRequest(identity: IdentityRequestHashInputV1): string {
  return hashDomain(DOMAIN.identityRequest, {
    request_profile: identity.request_profile,
    identity_profile: identity.identity_profile,
    namespace: identity.namespace,
    entity_kind: identity.entity_kind,
    creation_profile: identity.creation_profile,
    normalized_request: identity.normalized_request,
  })
}

export function hashV2Record(record: unknown): string {
  return hashDomain(DOMAIN.record, record)
}

type NoExtraKeys<Expected, Actual extends Expected> = Actual &
  Record<Exclude<keyof Actual, keyof Expected>, never>

export function hashV2DatasetIdentity<const Identity extends DatasetIdentityEnvelopeV2>(
  identity: NoExtraKeys<DatasetIdentityEnvelopeV2, Identity>,
): string {
  return hashDomain(DOMAIN.dataset, {
    identity_profile: identity.identity_profile,
    record_schema_version: identity.record_schema_version,
    record_digests: [...identity.record_digests].sort(),
  })
}

export function hashV2TransformCache(identity: TransformCacheIdentityV1): string {
  return hashDomain(DOMAIN.transformCache, {
    identity_profile: identity.identity_profile,
    op: identity.op,
    op_version: identity.op_version,
    input_dataset_versions: identity.input_dataset_versions,
    params: identity.params,
  })
}

export function hashV2ExportFidelity(identity: CanonicalJsonValue): string {
  return hashDomain(DOMAIN.exportFidelity, identity)
}

function hashDomain(domain: string, value: unknown): string {
  return digest(textEncoder.encode(`${domain}${canonicalJsonV2(value)}`))
}
