import { ResourceLimitError } from '@databench/schema'
import type { V2OperationContext } from './contracts.js'
import type { WorkerStagingObjectStoreV1 } from './worker-staging.js'

export const EVALUATION_ARCHIVE_MEDIA_TYPE_V1 = 'application/zstd'
export const DEFAULT_EVALUATION_ARCHIVE_MAX_BYTES_V1 = 1024 * 1024 * 1024
export const DEFAULT_EVALUATION_ARCHIVE_SIGNED_URL_TTL_MS_V1 = 15 * 60 * 1000

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DIGEST = /^[0-9a-f]{64}$/

export interface EvaluationArchiveRefV1 {
  readonly runId: string
  readonly attempt: number
}

export interface EvaluationArchiveSignedTargetV1 {
  readonly writeUrl: string
  readonly expiresAt: Date
  readonly maxSize: number
  readonly mediaType: typeof EVALUATION_ARCHIVE_MEDIA_TYPE_V1
  readonly requiredHeaders: Readonly<{
    'content-type': typeof EVALUATION_ARCHIVE_MEDIA_TYPE_V1
    'if-none-match': '*'
  }>
}

export interface EvaluationStagingStoreConfigV1 {
  readonly objectStore: WorkerStagingObjectStoreV1
  readonly maxBytes?: number
  readonly signedUrlTtlMs?: number
  readonly now?: () => Date
}

export function evaluationArchiveStagingKeyV1(ref: EvaluationArchiveRefV1): string {
  validateRef(ref)
  return `staging/evaluations/v1/${ref.runId}/${ref.attempt}/result.tar.zst`
}

export function evaluationArchiveObjectKeyV1(digest: string): string {
  if (!DIGEST.test(digest)) {
    throw new TypeError('Evaluation archive digest must be 64 lowercase hexadecimal characters')
  }
  return `objects/v2/evaluation-result-v1/${digest.slice(0, 2)}/${digest}.tar.zst`
}

export class EvaluationStagingStoreV1 {
  readonly objectStore: WorkerStagingObjectStoreV1
  readonly maxBytes: number
  readonly #ttlMs: number
  readonly #now: () => Date

  constructor(config: EvaluationStagingStoreConfigV1) {
    this.objectStore = config.objectStore
    this.maxBytes = positiveSafeInteger(
      'Evaluation archive maxBytes',
      config.maxBytes ?? DEFAULT_EVALUATION_ARCHIVE_MAX_BYTES_V1,
    )
    const ttlMs = positiveSafeInteger(
      'Evaluation archive signedUrlTtlMs',
      config.signedUrlTtlMs ?? DEFAULT_EVALUATION_ARCHIVE_SIGNED_URL_TTL_MS_V1,
    )
    if (ttlMs > DEFAULT_EVALUATION_ARCHIVE_SIGNED_URL_TTL_MS_V1) {
      throw new TypeError(
        `Evaluation archive signedUrlTtlMs must not exceed ${DEFAULT_EVALUATION_ARCHIVE_SIGNED_URL_TTL_MS_V1}`,
      )
    }
    this.#ttlMs = ttlMs
    this.#now = config.now ?? (() => new Date())
  }

  async prepareUpload(
    ref: EvaluationArchiveRefV1,
    maxSize = this.maxBytes,
  ): Promise<Readonly<EvaluationArchiveSignedTargetV1>> {
    const key = evaluationArchiveStagingKeyV1(ref)
    const boundedMaxSize = positiveSafeInteger('Evaluation archive upload maxSize', maxSize)
    if (boundedMaxSize > this.maxBytes) {
      throw new ResourceLimitError(
        'Evaluation archive upload limit exceeds the configured maximum',
        {
          resource: 'evaluation_archive_bytes',
          limit: this.maxBytes,
          actual: boundedMaxSize,
        },
      )
    }
    const writeUrl = await this.objectStore.presignStaging({
      key,
      method: 'PUT',
      contentType: EVALUATION_ARCHIVE_MEDIA_TYPE_V1,
      expiresInSeconds: Math.ceil(this.#ttlMs / 1_000),
      ifNoneMatch: '*',
    })
    return Object.freeze({
      writeUrl,
      expiresAt: new Date(this.#now().getTime() + this.#ttlMs),
      maxSize: boundedMaxSize,
      mediaType: EVALUATION_ARCHIVE_MEDIA_TYPE_V1,
      requiredHeaders: Object.freeze({
        'content-type': EVALUATION_ARCHIVE_MEDIA_TYPE_V1,
        'if-none-match': '*',
      }),
    })
  }

  async deleteExact(ref: EvaluationArchiveRefV1, context: V2OperationContext = {}): Promise<void> {
    await this.objectStore.deleteStaging(evaluationArchiveStagingKeyV1(ref), context)
  }
}

function validateRef(ref: EvaluationArchiveRefV1): void {
  if (!RUN_ID.test(ref.runId)) throw new TypeError('Evaluation archive run ID is invalid')
  if (!Number.isSafeInteger(ref.attempt) || ref.attempt < 1 || ref.attempt > 2_147_483_647) {
    throw new TypeError('Evaluation archive attempt must be a positive PostgreSQL integer')
  }
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}
