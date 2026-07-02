import type { WorkspaceOpenOptions } from '@databench/workspace'

// Global flags shared by every command. Output is always JSON per ADR-0007;
// `compact` only toggles single-line vs indented. `databaseUrl` overrides the
// env-derived DATABASE_URL that `Workspace.open()` reads on its own; the object
// store is configured entirely via env (S3_* → `defaultStoreConfig`).
export interface GlobalFlags {
  readonly databaseUrl?: string
  readonly compact: boolean
}

export function workspaceOptions(flags: GlobalFlags): WorkspaceOpenOptions {
  return {
    ...(flags.databaseUrl !== undefined ? { databaseUrl: flags.databaseUrl } : {}),
  }
}
