import type { CatalogTransformJobRowV2 } from '@databench/catalog'
import type { WorkerStagingStoreV1 } from '@databench/store'
import type { WorkerFinalizationContext, WorkerJobFinalizer } from './dispatcher.js'
import type { WorkerStagingInputProjectorV1 } from './staging.js'
import { workerWorkspaceOperationsFor } from './workspace-access.js'

export class WorkerWorkspaceInputProjectorV1 implements WorkerStagingInputProjectorV1 {
  constructor(readonly workspace: object) {}

  project(job: CatalogTransformJobRowV2, signal: AbortSignal): AsyncIterable<Uint8Array> {
    return workerWorkspaceOperationsFor(this.workspace).projectInput(job, signal)
  }
}

export class WorkerCanonicalJobFinalizerV1 implements WorkerJobFinalizer {
  constructor(
    readonly workspace: object,
    readonly staging: WorkerStagingStoreV1,
  ) {}

  async finalize(context: WorkerFinalizationContext): Promise<void> {
    await workerWorkspaceOperationsFor(this.workspace).finalize(context, this.staging)
  }
}
