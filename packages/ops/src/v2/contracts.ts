import type { V2Dataset, V2DatasetLimits } from '@databench/engine'
import type {
  ArtifactRowIdentityRequestV1,
  CandidateIdentityRequestV1,
  DerivedRecordIdentityRequestV1,
  DirectRootIdentityRequestV1,
  JsonObjectV2,
  PreferenceIdentityRequestV1,
  SignalIdentityRequestV1,
  SourceRootIdentityRequestV1,
} from '@databench/schema'
import type { z } from 'zod'

export type V2TransformIdentityMode = 'preserve' | 'derive'

export type RootIdentityRequestV2 =
  | SourceRootIdentityRequestV1
  | ArtifactRowIdentityRequestV1
  | DirectRootIdentityRequestV1

export type EventIdentityRequestV2 = SignalIdentityRequestV1 | PreferenceIdentityRequestV1

/**
 * Stateful identity boundary supplied by Workspace.
 *
 * Implementations must persist/compare immutable identity claims before they
 * return an ID. Operations deliberately cannot reach Catalog directly.
 */
export interface V2IdentityAllocator {
  allocateRoot(input: RootIdentityRequestV2): Promise<string>
  deriveRecord(input: DerivedRecordIdentityRequestV1): Promise<string>
  allocateCandidate(input: CandidateIdentityRequestV1): Promise<string>
  /** Owner membership and full-record admission must precede claim writes. */
  allocateEvent(input: EventIdentityRequestV2): Promise<string>
}

export interface DeterministicRngV2 {
  readonly seed: number
  nextUint32(): number
  nextInt(maxExclusive: number): number
}

export interface V2TransformContext {
  readonly run_id: `run_${string}`
  readonly identity_allocator: V2IdentityAllocator
  readonly seeded_rng: DeterministicRngV2 | null
  readonly limits: Readonly<V2DatasetLimits>
  readonly working_set_budget_bytes: number
  readonly signal: AbortSignal
}

export interface V2TransformResourceEstimate {
  readonly outputUpperBoundBytes: number
  readonly frameEstimateBytes: number
}

export interface V2TransformDefinition<P extends object = JsonObjectV2> {
  readonly name: string
  readonly version: string
  readonly inputRoles: readonly string[]
  readonly paramsSchema: z.ZodType<P>
  readonly paramsExample: P
  readonly identityMode: V2TransformIdentityMode
  /** Extracts the only allowed RNG seed; Workspace must not guess param names. */
  rngSeed(params: P): number | null
  estimateWorkingSet(
    inputs: readonly V2Dataset[],
    params: P,
    limits?: Readonly<V2DatasetLimits>,
  ): Readonly<V2TransformResourceEstimate>
  run(inputs: readonly V2Dataset[], params: P, context: V2TransformContext): Promise<V2Dataset>
}

/** Internal registry projection. Wire DTOs remain owned by Schema. */
export interface V2TransformRegistryDescriptor {
  readonly name: string
  readonly version: string
  readonly identity_mode: V2TransformIdentityMode
  readonly input_roles: readonly string[]
  readonly params_schema: JsonObjectV2
  readonly params_example: JsonObjectV2
}
