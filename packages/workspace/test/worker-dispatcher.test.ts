import type {
  CatalogTransformJobRowV2,
  ClaimTransformJobV2,
  FailTransformJobV2,
  SetTransformJobStagingKeysV2,
  TransformJobLeaseV2,
  UpdateTransformJobProgressV2,
} from '@databench/catalog'
import { describe, expect, test, vi } from 'vitest'
import type {
  WorkerCallOptions,
  WorkerCancelJobRequest,
  WorkerCancelResult,
  WorkerCapabilities,
  WorkerClient,
  WorkerJobEvent,
  WorkerRunJobRequest,
} from '../src/internal/worker/client.js'
import {
  IncompleteWorkerJobFinalizer,
  WorkerDispatcher,
  type WorkerDispatcherCatalog,
  type WorkerDispatcherDiagnostic,
  type WorkerDispatcherReporter,
  type WorkerJobCleaner,
  type WorkerJobFinalizer,
  type WorkerJobPreparer,
} from '../src/internal/worker/dispatcher.js'

const TOKEN = new Uint8Array(32).fill(7)
const SENSITIVE_ERROR =
  'signed=https://objects.example.test/input?token=secret-token lease=secret-lease sample=private'

describe('WorkerDispatcher', () => {
  test('maps Worker progress and an incomplete completion into a durable failed fence cleanup', async () => {
    const catalog = new FakeCatalog()
    const client = new FakeClient(async function* () {
      yield event('accepted')
      yield event('started')
      yield {
        type: 'progress',
        timestampUnixMs: Date.now(),
        phase: 'processing',
        completedUnits: 1,
        totalUnits: 2,
      }
      yield {
        type: 'completed',
        timestampUnixMs: Date.now(),
        outputs: [{ name: 'output', size: 1, digest: 'a'.repeat(64), recordCount: 1 }],
      }
    })
    const dispatcher = createDispatcher(catalog, client)

    await dispatcher.start()
    await waitUntil(() => catalog.row.status === 'failed' && catalog.row.leaseToken === null)
    await dispatcher.stop()

    expect(catalog.transitions).toEqual([
      'leased',
      'running',
      'progress:processing:1',
      'finalizing',
      'failed:finalizer_incomplete',
      'fence-cleared',
    ])
    expect(client.cancelJob).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: `${catalog.row.id}.1`, attempt: 1 }),
    )
  })

  test('fails abnormal EOF and never treats it as completion', async () => {
    const catalog = new FakeCatalog()
    const diagnostics: WorkerDispatcherDiagnostic[] = []
    const client = new FakeClient(async function* () {
      yield event('accepted')
      yield event('started')
      throw new Error(SENSITIVE_ERROR)
    })
    const dispatcher = createDispatcher(catalog, client, undefined, undefined, (diagnostic) =>
      diagnostics.push(diagnostic),
    )

    await dispatcher.start()
    await waitUntil(() => catalog.row.status === 'failed' && catalog.row.leaseToken === null)
    await dispatcher.stop()

    expect(catalog.transitions).toContain('failed:worker_execution_failed')
    expect(catalog.transitions).not.toContain('finalizing')
    expect(diagnostics).toContainEqual({
      level: 'error',
      code: 'worker_execution_failed',
      jobId: catalog.row.id,
      attempt: 1,
      errorName: 'Error',
    })
    expect(JSON.stringify(diagnostics)).not.toContain(SENSITIVE_ERROR)
  })

  test('reports dispatcher cycle failures without exposing error contents', async () => {
    const catalog = new FakeCatalog()
    vi.spyOn(catalog, 'failExpiredTransformJobLeases').mockRejectedValue(new Error(SENSITIVE_ERROR))
    const diagnostics: WorkerDispatcherDiagnostic[] = []
    const dispatcher = createDispatcher(
      catalog,
      new FakeClient(async function* () {}),
      undefined,
      undefined,
      (diagnostic) => diagnostics.push(diagnostic),
    )

    await dispatcher.start()
    await waitUntil(() => diagnostics.length > 0)
    await dispatcher.stop()

    expect(diagnostics[0]).toEqual({
      level: 'error',
      code: 'worker_dispatch_cycle_failed',
      errorName: 'Error',
    })
    expect(JSON.stringify(diagnostics)).not.toContain(SENSITIVE_ERROR)
  })

  test('fails a missing exact capability without dispatching a Worker run', async () => {
    const catalog = new FakeCatalog()
    const client = new FakeClient(async function* () {}, { capabilities: [] })
    const dispatcher = createDispatcher(catalog, client)

    await dispatcher.start()
    await waitUntil(() => catalog.row.status === 'failed' && catalog.row.leaseToken === null)
    await dispatcher.stop()

    expect(client.runJob).not.toHaveBeenCalled()
    expect(catalog.transitions).toContain('failed:capability_unavailable')
  })

  test('stops intake by cancelling and draining the current exact execution', async () => {
    const catalog = new FakeCatalog()
    let started = false
    const client = new FakeClient(
      async function* (_request, options) {
        yield event('accepted')
        yield event('started')
        started = true
        await waitForAbort(options?.signal)
        throw new Error('cancelled transport')
      },
      undefined,
      'stopped',
    )
    const dispatcher = createDispatcher(catalog, client)

    await dispatcher.start()
    await waitUntil(() => started)
    await dispatcher.stop()

    expect(catalog.row).toMatchObject({ status: 'cancelled', leaseToken: null })
    expect(catalog.transitions).toContain('cancel-requested')
    expect(catalog.transitions).toContain('fence-cleared')
  })

  test('deletes exact staging before clearing keys and the cleanup fence', async () => {
    const catalog = new FakeCatalog()
    catalog.row = {
      ...catalog.row,
      inputKey: `staging/worker/v1/${catalog.row.id}/1/input.jsonl`,
      outputKey: `staging/worker/v1/${catalog.row.id}/1/output.jsonl`,
    }
    const client = new FakeClient(async function* () {
      yield event('accepted')
      yield event('started')
      yield {
        type: 'failed',
        timestampUnixMs: Date.now(),
        code: 'fixture',
        message: 'x',
        retryable: false,
      }
    })
    const cleaner: WorkerJobCleaner = {
      async cleanup() {
        catalog.transitions.push('objects-deleted')
      },
    }
    const dispatcher = createDispatcher(catalog, client, cleaner)

    await dispatcher.start()
    await waitUntil(() => catalog.row.leaseToken === null)
    await dispatcher.stop()

    expect(catalog.transitions.slice(-3)).toEqual([
      'objects-deleted',
      'staging-cleared',
      'fence-cleared',
    ])
  })

  test('retains the cleanup fence when exact staging deletion fails', async () => {
    const catalog = new FakeCatalog()
    const diagnostics: WorkerDispatcherDiagnostic[] = []
    catalog.row = {
      ...catalog.row,
      inputKey: `staging/worker/v1/${catalog.row.id}/1/input.jsonl`,
      outputKey: `staging/worker/v1/${catalog.row.id}/1/output.jsonl`,
    }
    const client = new FakeClient(async function* () {
      yield {
        type: 'failed',
        timestampUnixMs: Date.now(),
        code: 'fixture',
        message: 'x',
        retryable: false,
      }
    })
    const cleaner: WorkerJobCleaner = {
      async cleanup() {
        throw new Error(SENSITIVE_ERROR)
      },
    }
    const dispatcher = createDispatcher(catalog, client, cleaner, undefined, (diagnostic) =>
      diagnostics.push(diagnostic),
    )

    await dispatcher.start()
    await waitUntil(() => catalog.row.status === 'failed')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    await dispatcher.stop()

    expect(catalog.row.leaseToken).toBe(TOKEN)
    expect(catalog.transitions).not.toContain('staging-cleared')
    expect(catalog.transitions).not.toContain('fence-cleared')
    expect(diagnostics).toContainEqual({
      level: 'error',
      code: 'worker_cleanup_fence_failed',
      jobId: catalog.row.id,
      attempt: 1,
      errorName: 'Error',
    })
    expect(JSON.stringify(diagnostics)).not.toContain(SENSITIVE_ERROR)
  })

  test('treats a cleanup token mismatch as a retryable diagnosed fence failure', async () => {
    const catalog = new FakeCatalog()
    catalog.row = {
      ...catalog.row,
      status: 'failed',
      attempt: 1,
      leaseOwner: 'dispatcher.test',
      leaseToken: TOKEN,
      leaseExpiresAt: new Date(Date.now() + 1_000),
      finishedAt: new Date(),
    }
    const diagnostics: WorkerDispatcherDiagnostic[] = []
    const client = new FakeClient(async function* () {}, undefined, 'token_mismatch')
    const dispatcher = createDispatcher(catalog, client, undefined, undefined, (diagnostic) =>
      diagnostics.push(diagnostic),
    )

    await dispatcher.start()
    await waitUntil(() => diagnostics.length > 0)
    await dispatcher.stop()

    expect(catalog.row.leaseToken).toBe(TOKEN)
    expect(diagnostics[0]).toEqual({
      level: 'error',
      code: 'worker_cleanup_fence_failed',
      jobId: catalog.row.id,
      attempt: 1,
      errorName: 'CleanupFenceTokenMismatchError',
    })
  })

  test('does not let reporter failures break durable failure and cleanup', async () => {
    const catalog = new FakeCatalog()
    const client = new FakeClient(async function* () {
      yield event('accepted')
      throw new Error('transport failed')
    })
    const dispatcher = createDispatcher(catalog, client, undefined, undefined, () => {
      throw new Error('reporter failed')
    })

    await dispatcher.start()
    await waitUntil(() => catalog.row.status === 'failed' && catalog.row.leaseToken === null)
    await dispatcher.stop()

    expect(catalog.transitions).toContain('failed:worker_execution_failed')
    expect(catalog.transitions).toContain('fence-cleared')
  })

  test('does not treat the expected completed lease clear as heartbeat lease loss', async () => {
    const catalog = new FakeCatalog()
    const client = new FakeClient(async function* () {
      yield event('accepted')
      yield event('started')
      yield {
        type: 'completed',
        timestampUnixMs: Date.now(),
        outputs: [{ name: 'output', size: 0, digest: 'a'.repeat(64), recordCount: 0 }],
      }
    })
    const finalizer: WorkerJobFinalizer = {
      async finalize() {
        catalog.completeForFinalizer()
        await new Promise<void>((resolve) => setTimeout(resolve, 60))
      },
    }
    const dispatcher = createDispatcher(catalog, client, undefined, finalizer)

    await dispatcher.start()
    await waitUntil(() => catalog.row.status === 'completed')
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    await dispatcher.stop()

    expect(catalog.transitions).toContain('completed')
    expect(catalog.transitions.some((transition) => transition.startsWith('failed:'))).toBe(false)
  })
})

