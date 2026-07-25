import type { WorkerDispatcherCatalog } from './dispatcher.js'

const catalogs = new WeakMap<object, object>()

export function registerWorkerCatalog(workspace: object, catalog: object): void {
  catalogs.set(workspace, catalog)
}

export function unregisterWorkerCatalog(workspace: object): void {
  catalogs.delete(workspace)
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
