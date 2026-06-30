import type { Workspace } from '@databench/workspace'
import type { Context } from 'hono'

export interface ApiVariables {
  workspace: Workspace
}

export interface ApiEnv {
  Variables: ApiVariables
}

export function getWorkspace(context: Context<ApiEnv>): Workspace {
  return context.get('workspace')
}
