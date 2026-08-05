import { isAbsolute } from 'node:path'
import { BadInputError } from '@databench/schema'
import type { V2WorkspaceOpenOptions } from '@databench/workspace'

// Global flags shared by every command. Output is always JSON per ADR-0007;
// `compact` only toggles single-line vs indented. `databaseUrl` overrides the
// env-derived DATABASE_URL that `V2Workspace.open()` reads on its own; the object
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
  const modelRepository = modelRepositoryOptionsFromEnv(process.env)
  return {
    cursorSecret,
    ...(process.env.DATABENCH_ROOT === undefined ? {} : { root: process.env.DATABENCH_ROOT }),
    ...(flags.databaseUrl !== undefined ? { databaseUrl: flags.databaseUrl } : {}),
    ...(modelRepository === undefined ? {} : { modelRepository }),
  }
}

function modelRepositoryOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): NonNullable<V2WorkspaceOpenOptions['modelRepository']> | undefined {
  const modeValue = env.DATABENCH_MODEL_REPOSITORY_MODE
  const configPath = env.DATABENCH_MODEL_REPOSITORY_CONFIG
  const timeoutValue = env.DATABENCH_MODEL_REPOSITORY_TIMEOUT_MS
  if (modeValue === undefined && configPath === undefined && timeoutValue === undefined) {
    return undefined
  }
  const mode = modeValue ?? 'offline'
  if (mode !== 'offline' && mode !== 'connected') {
    throw new BadInputError('DATABENCH_MODEL_REPOSITORY_MODE must be offline or connected')
  }
  if (configPath !== undefined && !isAbsolute(configPath)) {
    throw new BadInputError('DATABENCH_MODEL_REPOSITORY_CONFIG must be an absolute path')
  }
  let timeoutMs: number | undefined
  if (timeoutValue !== undefined) {
    timeoutMs = Number(timeoutValue)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new BadInputError('DATABENCH_MODEL_REPOSITORY_TIMEOUT_MS must be between 100 and 30000')
    }
  }
  return {
    mode,
    ...(configPath === undefined ? {} : { operatorConfigPath: configPath }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}
