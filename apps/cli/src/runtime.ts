import { V2Workspace } from '@databench/workspace'
import { type GlobalFlags, workspaceOptions } from './config.js'

let injected: V2Workspace | null = null

// Test seam: run handlers against a supplied Workspace, skipping open/close so
// unit tests never touch Postgres or object storage.
export function setWorkspaceForTest(workspace: V2Workspace | null): void {
  injected = workspace
}

export interface CliOperation {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}

export async function withWorkspace<T>(
  flags: GlobalFlags,
  fn: (workspace: V2Workspace, operation: CliOperation) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abortForSignal = () => {
    controller.abort(new DOMException('CLI operation was interrupted', 'AbortError'))
  }
  process.once('SIGINT', abortForSignal)
  process.once('SIGTERM', abortForSignal)

  let workspace: V2Workspace | undefined
  try {
    workspace = injected ?? (await V2Workspace.open(workspaceOptions(flags)))
    return await fn(workspace, {
      signal: controller.signal,
      abort: (reason) => {
        controller.abort(reason)
      },
    })
  } finally {
    process.removeListener('SIGINT', abortForSignal)
    process.removeListener('SIGTERM', abortForSignal)
    if (injected === null) {
      await workspace?.close()
    }
  }
}
