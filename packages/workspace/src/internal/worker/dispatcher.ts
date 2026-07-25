import { randomUUID } from 'node:crypto'
import type {
  CatalogTransformJobErrorV2,
  CatalogTransformJobRowV2,
  ClaimTransformJobV2,
  FailTransformJobV2,
  SetTransformJobStagingKeysV2,
  TransformJobLeaseV2,
  UpdateTransformJobProgressV2,
} from '@databench/catalog'
import type {
  WorkerCapabilities,
  WorkerClient,
  WorkerJobEvent,
  WorkerOutputArtifact,
  WorkerRunJobRequest,
} from './client.js'

const DEFAULT_POLL_MS = 250
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_JOB_DEADLINE_MS = 15 * 60_000

export interface WorkerDispatcherCatalog {
  claimNextTransformJob(input: ClaimTransformJobV2): Promise<CatalogTransformJobRowV2 | null>
  renewTransformJobLease(input: TransformJobLeaseV2, leaseDurationMs: number): Promise<boolean>
  markTransformJobRunning(input: TransformJobLeaseV2): Promise<CatalogTransformJobRowV2 | null>
  updateTransformJobProgress(input: UpdateTransformJobProgressV2): Promise<boolean>
  markTransformJobFinalizing(input: TransformJobLeaseV2): Promise<CatalogTransformJobRowV2 | null>
  markTransformJobFailed(input: FailTransformJobV2): Promise<CatalogTransformJobRowV2 | null>
  markTransformJobCancelled(input: TransformJobLeaseV2): Promise<CatalogTransformJobRowV2 | null>
  requestTransformJobCancellation(id: string): Promise<CatalogTransformJobRowV2 | null>
  setTransformJobStagingKeys(input: SetTransformJobStagingKeysV2): Promise<boolean>
  clearTransformJobStagingKeys(input: TransformJobLeaseV2): Promise<boolean>
  clearTransformJobLeaseFence(input: TransformJobLeaseV2): Promise<boolean>
  failExpiredTransformJobLeases(): Promise<number>
  findTransformJobCleanupFence(): Promise<CatalogTransformJobRowV2 | null>
  getTransformJob(id: string): Promise<CatalogTransformJobRowV2 | null>
}

export interface WorkerPreparationContext {
  readonly job: CatalogTransformJobRowV2
  readonly executionId: string
  readonly signal: AbortSignal
  readonly deadlineUnixMs: number
}

export type PreparedWorkerRunJob = Omit<
  WorkerRunJobRequest,
  | 'executionId'
  | 'jobId'
  | 'attempt'
  | 'leaseToken'
  | 'capabilityName'
  | 'capabilityVersion'
  | 'deadlineUnixMs'
>

export interface WorkerJobPreparer {
  prepare(context: WorkerPreparationContext): Promise<PreparedWorkerRunJob>
}

export interface WorkerFinalizationContext {
  readonly job: CatalogTransformJobRowV2
  readonly lease: TransformJobLeaseV2
  readonly outputs: readonly WorkerOutputArtifact[]
  readonly signal: AbortSignal
}

/**
 * A finalizer owns the atomic Catalog completion transaction. Returning while
 * the job is still `finalizing` is treated as a failure, never as success.
 */
export interface WorkerJobFinalizer {
  finalize(context: WorkerFinalizationContext): Promise<void>
}

export interface WorkerCleanupContext {
  readonly job: CatalogTransformJobRowV2
  readonly lease: TransformJobLeaseV2
}

export interface WorkerJobCleaner {
  cleanup(context: WorkerCleanupContext): Promise<void>
}

export interface WorkerDispatcherOptions {
  readonly catalog: WorkerDispatcherCatalog
  readonly client: WorkerClient
  readonly preparer: WorkerJobPreparer
  readonly finalizer: WorkerJobFinalizer
  readonly cleaner: WorkerJobCleaner
  readonly leaseOwner?: string
  readonly leaseMs?: number
  readonly heartbeatMs?: number
  readonly pollMs?: number
  readonly jobDeadlineMs?: number
}

interface ActiveExecution {
  readonly job: CatalogTransformJobRowV2
  readonly lease: TransformJobLeaseV2
  readonly executionId: string
  readonly controller: AbortController
  renewing: boolean
  leaseFailure: unknown | null
}

export class WorkerDispatcher {
  readonly #catalog: WorkerDispatcherCatalog
  readonly #client: WorkerClient
  readonly #preparer: WorkerJobPreparer
  readonly #finalizer: WorkerJobFinalizer
  readonly #cleaner: WorkerJobCleaner
  readonly #claim: ClaimTransformJobV2
  readonly #heartbeatMs: number
  readonly #pollMs: number
  readonly #jobDeadlineMs: number
  readonly #loopController = new AbortController()
  #capabilities: WorkerCapabilities | null = null
  #active: ActiveExecution | null = null
  #loopPromise: Promise<void> | null = null
  #stopping = false

