import type { V2DatasetLimits } from '@databench/engine'
import type { DeterministicRngV2, V2IdentityAllocator, V2TransformContext } from './contracts.js'

const RUN_ID_PATTERN = /^run_[0-9a-f]{64}$/
const UINT32_RANGE = 0x1_0000_0000
const UINT32_MAX = UINT32_RANGE - 1

export interface CreateV2TransformContextInput {
  readonly run_id: string
  readonly identity_allocator: V2IdentityAllocator
  readonly seed: number | null
  readonly limits: V2DatasetLimits
  readonly working_set_budget_bytes: number
  readonly signal: AbortSignal
}

/**
 * Constructs the deliberately narrow deterministic operation context.
 * No clock, ambient RNG, environment, filesystem or network handle is exposed.
 */
export function createV2TransformContext(
  input: CreateV2TransformContextInput,
): Readonly<V2TransformContext> {
  if (!RUN_ID_PATTERN.test(input.run_id)) {
    throw new TypeError('run_id must equal run_ followed by a 64-character lowercase hex key')
  }
  assertIdentityAllocator(input.identity_allocator)
  const limits = validateLimits(input.limits)
  assertNonNegativeSafeInteger('working_set_budget_bytes', input.working_set_budget_bytes)
  if (!(input.signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal')
  }
  input.signal.throwIfAborted()

  return Object.freeze({
    run_id: input.run_id as `run_${string}`,
    identity_allocator: input.identity_allocator,
    seeded_rng: input.seed === null ? null : createDeterministicRngV2(input.seed),
    limits,
    working_set_budget_bytes: input.working_set_budget_bytes,
    signal: input.signal,
  })
}

/**
 * Version-locked Mulberry32 stream plus rejection-sampled bounded integers.
 * The algorithm is intentionally implemented locally and has fixed vectors.
 */
export function createDeterministicRngV2(seed: number): DeterministicRngV2 {
  assertUint32('seed', seed)
  return new Mulberry32Rng(seed)
}

class Mulberry32Rng implements DeterministicRngV2 {
  readonly seed: number
  #state: number

  constructor(seed: number) {
    this.seed = seed
    this.#state = seed >>> 0
  }

  nextUint32(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0
    let value = this.#state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return (value ^ (value >>> 14)) >>> 0
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
      throw new TypeError('maxExclusive must be an integer in [1, 2^32]')
    }

    const acceptedRange = Math.floor(UINT32_RANGE / maxExclusive) * maxExclusive
    let value = this.nextUint32()
    while (value >= acceptedRange) {
      value = this.nextUint32()
    }
    return value % maxExclusive
  }
}

function validateLimits(input: V2DatasetLimits): Readonly<V2DatasetLimits> {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('limits must be an object')
  }
  assertNonNegativeSafeInteger('limits.max_records', input.max_records)
  assertNonNegativeSafeInteger('limits.max_canonical_bytes', input.max_canonical_bytes)
  assertNonNegativeSafeInteger('limits.max_record_bytes', input.max_record_bytes)
  return Object.freeze({
    max_records: input.max_records,
    max_canonical_bytes: input.max_canonical_bytes,
    max_record_bytes: input.max_record_bytes,
  })
}

function assertIdentityAllocator(input: V2IdentityAllocator): void {
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof input.allocateRoot !== 'function' ||
    typeof input.deriveRecord !== 'function' ||
    typeof input.allocateCandidate !== 'function' ||
    typeof input.allocateEvent !== 'function'
  ) {
    throw new TypeError('identity_allocator must implement the stateful V2 identity boundary')
  }
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
}

function assertUint32(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new TypeError(`${name} must be an unsigned 32-bit integer`)
  }
}
