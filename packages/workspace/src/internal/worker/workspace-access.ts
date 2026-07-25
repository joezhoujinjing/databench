import type { CatalogTransformJobRowV2 } from '@databench/catalog'
import type { WorkerStagingStoreV1 } from '@databench/store'
import type { WorkerDispatcherCatalog, WorkerFinalizationContext } from './dispatcher.js'

const catalogs = new WeakMap<object, object>()
const operations = new WeakMap<object, WorkerWorkspaceOperationsV1>()

export interface WorkerWorkspaceOperationsV1 {
  projectInput(job: CatalogTransformJobRowV2, signal: AbortSignal): AsyncIterable<Uint8Array>
  finalize(context: WorkerFinalizationContext, staging: WorkerStagingStoreV1): Promise<void>
}

export function registerWorkerCatalog(workspace: object, catalog: object): void {
  catalogs.set(workspace, catalog)
}

export function unregisterWorkerCatalog(workspace: object): void {
  catalogs.delete(workspace)
}

export function registerWorkerWorkspaceOperations(
  workspace: object,
  value: WorkerWorkspaceOperationsV1,
): void {
  operations.set(workspace, value)
}

export function unregisterWorkerWorkspaceOperations(workspace: object): void {
  operations.delete(workspace)
}

export function workerWorkspaceOperationsFor(workspace: object): WorkerWorkspaceOperationsV1 {
  const value = operations.get(workspace)
  if (!value) throw new TypeError('Workspace does not provide Worker canonical operations')
  return value
}

export function workerCatalogFor(workspace: object): WorkerDispatcherCatalog {
  const catalog = catalogs.get(workspace)
  if (!catalog || !hasWorkerCatalogMethods(catalog)) {
    throw new TypeError('Workspace does not provide the Worker job control-plane Catalog')
  }
  return catalog
}

function hasWorkerCatalogMethods(value: object): value is WorkerDispatcherCatalog {
  const candidate = value as Record<string, unknown>
  return [
    'claimNextTransformJob',
    'renewTransformJobLease',
    'markTransformJobRunning',
    'updateTransformJobProgress',
    'markTransformJobFinalizing',
    'markTransformJobFailed',
    'markTransformJobCancelled',
    'requestTransformJobCancellation',
    'setTransformJobStagingKeys',
    'clearTransformJobStagingKeys',
    'clearTransformJobLeaseFence',
    'failExpiredTransformJobLeases',
    'findTransformJobCleanupFence',
    'getTransformJob',
  ].every((name) => typeof candidate[name] === 'function')
}