function createDispatcher(
  catalog: FakeCatalog,
  client: FakeClient,
  cleaner: WorkerJobCleaner = { async cleanup() {} },
  finalizer: WorkerJobFinalizer = new IncompleteWorkerJobFinalizer(),
  reporter?: WorkerDispatcherReporter,
): WorkerDispatcher {
  const preparer: WorkerJobPreparer = {
    async prepare() {
      return {
        parameters: {
          schemaName: 'databench.worker.fixture-copy-parameters',
          schemaVersion: '1',
          utf8Json: new Uint8Array(),
        },
        inputs: [],
        outputs: [],
      }
    },
  }
  return new WorkerDispatcher({
    catalog,
    client,
    preparer,
    finalizer,
    cleaner,
    leaseOwner: 'dispatcher.test',
    leaseMs: 100,
    heartbeatMs: 20,
    pollMs: 1,
    jobDeadlineMs: 1_000,
    ...(reporter === undefined ? {} : { reporter }),
  })
}

class FakeCatalog implements WorkerDispatcherCatalog {
  row: CatalogTransformJobRowV2 = {
    id: `job_${'1'.repeat(64)}`,
    cacheKey: '1'.repeat(64),
    op: 'fixture-copy',
    opVersion: '1',
    params: {},
    inputVersion: '2'.repeat(64),
    capabilityName: 'fixture.copy',
    capabilityVersion: '1',
    inputCount: 1n,
    status: 'queued',
    attempt: 0,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    progress: null,
    inputKey: null,
    outputKey: null,
    outputCount: null,
    outputVersion: null,
    cacheHit: false,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(),
  }
  readonly transitions: string[] = []

