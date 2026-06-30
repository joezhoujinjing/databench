import { Workspace, type WorkspaceOpenOptions } from '@databench/workspace'
import type { MiddlewareHandler } from 'hono'
import type { ApiEnv } from '../context.js'

export interface WorkspaceMiddlewareOptions {
  readonly workspace?: Workspace
  readonly workspaceOptions?: WorkspaceOpenOptions
}

export function createWorkspaceMiddleware(
  options: WorkspaceMiddlewareOptions = {},
): MiddlewareHandler<ApiEnv> {
  let workspace = options.workspace ?? null

  return async (context, next) => {
    workspace ??= Workspace.open(options.workspaceOptions ?? {})
    context.set('workspace', workspace)
    await next()
  }
}
