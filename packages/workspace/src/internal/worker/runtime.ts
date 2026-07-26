import {
  createV2ObjectStore,
  type V2ObjectStoreConfig,
  WorkerStagingStoreV1,
} from '@databench/store'
import { type V2Workspace, v2WorkspaceTempRoot } from '../../v2/workspace.js'
import {
  WorkerCanonicalJobFinalizerV1,
  WorkerWorkspaceInputProjectorV1,
} from './canonical-finalizer.js'
import type { WorkerClient } from './client.js'
import { compileBasicCleanWorkerParametersV1 } from './data-juicer.js'
import {
  IncompleteWorkerJobFinalizer,
  UnavailableWorkerJobPreparer,
  WorkerDispatcher,
  type WorkerDispatcherDiagnostic,
  type WorkerDispatcherReporter,
  type WorkerJobCleaner,
  type WorkerJobFinalizer,
  type WorkerJobPreparer,
} from './dispatcher.js'
import { GrpcWorkerClient } from './grpc-client.js'
import {
  UnavailableWorkerJobCleaner,
  WorkerStagingJobCleanerV1,
  WorkerStagingJobPreparerV1,
} from './staging.js'
import { workerCatalogFor } from './workspace-access.js'

export interface OpenWorkerRuntimeOptions {
  readonly workspace: V2Workspace
  readonly target: string
  readonly storeConfig?: V2ObjectStoreConfig
  readonly workspaceRoot?: string
  readonly signedUrlTtlMs?: number
  readonly staging?: WorkerStagingStoreV1
  readonly jobDeadlineMs?: number
  readonly leaseMs?: number
  readonly heartbeatMs?: number
  readonly terminalEofMs?: number
  readonly pollMs?: number
  readonly client?: WorkerClient
  readonly preparer?: WorkerJobPreparer
  readonly finalizer?: WorkerJobFinalizer
  readonly cleaner?: WorkerJobCleaner
  readonly reporter?: WorkerDispatcherReporter
}

export interface WorkerRuntime {
  start(): Promise<void>
  stop(): Promise<void>
  supportsCapability(name: string, version: string): boolean
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
    const catalog = workerCatalogFor(options.workspace)
    const needsDefaultStaging =
      options.preparer === undefined ||
      options.finalizer === undefined ||
      options.cleaner === undefined
    let staging = options.staging
    if (needsDefaultStaging && staging === undefined) {
      if (options.storeConfig === undefined || options.signedUrlTtlMs === undefined) {
        throw new TypeError(
          'Worker runtime storeConfig and signedUrlTtlMs are required for default staging',
        )
      }
      staging = new WorkerStagingStoreV1({
        objectStore: createV2ObjectStore(options.storeConfig),
        tempRoot: v2WorkspaceTempRoot(options.workspaceRoot),
        signedUrlTtlMs: options.signedUrlTtlMs,
      })
    }
    const defaultStaging = staging
    const dispatcher = new WorkerDispatcher({
      catalog,
      client,
      preparer:
        options.preparer ??
        (defaultStaging === undefined
          ? new UnavailableWorkerJobPreparer()
          : new WorkerStagingJobPreparerV1({
              catalog,
              staging: defaultStaging,
              projector: new WorkerWorkspaceInputProjectorV1(options.workspace),
              parameters: compileBasicCleanWorkerParametersV1,
            })),
      finalizer:
        options.finalizer ??
        (defaultStaging === undefined
          ? new IncompleteWorkerJobFinalizer()
          : new WorkerCanonicalJobFinalizerV1(options.workspace, defaultStaging)),
      cleaner:
        options.cleaner ??
        (defaultStaging === undefined
          ? new UnavailableWorkerJobCleaner()
          : new WorkerStagingJobCleanerV1(defaultStaging)),
      ...(options.jobDeadlineMs === undefined ? {} : { jobDeadlineMs: options.jobDeadlineMs }),
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      reporter: options.reporter ?? reportWorkerDispatcherDiagnostic,
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
      supportsCapability(name, version) {
        return dispatcher.supportsCapability(name, version)
      },
    }
  } catch (error) {
    if (ownsClient) client.close()
    throw error
  }
}

function reportWorkerDispatcherDiagnostic(event: WorkerDispatcherDiagnostic): void {
  process.stderr.write(`${JSON.stringify({ component: 'worker_dispatcher', ...event })}\n`)
}