  async claimNextTransformJob(input: ClaimTransformJobV2) {
    if (this.row.status !== 'queued') return null
    this.row = {
      ...this.row,
      status: 'leased',
      attempt: this.row.attempt + 1,
      leaseOwner: input.leaseOwner,
      leaseToken: TOKEN,
      leaseExpiresAt: new Date(Date.now() + input.leaseDurationMs),
    }
    this.transitions.push('leased')
    return this.row
  }

  async renewTransformJobLease(input: TransformJobLeaseV2) {
    return this.active(input)
  }

  async markTransformJobRunning(input: TransformJobLeaseV2) {
    if (!this.active(input) || this.row.status !== 'leased') return null
    this.row = { ...this.row, status: 'running', startedAt: new Date() }
    this.transitions.push('running')
    return this.row
  }

  async updateTransformJobProgress(input: UpdateTransformJobProgressV2) {
    if (!this.active(input) || this.row.status !== 'running') return false
    this.row = { ...this.row, progress: input.progress }
    this.transitions.push(`progress:${input.progress.phase}:${input.progress.completedUnits}`)
    return true
  }

  async setTransformJobStagingKeys(input: SetTransformJobStagingKeysV2) {
    if (!this.active(input) || this.row.status !== 'leased') return false
    this.row = { ...this.row, inputKey: input.inputKey, outputKey: input.outputKey }
    return true
  }

