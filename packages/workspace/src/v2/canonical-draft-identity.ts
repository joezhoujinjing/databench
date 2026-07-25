import type {
  CanonicalDraftRecordV1,
  IdentityCreationRequestV1,
  PostTrainingRecordV2,
  PreparedIdentityClaimV2,
} from '@databench/schema'
import {
  CanonicalDraftRecordV1Schema,
  IdentityNamespaceV2Schema,
  PostTrainingRecordV2Schema,
  prepareIdentityClaimV2,
} from '@databench/schema'
import type { V2IdentityAllocatorCatalog } from './identity-allocator.js'
import { insertOrReplayV2IdentityClaim } from './identity-allocator.js'

const DRAFT_ADAPTER_NAME = 'canonical-draft-jsonl-v1'

export interface V2CanonicalDraftPlannedClaim {
  readonly request: Readonly<IdentityCreationRequestV1>
  readonly prepared: PreparedIdentityClaimV2
}

export interface V2CanonicalDraftRecordIdentityPlan {
  readonly dataRowIndex: number
  readonly generationRunId: string
  readonly claims: readonly V2CanonicalDraftPlannedClaim[]
  readonly record: Readonly<PostTrainingRecordV2>
}

/**
 * Deterministic identity planner scoped to one exact canonical-draft artifact.
 * It performs no Catalog access while plans are built, so a complete file can
 * pass semantic and dataset admission before the first immutable claim write.
 */
export class V2CanonicalDraftIdentityAllocator {
  readonly #namespaceId: string
  readonly #sourceArtifactDigest: string

  constructor(namespaceIdInput: unknown, sourceArtifactDigestInput: unknown) {
    this.#namespaceId = IdentityNamespaceV2Schema.parse(namespaceIdInput)
    if (
      typeof sourceArtifactDigestInput !== 'string' ||
      !/^[0-9a-f]{64}$/.test(sourceArtifactDigestInput)
    ) {
      throw new TypeError('Canonical draft source artifact digest must be lowercase 64-hex')
    }
    this.#sourceArtifactDigest = sourceArtifactDigestInput
  }

