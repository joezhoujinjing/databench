import { Workspace } from '@databench/workspace'
import { type GlobalFlags, workspaceOptions } from './config.js'

let injected: Workspace | null = null

// Test seam: run handlers against a supplied Workspace, skipping open/close so
// unit tests never touch Postgres or object storage.
export function setWorkspaceForTest(workspace: Workspace | null): void {
  injected = workspace
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