  async markTransformJobFinalizing(input: TransformJobLeaseV2) {
    if (!this.active(input) || this.row.status !== 'running') return null
    this.row = { ...this.row, status: 'finalizing' }
    this.transitions.push('finalizing')
    return this.row
  }

  async markTransformJobFailed(input: FailTransformJobV2) {
    if (!this.active(input) || !['leased', 'running', 'finalizing'].includes(this.row.status)) {
      return null
    }
    this.row = { ...this.row, status: 'failed', error: input.error, finishedAt: new Date() }
    this.transitions.push(`failed:${input.error.code}`)
    return this.row
  }

  async markTransformJobCancelled(input: TransformJobLeaseV2) {
    if (!this.active(input) || !['leased', 'running', 'finalizing'].includes(this.row.status)) {
      return null
    }
    this.row = { ...this.row, status: 'cancelled', finishedAt: new Date() }
    this.transitions.push('cancelled')
    return this.row
  }

  async requestTransformJobCancellation(id: string) {
    if (id !== this.row.id) return null
    if (['queued', 'leased', 'running', 'finalizing'].includes(this.row.status)) {
      this.row = { ...this.row, status: 'cancelled', finishedAt: new Date() }
      this.transitions.push('cancel-requested')
    }
    return this.row
  }

  async clearTransformJobLeaseFence(input: TransformJobLeaseV2) {
    if (!this.active(input) || !['failed', 'cancelled'].includes(this.row.status)) return false
    this.row = { ...this.row, leaseOwner: null, leaseToken: null, leaseExpiresAt: null }
    this.transitions.push('fence-cleared')
    return true
  }

  async clearTransformJobStagingKeys(input: TransformJobLeaseV2) {
    if (!this.active(input) || !['failed', 'cancelled'].includes(this.row.status)) return false
    if (this.row.inputKey !== null || this.row.outputKey !== null) {
      this.transitions.push('staging-cleared')
    }
    this.row = { ...this.row, inputKey: null, outputKey: null }
    return true
  }

  async failExpiredTransformJobLeases() {
    return 0
  }

  async findTransformJobCleanupFence() {
    return this.row.leaseToken && ['failed', 'cancelled'].includes(this.row.status)
      ? this.row
      : null
  }

  async getTransformJob(id: string) {
    return id === this.row.id ? this.row : null
  }

  completeForFinalizer(): void {
    this.row = {
      ...this.row,
      status: 'completed',
      outputCount: 0n,
      outputVersion: '3'.repeat(64),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      finishedAt: new Date(),
    }
    this.transitions.push('completed')
  }

  private active(input: TransformJobLeaseV2): boolean {
    return (
      input.id === this.row.id &&
      input.attempt === this.row.attempt &&
      this.row.leaseToken === input.leaseToken
    )
  }
}

class FakeClient implements WorkerClient {
  readonly runJob = vi.fn(
    (request: WorkerRunJobRequest, options?: WorkerCallOptions): AsyncIterable<WorkerJobEvent> =>
      this.stream(request, options),
  )
  readonly cancelJob = vi.fn(
    async (
      _request: WorkerCancelJobRequest,
      _options?: WorkerCallOptions,
    ): Promise<WorkerCancelResult> => this.cancelResult,
  )

  constructor(
    readonly stream: (
      request: WorkerRunJobRequest,
      options?: WorkerCallOptions,
    ) => AsyncIterable<WorkerJobEvent>,
    readonly capabilities: WorkerCapabilities = {
      workerVersion: 'test',
      capabilities: [
        {
          name: 'fixture.copy',
          version: '1',
          mode: 'batch',
          parameterSchemaName: 'databench.worker.fixture-copy-parameters',
          parameterSchemaVersion: '1',
          inputs: [],
          outputs: [],
        },
      ],
    },
    readonly cancelResult: WorkerCancelResult = 'not_found',
  ) {}

  async describeCapabilities() {
    return this.capabilities
  }

  close() {}
}

function event(type: 'accepted' | 'started'): WorkerJobEvent {
  return { type, timestampUnixMs: Date.now() }
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  )
}
