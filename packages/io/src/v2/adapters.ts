import type { PostTrainingRecordV2 } from '@databench/schema'

export type ExternalRecordAdapterKindV2 = 'provider' | 'raw'

export interface ExternalRecordAdapterContextV2<TIdentityAllocator = unknown> {
  readonly identityAllocator: TIdentityAllocator
  readonly signal?: AbortSignal
}

/**
 * Extension contract for future provider/raw imports. Implementations must
 * normalize aliases, allocate canonical IDs through the supplied context, and
 * yield complete strict records. Canonical JSONL intentionally does not use
 * this adapter path because it preserves IDs already present in the input.
 */
export interface ExternalRecordAdapterV2<TOptions, TIdentityAllocator = unknown> {
  readonly kind: ExternalRecordAdapterKindV2
  readonly name: string
  readonly version: string
  read(
    source: AsyncIterable<Uint8Array>,
    options: TOptions,
    context: ExternalRecordAdapterContextV2<TIdentityAllocator>,
  ): AsyncIterable<PostTrainingRecordV2>
}
