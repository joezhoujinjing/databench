import type { V2Workspace } from '../../v2/workspace.js'
import type { WorkerClient } from './client.js'
import {
  IncompleteWorkerJobFinalizer,
  UnavailableWorkerJobPreparer,
  WorkerDispatcher,
  type WorkerJobCleaner,
  type WorkerJobFinalizer,
  type WorkerJobPreparer,
} from './dispatcher.js'
import { GrpcWorkerClient } from './grpc-client.js'
import { UnavailableWorkerJobCleaner } from './staging.js'
import { workerCatalogFor } from './workspace-access.js'

export interface OpenWorkerRuntimeOptions {
  readonly workspace: V2Workspace
  readonly target: string
  readonly jobDeadlineMs?: number
  readonly leaseMs?: number
  readonly heartbeatMs?: number
  readonly terminalEofMs?: number
  readonly pollMs?: number
  readonly client?: WorkerClient
  readonly preparer?: WorkerJobPreparer
  readonly finalizer?: WorkerJobFinalizer
  readonly cleaner?: WorkerJobCleaner
}

export interface WorkerRuntime {
  start(): Promise<void>
  stop(): Promise<void>
}

export async function openWorkerRuntime(options: OpenWorkerRuntimeOptions): Promise<WorkerRuntime> {
  const client =
    options.client ??
    new GrpcWorkerClient({
      address: options.target,
      ...(options.jobDeadlineMs === undefined ? {} : { defaultTimeoutMs: options.jobDeadlineMs }),
      ...(options.terminalEofMs === undefined
        ? {}
        : { terminalEofTimeoutMs: options.terminalEofMs }),
    })
  const ownsClient = options.client === undefined
  try {
    const dispatcher = new WorkerDispatcher({
      catalog: workerCatalogFor(options.workspace),
      client,
      preparer: options.preparer ?? new UnavailableWorkerJobPreparer(),
      finalizer: options.finalizer ?? new IncompleteWorkerJobFinalizer(),
      cleaner: options.cleaner ?? new UnavailableWorkerJobCleaner(),
      ...(options.jobDeadlineMs === undefined ? {} : { jobDeadlineMs: options.jobDeadlineMs }),
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    })
    let stopped = false
    return {
      async start() {
        await dispatcher.start()
      },
      async stop() {
        if (stopped) return
        stopped = true
        try {
          await dispatcher.stop()
        } finally {
          if (ownsClient) client.close()
        }
      },
    }
  } catch (error) {
    if (ownsClient) client.close()
    throw error
  }
}