  constructor(options: WorkerDispatcherOptions) {
    this.#catalog = options.catalog
    this.#client = options.client
    this.#preparer = options.preparer
    this.#finalizer = options.finalizer
    this.#cleaner = options.cleaner
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.#jobDeadlineMs = options.jobDeadlineMs ?? DEFAULT_JOB_DEADLINE_MS
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 2 * this.#heartbeatMs) {
      throw new TypeError('Worker lease must be greater than two heartbeat intervals')
    }
    if (!Number.isSafeInteger(this.#heartbeatMs) || this.#heartbeatMs <= 0) {
      throw new TypeError('Worker heartbeat must be a positive safe integer')
    }
    if (!Number.isSafeInteger(this.#pollMs) || this.#pollMs <= 0) {
      throw new TypeError('Worker poll interval must be a positive safe integer')
    }
    if (!Number.isSafeInteger(this.#jobDeadlineMs) || this.#jobDeadlineMs <= 0) {
      throw new TypeError('Worker job deadline must be a positive safe integer')
    }
    this.#claim = {
      leaseOwner: options.leaseOwner ?? `api.${randomUUID()}`,
      leaseDurationMs: leaseMs,
    }
  }

  async start(): Promise<void> {
    if (this.#stopping) throw new Error('Worker dispatcher has already stopped')
    if (this.#loopPromise) return
    this.#capabilities = await this.#client.describeCapabilities()
    this.#loopPromise = this.#loop()
  }

  async stop(): Promise<void> {
    if (this.#stopping) return await (this.#loopPromise ?? Promise.resolve())
    this.#stopping = true
    const active = this.#active
    if (active) {
      await this.#catalog.requestTransformJobCancellation(active.job.id).catch(() => undefined)
      active.controller.abort(new Error('Worker dispatcher is stopping'))
    }
    this.#loopController.abort()
    await (this.#loopPromise ?? Promise.resolve())
  }

  supportsCapability(name: string, version: string): boolean {
    return this.#hasCapability(name, version)
  }

  async #loop(): Promise<void> {
    while (!this.#stopping) {
      const handled = await this.#runOnce().catch(() => false)
      if (!handled && !this.#stopping) {
        await waitFor(this.#pollMs, this.#loopController.signal)
      }
    }
  }

  async #runOnce(): Promise<boolean> {
    await this.#catalog.failExpiredTransformJobLeases()
    const fence = await this.#catalog.findTransformJobCleanupFence()
    if (fence) {
      await this.#drainFence(fence)
      return true
    }
    const job = await this.#catalog.claimNextTransformJob(this.#claim)
    if (!job) return false
    await this.#process(job)
    return true
  }

  async #process(job: CatalogTransformJobRowV2): Promise<void> {
    if (!job.leaseToken) return
    const lease = { id: job.id, attempt: job.attempt, leaseToken: job.leaseToken }
    const active: ActiveExecution = {
      job,
      lease,
      executionId: `${job.id}.${job.attempt}`,
      controller: new AbortController(),
      renewing: false,
      leaseFailure: null,
    }
    this.#active = active
    const renewTimer = setInterval(() => void this.#renew(active), this.#heartbeatMs)
    renewTimer.unref()
    try {
      if (!this.#hasCapability(job.capabilityName, job.capabilityVersion)) {
        await this.#fail(active, {
          code: 'capability_unavailable',
          message: 'Required Worker capability is unavailable',
          retryable: false,
        })
        return
      }
      const deadlineUnixMs = Date.now() + this.#jobDeadlineMs
      const prepared = await this.#preparer.prepare({
        job,
        executionId: active.executionId,
        signal: active.controller.signal,
        deadlineUnixMs,
      })
      this.#throwIfLeaseFailed(active)
      const request: WorkerRunJobRequest = {
        executionId: active.executionId,
        jobId: job.id,
        attempt: job.attempt,
        leaseToken: job.leaseToken,
        capabilityName: job.capabilityName,
        capabilityVersion: job.capabilityVersion,
        deadlineUnixMs,
        ...prepared,
      }
      let terminal = false
      for await (const event of this.#client.runJob(request, {
        signal: active.controller.signal,
        timeoutMs: this.#jobDeadlineMs,
      })) {
        terminal = await this.#handleEvent(active, event)
      }
      if (!terminal) throw new Error('Worker stream ended without a terminal event')
      this.#throwIfLeaseFailed(active)
    } catch (error) {
      await this.#handleExecutionError(active, error)
    } finally {
      clearInterval(renewTimer)
      if (this.#active === active) this.#active = null
      const current = await this.#catalog.getTransformJob(job.id).catch(() => null)
      if (current && (current.status === 'failed' || current.status === 'cancelled')) {
        await this.#drainFence(current).catch(() => undefined)
      }
    }
  }

  async #handleEvent(active: ActiveExecution, event: WorkerJobEvent): Promise<boolean> {
    this.#throwIfLeaseFailed(active)
    switch (event.type) {
      case 'accepted':
        return false
      case 'started':
        if (!(await this.#catalog.markTransformJobRunning(active.lease))) {
          throw new LeaseLostError()
        }
        return false
      case 'heartbeat':
        if (!(await this.#renewNow(active))) throw new LeaseLostError()
        return false
      case 'progress': {
        const updated = await this.#catalog.updateTransformJobProgress({
          ...active.lease,
          progress: {
            phase: event.phase,
            completedUnits: BigInt(event.completedUnits),
            totalUnits: event.totalUnits === undefined ? null : BigInt(event.totalUnits),
          },
        })
        if (!updated) throw new LeaseLostError()
        return false
      }
      case 'failed':
        await this.#fail(active, {
          code: safeCode(event.code),
          message: safeMessage(event.message),
          retryable: event.retryable,
        })
        return true
      case 'cancelled':
        await this.#catalog.markTransformJobCancelled(active.lease)
        return true
      case 'completed': {
        if (!(await this.#catalog.markTransformJobFinalizing(active.lease))) {
          throw new LeaseLostError()
        }
        await this.#finalizer.finalize({
          job: active.job,
          lease: active.lease,
          outputs: event.outputs,
          signal: active.controller.signal,
        })
        const completed = await this.#catalog.getTransformJob(active.job.id)
        if (completed?.status !== 'completed') {
          await this.#fail(active, {
            code: 'finalizer_incomplete',
            message: 'Worker output was not committed by the finalizer',
            retryable: false,
          })
        }
        return true
      }
    }
  }

  async #handleExecutionError(active: ActiveExecution, error: unknown): Promise<void> {
    const current = await this.#catalog.getTransformJob(active.job.id).catch(() => null)
    if (current?.status === 'cancelled' || this.#stopping) {
      await this.#catalog.markTransformJobCancelled(active.lease).catch(() => null)
      return
    }
    if (error instanceof LeaseLostError || active.leaseFailure !== null) return
    await this.#fail(active, {
      code: 'worker_execution_failed',
      message: 'Worker execution failed before a valid terminal result',
      retryable: false,
    })
  }

  async #fail(active: ActiveExecution, error: CatalogTransformJobErrorV2): Promise<void> {
    await this.#catalog.markTransformJobFailed({ ...active.lease, error })
  }

  async #renew(active: ActiveExecution): Promise<void> {
    if (active.renewing || active.controller.signal.aborted) return
    active.renewing = true
    try {
      if (!(await this.#renewNow(active))) {
        const current = await this.#catalog.getTransformJob(active.job.id)
        if (current?.status === 'completed' && current.attempt === active.lease.attempt) return
        throw new LeaseLostError()
      }
    } catch (error) {
      active.leaseFailure = error
      active.controller.abort(error)
    } finally {
      active.renewing = false
    }
  }

  async #renewNow(active: ActiveExecution): Promise<boolean> {
    return await this.#catalog.renewTransformJobLease(active.lease, this.#claim.leaseDurationMs)
  }

  #throwIfLeaseFailed(active: ActiveExecution): void {
    if (active.leaseFailure !== null) throw new LeaseLostError()
    active.controller.signal.throwIfAborted()
  }

  #hasCapability(name: string, version: string): boolean {
    return (
      this.#capabilities?.capabilities.some(
        (capability) => capability.name === name && capability.version === version,
      ) ?? false
    )
  }

  async #drainFence(job: CatalogTransformJobRowV2): Promise<void> {
    if (!job.leaseToken) return
    const lease = { id: job.id, attempt: job.attempt, leaseToken: job.leaseToken }
    const result = await this.#client.cancelJob({
      executionId: `${job.id}.${job.attempt}`,
      attempt: job.attempt,
      leaseToken: job.leaseToken,
    })
    if (result === 'stopped' || result === 'not_found') {
      await this.#cleaner.cleanup({ job, lease })
      if (!(await this.#catalog.clearTransformJobStagingKeys(lease))) {
        throw new LeaseLostError()
      }
      if (!(await this.#catalog.clearTransformJobLeaseFence(lease))) {
        throw new LeaseLostError()
      }
    }
  }
}

export class UnavailableWorkerJobPreparer implements WorkerJobPreparer {
  async prepare(_context: WorkerPreparationContext): Promise<PreparedWorkerRunJob> {
    throw new Error('Worker staging is not configured')
  }
}

export class IncompleteWorkerJobFinalizer implements WorkerJobFinalizer {
  async finalize(_context: WorkerFinalizationContext): Promise<void> {}
}

class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError'
}

function safeCode(value: string): string {
  return /^[a-z][a-z0-9._-]{0,127}$/.test(value) ? value : 'worker_failed'
}

function safeMessage(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 2_048 ? trimmed : 'Worker reported a failure'
}

async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
