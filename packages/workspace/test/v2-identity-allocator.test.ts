import type { CatalogIdentityClaimInputV2, CatalogIdentityClaimResultV2 } from '@databench/catalog'
import { V2Dataset } from '@databench/engine'
import type { PostTrainingRecordV2 } from '@databench/schema'
import { describe, expect, test, vi } from 'vitest'
import { V2WorkspaceIdentityAllocator } from '../src/v2/identity-allocator.js'

const NAMESPACE = '123e4567-e89b-12d3-a456-426614174000'
const RECORD_ID = `rec_${'1'.repeat(64)}`
const CANDIDATE_ID = `cand_${'2'.repeat(64)}`
const SECOND_CANDIDATE_ID = `cand_${'3'.repeat(64)}`
const NOW = new Date('2026-07-23T00:00:00.000Z')

describe('V2WorkspaceIdentityAllocator owner-context admission', () => {
  test('rejects a missing signal owner before writing an immutable claim', async () => {
    const insertOrReadIdentityClaim = vi.fn()
    const allocator = new V2WorkspaceIdentityAllocator(
      { insertOrReadIdentityClaim },
      NAMESPACE,
      [V2Dataset.fromRecords([])],
      new AbortController().signal,
    )

    await expect(allocator.allocateEvent(signalRequest())).rejects.toMatchObject({
      code: 'validation_error',
      detail: {
        issues: [expect.objectContaining({ code: 'identity_owner_context' })],
      },
    })
    expect(insertOrReadIdentityClaim).not.toHaveBeenCalled()
  })

  test('rejects an owner that is ambiguous across exact input revisions before claim', async () => {
    const insertOrReadIdentityClaim = vi.fn()
    const allocator = new V2WorkspaceIdentityAllocator(
      { insertOrReadIdentityClaim },
      NAMESPACE,
      [dataset('first revision'), dataset('second revision')],
      new AbortController().signal,
    )

    await expect(allocator.allocateEvent(signalRequest())).rejects.toMatchObject({
      code: 'validation_error',
      detail: {
        issues: [
          expect.objectContaining({
            path: '/owner_candidate_id',
            code: 'identity_owner_context',
          }),
        ],
      },
    })
    expect(insertOrReadIdentityClaim).not.toHaveBeenCalled()
  })

  test('validates preference candidate membership before writing the claim', async () => {
    const insertOrReadIdentityClaim = vi.fn()
    const allocator = new V2WorkspaceIdentityAllocator(
      { insertOrReadIdentityClaim },
      NAMESPACE,
      [dataset('owner revision')],
      new AbortController().signal,
    )

    await expect(
      allocator.allocateEvent({
        creation_profile: 'preference-event-v1',
        owner_record_id: RECORD_ID,
        seed: {
          owner_id: RECORD_ID,
          producer: 'judge-v1',
          producer_event_key: 'preference-1',
        },
        initial_preference: {
          left_candidate_id: CANDIDATE_ID,
          right_candidate_id: `cand_${'9'.repeat(64)}`,
          outcome: 'left',
          status: 'adjudicated',
          criterion: 'quality',
          source: { type: 'ai', id: 'judge-v1', version: '1' },
          rationale: null,
          created_at: null,
          supersedes: null,
        },
      }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      detail: {
        issues: [expect.objectContaining({ code: 'identity_owner_context' })],
      },
    })
    expect(insertOrReadIdentityClaim).not.toHaveBeenCalled()
  })

  test('stages successful preferences and rejects a conflicting second event before claim', async () => {
    const insertOrReadIdentityClaim = successfulCatalogClaim()
    const allocator = allocatorFor(insertOrReadIdentityClaim)

    await expect(
      allocator.allocateEvent(preferenceRequest('preference-1', 'left')),
    ).resolves.toMatch(/^pref_[0-9a-f]{64}$/)
    await expect(
      allocator.allocateEvent(preferenceRequest('preference-2', 'right')),
    ).rejects.toMatchObject({
      code: 'validation_error',
      detail: { issues: [expect.objectContaining({ code: 'identity_owner_context' })] },
    })
    expect(insertOrReadIdentityClaim).toHaveBeenCalledTimes(1)
  })

  test('makes a successfully allocated candidate available to a later signal allocation', async () => {
    const insertOrReadIdentityClaim = successfulCatalogClaim()
    const allocator = allocatorFor(insertOrReadIdentityClaim)

    const candidateId = await allocator.allocateCandidate(candidateRequest())
    expect(candidateId).toMatch(/^cand_[0-9a-f]{64}$/)
    await expect(
      allocator.allocateEvent(signalRequest(candidateId, 'new-candidate-signal')),
    ).resolves.toMatch(/^sig_[0-9a-f]{64}$/)
    expect(insertOrReadIdentityClaim).toHaveBeenCalledTimes(2)
  })

  test('replays identical candidate and event requests without duplicating staged entities', async () => {
    const insertOrReadIdentityClaim = successfulCatalogClaim()
    const allocator = allocatorFor(insertOrReadIdentityClaim)
    const candidate = candidateRequest()

    const candidateId = await allocator.allocateCandidate(candidate)
    await expect(allocator.allocateCandidate(candidate)).resolves.toBe(candidateId)

    const signal = signalRequest(candidateId, 'replayed-signal')
    const signalId = await allocator.allocateEvent(signal)
    await expect(allocator.allocateEvent(signal)).resolves.toBe(signalId)

    const preference = preferenceRequest('replayed-preference', 'left')
    const preferenceId = await allocator.allocateEvent(preference)
    await expect(allocator.allocateEvent(preference)).resolves.toBe(preferenceId)
    expect(insertOrReadIdentityClaim).toHaveBeenCalledTimes(6)
  })

  test('rejects a same-ID replay with different staged payload before another claim write', async () => {
    const insertOrReadIdentityClaim = successfulCatalogClaim()
    const allocator = allocatorFor(insertOrReadIdentityClaim)
    const original = candidateRequest()
    await allocator.allocateCandidate(original)
    const conflicting = candidateRequest()
    conflicting.initial_candidate.contents = [content('ai', 'conflicting replay payload')]

    await expect(allocator.allocateCandidate(conflicting)).rejects.toMatchObject({
      code: 'validation_error',
      detail: { issues: [expect.objectContaining({ path: '/initial_candidate' })] },
    })
    expect(insertOrReadIdentityClaim).toHaveBeenCalledTimes(1)
  })

  test('serializes concurrent allocations against the same staged owner revision', async () => {
    const firstClaim = deferred<CatalogIdentityClaimResultV2>()
    const insertOrReadIdentityClaim = vi.fn(
      async (input: CatalogIdentityClaimInputV2): Promise<CatalogIdentityClaimResultV2> => {
        if (insertOrReadIdentityClaim.mock.calls.length === 1) return await firstClaim.promise
        return claimResult(input)
      },
    )
    const allocator = allocatorFor(insertOrReadIdentityClaim)

    const first = allocator.allocateEvent(preferenceRequest('concurrent-1', 'left'))
    await eventually(() => expect(insertOrReadIdentityClaim).toHaveBeenCalledTimes(1))
    const firstInput = insertOrReadIdentityClaim.mock.calls[0]?.[0]
    if (!firstInput) throw new Error('first claim input was not captured')
    const second = allocator.allocateEvent(preferenceRequest('concurrent-2', 'right'))
    await Promise.resolve()
    expect(insertOrReadIdentityClaim).toHaveBeenCalledTimes(1)

    firstClaim.resolve(claimResult(firstInput))
    await expect(first).resolves.toMatch(/^pref_[0-9a-f]{64}$/)
    await expect(second).rejects.toMatchObject({ code: 'validation_error' })
    expect(insertOrReadIdentityClaim).toHaveBeenCalledTimes(1)
  })

  test('does not publish failed claims into the staged owner state', async () => {
    const claimFailure = new Error('claim unavailable')
    const insertOrReadIdentityClaim = vi.fn(
      async (input: CatalogIdentityClaimInputV2): Promise<CatalogIdentityClaimResultV2> => {
        if (insertOrReadIdentityClaim.mock.calls.length === 1) throw claimFailure
        return claimResult(input)
      },
    )
    const allocator = allocatorFor(insertOrReadIdentityClaim)

    await expect(
      allocator.allocateEvent(preferenceRequest('failed-preference', 'left')),
    ).rejects.toMatchObject({ code: 'service_unavailable', cause: claimFailure })
    await expect(
      allocator.allocateEvent(preferenceRequest('retry-after-failure', 'right')),
    ).resolves.toMatch(/^pref_[0-9a-f]{64}$/)
    expect(insertOrReadIdentityClaim).toHaveBeenCalledTimes(2)
  })
})

