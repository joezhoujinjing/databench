import { V2Workspace, Workspace } from '@databench/workspace'
import { type GlobalFlags, v2WorkspaceOptions, workspaceOptions } from './config.js'

let injected: Workspace | null = null
let injectedV2: V2Workspace | null = null

// Test seam: run handlers against a supplied Workspace, skipping open/close so
// unit tests never touch Postgres or object storage.
export function setWorkspaceForTest(workspace: Workspace | null): void {
  injected = workspace
}

export function setV2WorkspaceForTest(workspace: V2Workspace | null): void {
  injectedV2 = workspace
}

export async function withWorkspace<T>(
  flags: GlobalFlags,
  fn: (workspace: Workspace) => Promise<T>,
): Promise<T> {
  if (injected !== null) {
    return fn(injected)
  }

  const workspace = Workspace.open(workspaceOptions(flags))
  try {
    return await fn(workspace)
  } finally {
    // Close the Prisma connection so the one-shot process can exit.
    await workspace.close()
  }
}

export interface CliOperation {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}

export async function withV2Workspace<T>(
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
    workspace = injectedV2 ?? (await V2Workspace.open(v2WorkspaceOptions(flags)))
    return await fn(workspace, {
      signal: controller.signal,
      abort: (reason) => {
        controller.abort(reason)
      },
    })
  } finally {
    process.removeListener('SIGINT', abortForSignal)
    process.removeListener('SIGTERM', abortForSignal)
    if (injectedV2 === null) {
      await workspace?.close()
    }
  }
}
