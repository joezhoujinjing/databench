import { BadInputError } from '@databench/schema'
import type { V2WorkspaceOpenOptions } from '@databench/workspace'

// Global flags shared by every command. Output is always JSON per ADR-0007;
// `compact` only toggles single-line vs indented. `databaseUrl` overrides the
// env-derived DATABASE_URL that `Workspace.open()` reads on its own; the object
// store is configured entirely via env (`DATABENCH_OBJECT_STORE`, OSS_* or S3_*).
export interface GlobalFlags {
  readonly databaseUrl?: string
  readonly compact: boolean
}

export function workspaceOptions(flags: GlobalFlags): V2WorkspaceOpenOptions {
  const cursorSecret = process.env.DATABENCH_V2_CURSOR_SECRET
  if (cursorSecret === undefined || cursorSecret.length < 16) {
    throw new BadInputError('DATABENCH_V2_CURSOR_SECRET must be set to at least 16 characters')
  }
  return {
    cursorSecret,
    ...(process.env.DATABENCH_ROOT === undefined ? {} : { root: process.env.DATABENCH_ROOT }),
    ...(flags.databaseUrl !== undefined ? { databaseUrl: flags.databaseUrl } : {}),
  }
}
