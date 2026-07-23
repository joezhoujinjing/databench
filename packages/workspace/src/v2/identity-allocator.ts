import type { CatalogIdentityClaimInputV2, CatalogIdentityClaimResultV2 } from '@databench/catalog'
import type { V2Dataset } from '@databench/engine'
import { canonicalJsonV2 } from '@databench/hashing'
import type {
  EventIdentityRequestV2,
  RootIdentityRequestV2,
  V2IdentityAllocator,
} from '@databench/ops'
import {
  type CandidateIdentityRequestV1,
  compareExistingDerivedRevisionClaimV2,
  compareExistingIdentityClaimV2,
  type DerivedRecordIdentityRequestV1,
  type PostTrainingRecordV2,
  PostTrainingRecordV2Schema,
  type PreparedIdentityClaimV2,
  prepareIdentityClaimV2,
  type RecordRevisionV2,
  ValidationError,
} from '@databench/schema'
import { mapV2CatalogError } from './mappings.js'

export interface V2IdentityAllocatorCatalog {
  insertOrReadIdentityClaim(
    input: CatalogIdentityClaimInputV2,
  ): Promise<CatalogIdentityClaimResultV2>
}

interface StagedOwnerRecordV2 {
  readonly exactKey: string
  record: PostTrainingRecordV2
}

/**
 * Stateful identity allocator scoped to one exact transform input set.
 *
 * Owner and parent admission is completed against those pinned revisions
 * before the immutable Catalog claim is written.
 */
export class V2WorkspaceIdentityAllocator implements V2IdentityAllocator {
  readonly #catalog: V2IdentityAllocatorCatalog
  readonly #namespaceId: string
  readonly #signal: AbortSignal
  readonly #recordsById = new Map<string, Map<string, StagedOwnerRecordV2>>()
  readonly #recordsByCandidateId = new Map<string, Map<string, StagedOwnerRecordV2>>()
  readonly #revisionsByExactKey = new Map<string, RecordRevisionV2>()
  readonly #ownersByExactKey = new Map<string, StagedOwnerRecordV2>()
  readonly #ownerTails = new Map<string, Promise<void>>()

  constructor(
    catalog: V2IdentityAllocatorCatalog,
    namespaceId: string,
    inputs: readonly V2Dataset[],
    signal: AbortSignal,
  ) {
    this.#catalog = catalog
    this.#namespaceId = namespaceId
    this.#signal = signal
    for (const dataset of inputs) {
      for (const revision of dataset.records()) {
        const exactKey = revisionKey(revision.record.id, revision.record_digest)
        this.#revisionsByExactKey.set(exactKey, revision)
        const owner =
          this.#ownersByExactKey.get(exactKey) ??
          ({
            exactKey,
            record: structuredClone(revision.record) as PostTrainingRecordV2,
          } satisfies StagedOwnerRecordV2)
        this.#ownersByExactKey.set(exactKey, owner)
        addOwner(this.#recordsById, revision.record.id, owner)
        for (const candidate of revision.record.candidates) {
          addOwner(this.#recordsByCandidateId, candidate.id, owner)
        }
      }
    }
  }

  async allocateRoot(input: RootIdentityRequestV2): Promise<string> {
    return await this.#claim(input, false)
  }

  async deriveRecord(input: DerivedRecordIdentityRequestV1): Promise<string> {
    for (const parent of input.initial_record.lineage?.parent_refs ?? []) {
      if (!this.#revisionsByExactKey.has(revisionKey(parent.id, parent.record_digest))) {
        throw ownerAdmissionError(
          '/initial_record/lineage/parent_refs',
          'Derived record parent revision is not present in the exact transform inputs',
        )
      }
    }
    return await this.#claim(input, true)
  }

  async allocateCandidate(input: CandidateIdentityRequestV1): Promise<string> {
    const proposal = prepareIdentityClaimV2(this.#namespaceId, input)
    const owner = uniqueOwner(this.#recordsById, input.owner_record_id, '/owner_record_id')
    return await this.#withOwner(owner, async () => {
      const candidate = { id: proposal.entity_id, ...input.initial_candidate }
      const existing = owner.record.candidates.find(({ id }) => id === proposal.entity_id)
      if (existing !== undefined) {
        assertReplayPayload(existing, candidate, '/initial_candidate')
        return await this.#writeClaim(proposal, false)
      }
      const record = structuredClone(owner.record)
      const nextRecord = validateOwnerRecord({
        ...record,
        candidates: [...record.candidates, candidate],
      })
      const entityId = await this.#writeClaim(proposal, false)
      owner.record = nextRecord
      addOwner(this.#recordsByCandidateId, entityId, owner)
      return entityId
    })
  }

  async allocateEvent(input: EventIdentityRequestV2): Promise<string> {
    const proposal = prepareIdentityClaimV2(this.#namespaceId, input)
    if (input.creation_profile === 'signal-event-v1') {
      const owner = uniqueOwner(
        this.#recordsByCandidateId,
        input.owner_candidate_id,
        '/owner_candidate_id',
      )
      return await this.#withOwner(owner, async () => {
        const record = structuredClone(owner.record)
        const candidateIndex = record.candidates.findIndex(
          (candidate) => candidate.id === input.owner_candidate_id,
        )
        const candidate = record.candidates[candidateIndex]
        if (candidateIndex < 0 || candidate === undefined) {
          throw ownerAdmissionError('/owner_candidate_id', 'Signal owner candidate is missing')
        }
        const signal = { id: proposal.entity_id, ...input.initial_signal }
        const existing = candidate.signals.find(({ id }) => id === proposal.entity_id)
        if (existing !== undefined) {
          assertReplayPayload(existing, signal, '/initial_signal')
          return await this.#writeClaim(proposal, false)
        }
        const nextRecord = validateOwnerRecord({
          ...record,
          candidates: record.candidates.map((existing, index) =>
            index === candidateIndex
              ? {
                  ...candidate,
                  signals: [...candidate.signals, signal],
                }
              : existing,
          ),
        })
        const entityId = await this.#writeClaim(proposal, false)
        owner.record = nextRecord
        return entityId
      })
    } else {
      const owner = uniqueOwner(this.#recordsById, input.owner_record_id, '/owner_record_id')
      return await this.#withOwner(owner, async () => {
        const preference = { id: proposal.entity_id, ...input.initial_preference }
        const existing = owner.record.preference_relations.find(
          ({ id }) => id === proposal.entity_id,
        )
        if (existing !== undefined) {
          assertReplayPayload(existing, preference, '/initial_preference')
          return await this.#writeClaim(proposal, false)
        }
        const record = structuredClone(owner.record)
        const nextRecord = validateOwnerRecord({
          ...record,
          preference_relations: [...record.preference_relations, preference],
        })
        const entityId = await this.#writeClaim(proposal, false)
        owner.record = nextRecord
        return entityId
      })
    }
  }

  async #withOwner<T>(owner: StagedOwnerRecordV2, operation: () => Promise<T>): Promise<T> {
    const previous = this.#ownerTails.get(owner.exactKey) ?? Promise.resolve()
    const execution = previous.then(operation, operation)
    const tail = execution.then(
      () => undefined,
      () => undefined,
    )
    this.#ownerTails.set(owner.exactKey, tail)
    try {
      return await execution
    } finally {
      if (this.#ownerTails.get(owner.exactKey) === tail) {
        this.#ownerTails.delete(owner.exactKey)
      }
    }
  }