  planRecord(
    draftInput: CanonicalDraftRecordV1,
    dataRowIndexInput: number,
  ): Readonly<V2CanonicalDraftRecordIdentityPlan> {
    const dataRowIndex = nonNegativeSafeInteger('data row index', dataRowIndexInput)
    const draft = CanonicalDraftRecordV1Schema.parse(draftInput)
    const claims: V2CanonicalDraftPlannedClaim[] = []

    const rootInitialRecord = {
      schema_version: draft.schema_version,
      contents: draft.contents,
      candidates: [],
      preference_relations: [],
      tools: draft.tools,
      verification: draft.verification,
      source: draft.source,
      lang: draft.lang,
      lineage: draft.lineage,
      tags: draft.tags,
      extra: draft.extra,
    }
    const rootRequest: IdentityCreationRequestV1 =
      draft.source !== null && draft.source.original_id !== null
        ? {
            creation_profile: 'source-root-v1',
            seed: {
              namespace: this.#namespaceId,
              source: {
                name: draft.source.name,
                kind: draft.source.kind,
                original_id: draft.source.original_id,
              },
            },
            initial_record: rootInitialRecord,
          }
        : {
            creation_profile: 'artifact-row-v1',
            seed: {
              namespace: this.#namespaceId,
              source_artifact_digest: this.#sourceArtifactDigest,
              row_index: dataRowIndex,
            },
            initial_record: rootInitialRecord,
          }
    const root = planClaim(this.#namespaceId, rootRequest)
    claims.push(root)
    const recordId = requireEntityKind(root.prepared, 'record')

    const generationRunId = canonicalDraftGenerationRunId(this.#sourceArtifactDigest, dataRowIndex)
    const candidatePlans: {
      readonly id: string
      readonly initialCandidate: Extract<
        IdentityCreationRequestV1,
        { readonly creation_profile: 'candidate-v1' }
      >['initial_candidate']
    }[] = []
    for (const [candidateIndex, candidate] of draft.candidates.entries()) {
      const candidateRequest: IdentityCreationRequestV1 = {
        creation_profile: 'candidate-v1',
        owner_record_id: recordId,
        seed: {
          record_id: recordId,
          generation_run_id: generationRunId,
          output_index: candidateIndex,
        },
        initial_candidate: {
          contents: candidate.contents,
          finish_reason: candidate.finish_reason,
          rank: candidate.rank,
          selected: candidate.selected,
          signals: [],
          generator: candidate.generator,
          token_count: candidate.token_count,
          avg_logprobs: candidate.avg_logprobs,
        },
      }
      const candidateClaim = planClaim(this.#namespaceId, candidateRequest)
      claims.push(candidateClaim)
      const candidateId = requireEntityKind(candidateClaim.prepared, 'candidate')

      candidatePlans.push({ id: candidateId, initialCandidate: candidateRequest.initial_candidate })
    }

    const candidates: PostTrainingRecordV2['candidates'][number][] = []
    for (const [candidateIndex, candidate] of draft.candidates.entries()) {
      const candidatePlan = candidatePlans[candidateIndex]
      if (candidatePlan === undefined) {
        throw new TypeError('Canonical draft candidate plan was not created')
      }
      const signalIds: string[] = []
      const signals: PostTrainingRecordV2['candidates'][number]['signals'][number][] = []
      for (const [signalIndex, signal] of candidate.signals.entries()) {
        const signalRequest: IdentityCreationRequestV1 = {
          creation_profile: 'signal-event-v1',
          owner_candidate_id: candidatePlan.id,
          seed: {
            owner_id: candidatePlan.id,
            producer: signal.source.id,
            producer_event_key: canonicalDraftSignalEventKey(
              this.#sourceArtifactDigest,
              dataRowIndex,
              candidateIndex,
              signalIndex,
            ),
          },
          initial_signal: {
            name: signal.name,
            kind: signal.kind,
            value: signal.value,
            source: signal.source,
            rationale: signal.rationale,
            created_at: signal.created_at,
            supersedes:
              signal.supersedes_index === null
                ? null
                : requireEarlierId(signalIds, signal.supersedes_index, 'signal'),
          },
        }
        const signalClaim = planClaim(this.#namespaceId, signalRequest)
        claims.push(signalClaim)
        const signalId = requireEntityKind(signalClaim.prepared, 'signal')
        signalIds.push(signalId)
        signals.push({ id: signalId, ...signalRequest.initial_signal })
      }

      candidates.push({ id: candidatePlan.id, ...candidatePlan.initialCandidate, signals })
    }

    const preferenceIds: string[] = []
    const preferenceRelations: PostTrainingRecordV2['preference_relations'][number][] = []
    for (const [preferenceIndex, preference] of draft.preference_relations.entries()) {
      const leftCandidate = candidates[preference.left_candidate_index]
      const rightCandidate = candidates[preference.right_candidate_index]
      if (leftCandidate === undefined || rightCandidate === undefined) {
        throw new TypeError('Canonical draft preference candidate index was not validated')
      }
      const preferenceRequest: IdentityCreationRequestV1 = {
        creation_profile: 'preference-event-v1',
        owner_record_id: recordId,
        seed: {
          owner_id: recordId,
          producer: preference.source.id,
          producer_event_key: canonicalDraftPreferenceEventKey(
            this.#sourceArtifactDigest,
            dataRowIndex,
            preferenceIndex,
          ),
        },
        initial_preference: {
          left_candidate_id: leftCandidate.id,
          right_candidate_id: rightCandidate.id,
          outcome: preference.outcome,
          status: preference.status,
          criterion: preference.criterion,
          source: preference.source,
          rationale: preference.rationale,
          created_at: preference.created_at,
          supersedes:
            preference.supersedes_index === null
              ? null
              : requireEarlierId(preferenceIds, preference.supersedes_index, 'preference'),
        },
      }
      const preferenceClaim = planClaim(this.#namespaceId, preferenceRequest)
      claims.push(preferenceClaim)
      const preferenceId = requireEntityKind(preferenceClaim.prepared, 'preference')
      preferenceIds.push(preferenceId)
      preferenceRelations.push({ id: preferenceId, ...preferenceRequest.initial_preference })
    }

    const record = PostTrainingRecordV2Schema.parse({
      schema_version: draft.schema_version,
      id: recordId,
      contents: draft.contents,
      candidates,
      preference_relations: preferenceRelations,
      tools: draft.tools,
      verification: draft.verification,
      source: draft.source,
      lang: draft.lang,
      lineage: draft.lineage,
      tags: draft.tags,
      extra: draft.extra,
    })
    return Object.freeze({
      dataRowIndex,
      generationRunId,
      claims: Object.freeze(claims),
      record: Object.freeze(record),
    })
  }

  async claimPlans(
    plans: Iterable<Readonly<V2CanonicalDraftRecordIdentityPlan>>,
    catalog: V2IdentityAllocatorCatalog,
    signal: AbortSignal,
  ): Promise<void> {
    for (const plan of plans) {
      for (const claim of plan.claims) {
        await insertOrReplayV2IdentityClaim(catalog, claim.prepared, signal)
      }
    }
  }
}

export function canonicalDraftGenerationRunId(
  sourceArtifactDigest: string,
  dataRowIndex: number,
): string {
  return `${DRAFT_ADAPTER_NAME}:${sourceArtifactDigest}:row:${nonNegativeSafeInteger(
    'data row index',
    dataRowIndex,
  )}`
}

export function canonicalDraftSignalEventKey(
  sourceArtifactDigest: string,
  dataRowIndex: number,
  candidateIndex: number,
  signalIndex: number,
): string {
  return `${canonicalDraftGenerationRunId(sourceArtifactDigest, dataRowIndex)}:candidate:${nonNegativeSafeInteger(
    'candidate index',
    candidateIndex,
  )}:signal:${nonNegativeSafeInteger('signal index', signalIndex)}`
}

export function canonicalDraftPreferenceEventKey(
  sourceArtifactDigest: string,
  dataRowIndex: number,
  preferenceIndex: number,
): string {
  return `${canonicalDraftGenerationRunId(sourceArtifactDigest, dataRowIndex)}:preference:${nonNegativeSafeInteger(
    'preference index',
    preferenceIndex,
  )}`
}

function planClaim(
  namespaceId: string,
  request: IdentityCreationRequestV1,
): V2CanonicalDraftPlannedClaim {
  return Object.freeze({ request, prepared: prepareIdentityClaimV2(namespaceId, request) })
}

function requireEntityKind<Kind extends PreparedIdentityClaimV2['entity_kind']>(
  claim: PreparedIdentityClaimV2,
  kind: Kind,
): Extract<PreparedIdentityClaimV2, { readonly entity_kind: Kind }>['entity_id'] {
  if (claim.entity_kind !== kind) {
    throw new TypeError(`Canonical draft identity planner expected a ${kind} claim`)
  }
  return claim.entity_id as Extract<
    PreparedIdentityClaimV2,
    { readonly entity_kind: Kind }
  >['entity_id']
}

function requireEarlierId(ids: readonly string[], index: number, kind: string): string {
  const id = ids[index]
  if (id === undefined) {
    throw new TypeError(`Canonical draft ${kind} supersedes index was not validated`)
  }
  return id
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Canonical draft ${name} must be a non-negative safe integer`)
  }
  return value
}
