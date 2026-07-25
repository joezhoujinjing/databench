import type {
  CatalogTransformJobRowV2,
  SetTransformJobStagingKeysV2,
  TransformJobLeaseV2,
} from '@databench/catalog'
import { WORKER_STAGING_JSONL_MEDIA_TYPE, type WorkerStagingStoreV1 } from '@databench/store'
import type { WorkerJsonPayload } from './client.js'
import type {
  PreparedWorkerRunJob,
  WorkerCleanupContext,
  WorkerJobCleaner,
  WorkerJobPreparer,
  WorkerPreparationContext,
} from './dispatcher.js'

export interface WorkerStagingCatalogV1 {
  setTransformJobStagingKeys(input: SetTransformJobStagingKeysV2): Promise<boolean>
}

export interface WorkerStagingInputProjectorV1 {
  project(job: CatalogTransformJobRowV2, signal: AbortSignal): AsyncIterable<Uint8Array>
}

export interface WorkerStagingJobPreparerV1Options {
  readonly catalog: WorkerStagingCatalogV1
  readonly staging: WorkerStagingStoreV1
  readonly projector: WorkerStagingInputProjectorV1
  readonly parameters: (job: CatalogTransformJobRowV2) => WorkerJsonPayload
  readonly maxOutputBytes?: number
}

export class WorkerStagingJobPreparerV1 implements WorkerJobPreparer {
  readonly #catalog: WorkerStagingCatalogV1
  readonly #staging: WorkerStagingStoreV1
  readonly #projector: WorkerStagingInputProjectorV1
  readonly #parameters: (job: CatalogTransformJobRowV2) => WorkerJsonPayload
  readonly #maxOutputBytes: number | undefined

  constructor(options: WorkerStagingJobPreparerV1Options) {
    this.#catalog = options.catalog
    this.#staging = options.staging
    this.#projector = options.projector
    this.#parameters = options.parameters
    this.#maxOutputBytes = options.maxOutputBytes
  }

  async prepare(context: WorkerPreparationContext): Promise<PreparedWorkerRunJob> {
    const ref = { jobId: context.job.id, attempt: context.job.attempt }
    let created = false
    try {
      const descriptor = await this.#staging.createInput(
        ref,
        this.#projector.project(context.job, context.signal),
        { signal: context.signal },
      )
      created = true
      const source = await this.#staging.signRead(ref, descriptor)
      const target = await this.#staging.createOutputTarget(ref, this.#maxOutputBytes, {
        signal: context.signal,
      })
      const lease = leaseFor(context.job)
      const persisted = await this.#catalog.setTransformJobStagingKeys({
        ...lease,
        inputKey: source.key,
        outputKey: target.key,
      })
      if (!persisted) throw new Error('Worker staging keys lost their job lease')
      return {
        parameters: this.#parameters(context.job),
        inputs: [
          {
            name: 'input',
            readUrl: source.readUrl,
            mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE,
            size: source.size,
            digest: source.digest,
          },
        ],
        outputs: [
          {
            name: 'output',
            writeUrl: target.writeUrl,
            mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE,
            maxSize: target.maxSize,
          },
        ],
      }
    } catch (error) {
      if (created) {
        await Promise.allSettled([
          this.#staging.deleteExact({ ...ref, logicalName: 'input' }),
          this.#staging.deleteExact({ ...ref, logicalName: 'output' }),
        ])
      }
      throw error
    }
  }
}

export class WorkerStagingJobCleanerV1 implements WorkerJobCleaner {
  constructor(readonly staging: WorkerStagingStoreV1) {}

  async cleanup(context: WorkerCleanupContext): Promise<void> {
    const ref = { jobId: context.job.id, attempt: context.job.attempt }
    const results = await Promise.allSettled([
      this.staging.deleteExact({ ...ref, logicalName: 'input' }),
      this.staging.deleteExact({ ...ref, logicalName: 'output' }),
    ])
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Worker exact staging cleanup failed')
    }
  }
}

export class UnavailableWorkerJobCleaner implements WorkerJobCleaner {
  async cleanup(context: WorkerCleanupContext): Promise<void> {
    if (context.job.inputKey !== null || context.job.outputKey !== null) {
      throw new Error('Worker staging cleanup is not configured')
    }
  }
}

function leaseFor(job: CatalogTransformJobRowV2): TransformJobLeaseV2 {
  if (!job.leaseToken) throw new TypeError('Worker staging preparation requires an active lease')
  return { id: job.id, attempt: job.attempt, leaseToken: job.leaseToken }
}