function allocatorFor(
  insertOrReadIdentityClaim: (
    input: CatalogIdentityClaimInputV2,
  ) => Promise<CatalogIdentityClaimResultV2>,
) {
  return new V2WorkspaceIdentityAllocator(
    { insertOrReadIdentityClaim },
    NAMESPACE,
    [dataset('owner revision')],
    new AbortController().signal,
  )
}

function successfulCatalogClaim() {
  return vi.fn(
    async (input: CatalogIdentityClaimInputV2): Promise<CatalogIdentityClaimResultV2> =>
      claimResult(input),
  )
}

function claimResult(input: CatalogIdentityClaimInputV2): CatalogIdentityClaimResultV2 {
  return { status: 'created', row: { ...input, createdAt: NOW } }
}

function candidateRequest() {
  return {
    creation_profile: 'candidate-v1' as const,
    owner_record_id: RECORD_ID,
    seed: {
      record_id: RECORD_ID,
      generation_run_id: `run_${'a'.repeat(64)}`,
      output_index: 0,
    },
    initial_candidate: {
      contents: [content('ai', 'new candidate answer')],
      finish_reason: null,
      rank: null,
      selected: null,
      signals: [],
      generator: null,
      token_count: null,
      avg_logprobs: null,
    },
  }
}

function signalRequest(ownerCandidateId = CANDIDATE_ID, producerEventKey = 'signal-1') {
  return {
    creation_profile: 'signal-event-v1' as const,
    owner_candidate_id: ownerCandidateId,
    seed: {
      owner_id: ownerCandidateId,
      producer: 'judge-v1',
      producer_event_key: producerEventKey,
    },
    initial_signal: {
      name: 'quality',
      kind: 'rating' as const,
      value: {
        type: 'number' as const,
        value: 0.9,
        scale_min: 0,
        scale_max: 1,
        higher_is_better: true,
      },
      source: { type: 'ai' as const, id: 'judge-v1', version: '1' },
      rationale: null,
      created_at: null,
      supersedes: null,
    },
  }
}