  async #claim(input: RootIdentityRequestV2 | DerivedRecordIdentityRequestV1, derived: boolean) {
    const proposal = prepareIdentityClaimV2(this.#namespaceId, input)
    return await this.#writeClaim(proposal, derived)
  }

  async #writeClaim(proposal: PreparedIdentityClaimV2, derived: boolean): Promise<string> {
    this.#signal.throwIfAborted()
    let result: CatalogIdentityClaimResultV2
    try {
      result = await this.#catalog.insertOrReadIdentityClaim(toCatalogClaim(proposal))
    } catch (error) {
      mapV2CatalogError(error, false)
    }
    const stored = fromCatalogClaim(result.row)
    if (derived) {
      compareExistingDerivedRevisionClaimV2(stored, proposal)
    } else {
      compareExistingIdentityClaimV2(stored, proposal)
    }
    this.#signal.throwIfAborted()
    return proposal.entity_id
  }
}

function addOwner(
  index: Map<string, Map<string, StagedOwnerRecordV2>>,
  entityId: string,
  owner: StagedOwnerRecordV2,
): void {
  const owners = index.get(entityId) ?? new Map<string, StagedOwnerRecordV2>()
  owners.set(owner.exactKey, owner)
  index.set(entityId, owners)
}

function uniqueOwner(
  index: ReadonlyMap<string, ReadonlyMap<string, StagedOwnerRecordV2>>,
  entityId: string,
  path: string,
): StagedOwnerRecordV2 {
  const candidates = index.get(entityId)
  if (candidates?.size !== 1) {
    throw ownerAdmissionError(
      path,
      candidates?.size === 0 || candidates === undefined
        ? 'Identity owner is not present in the exact transform inputs'
        : 'Identity owner is ambiguous across exact transform input revisions',
    )
  }
  const revision = candidates.values().next().value
  if (!revision) throw ownerAdmissionError(path, 'Identity owner revision is missing')
  return revision
}

function validateOwnerRecord(record: unknown): PostTrainingRecordV2 {
  const parsed = PostTrainingRecordV2Schema.safeParse(record)
  if (!parsed.success) {
    throw ownerAdmissionError(
      '/initial_record',
      'Identity allocation would create an invalid owner record revision',
    )
  }
  return parsed.data
}

function assertReplayPayload(existing: unknown, requested: unknown, path: string): void {
  if (canonicalJsonV2(existing) !== canonicalJsonV2(requested)) {
    throw ownerAdmissionError(
      path,
      'Identity replay payload conflicts with the staged owner entity',
    )
  }
}

function toCatalogClaim(proposal: PreparedIdentityClaimV2): CatalogIdentityClaimInputV2 {
  return {
    namespaceId: proposal.namespace,
    entityKind: proposal.entity_kind,
    claimKeyDigest: proposal.claim_key_digest,
    claimProfile: proposal.claim_profile,
    requestProfile: proposal.request_profile,
    creationProfile: proposal.creation_profile,
    entityId: proposal.entity_id,
    requestDigest: proposal.request_digest,
  }
}

function fromCatalogClaim(result: CatalogIdentityClaimResultV2['row']): unknown {
  return {
    namespace: result.namespaceId,
    claim_profile: result.claimProfile,
    request_profile: result.requestProfile,
    entity_kind: result.entityKind,
    creation_profile: result.creationProfile,
    entity_id: result.entityId,
    claim_key_digest: result.claimKeyDigest,
    request_digest: result.requestDigest,
  }
}

function ownerAdmissionError(path: string, message: string): ValidationError {
  return new ValidationError('V2 identity owner-context admission failed', {
    issues: [{ path, line: null, code: 'identity_owner_context', message }],
  })
}

function revisionKey(recordId: string, recordDigest: string): string {
  return `${recordId}\0${recordDigest}`
}