function preferenceRequest(producerEventKey: string, outcome: 'left' | 'right') {
  return {
    creation_profile: 'preference-event-v1' as const,
    owner_record_id: RECORD_ID,
    seed: {
      owner_id: RECORD_ID,
      producer: 'judge-v1',
      producer_event_key: producerEventKey,
    },
    initial_preference: {
      left_candidate_id: CANDIDATE_ID,
      right_candidate_id: SECOND_CANDIDATE_ID,
      outcome,
      status: 'adjudicated' as const,
      criterion: 'quality',
      source: { type: 'ai' as const, id: 'judge-v1', version: '1' },
      rationale: null,
      created_at: null,
      supersedes: null,
    },
  }
}

function dataset(prompt: string): V2Dataset {
  return V2Dataset.fromRecords([record(prompt)])
}

function record(prompt: string): PostTrainingRecordV2 {
  return {
    schema_version: '2.0.0',
    id: RECORD_ID,
    system_instruction: null,
    contents: [content('user', prompt)],
    candidates: [
      {
        id: CANDIDATE_ID,
        contents: [content('ai', 'answer')],
        finish_reason: null,
        rank: null,
        selected: null,
        signals: [],
        generator: null,
        token_count: null,
        avg_logprobs: null,
      },
      {
        id: SECOND_CANDIDATE_ID,
        contents: [content('ai', 'second answer')],
        finish_reason: null,
        rank: null,
        selected: null,
        signals: [],
        generator: null,
        token_count: null,
        avg_logprobs: null,
      },
    ],
    preference_relations: [],
    tools: [],
    verification: null,
    source: null,
    lang: null,
    lineage: null,
    tags: [],
    extra: {},
  }
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  if (!resolvePromise) throw new Error('deferred resolver was not initialized')
  return { promise, resolve: resolvePromise }
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  assertion()
}

function content(role: 'user' | 'ai', text: string) {
  return {
    role,
    parts: [
      {
        type: 'text' as const,
        text,
        thought: false,
        thought_signature: null,
        part_metadata: {},
      },
    ],
    loss_weight: null,
  }
}
