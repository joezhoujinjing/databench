import { V2Workspace, type V2WorkspaceOpenOptions } from '@databench/workspace'
import type { MiddlewareHandler } from 'hono'
import type { ApiEnv, ApiV2Workspace } from '../context.js'

export interface V2WorkspaceMiddlewareOptions {
  readonly workspace?: ApiV2Workspace
  readonly workspaceOptions?: V2WorkspaceOpenOptions
}

export function createV2WorkspaceMiddleware(
  options: V2WorkspaceMiddlewareOptions,
): MiddlewareHandler<ApiEnv> {
  let workspacePromise =
    options.workspace === undefined ? undefined : Promise.resolve(options.workspace)
  const workspaceOptions = options.workspaceOptions
  if (workspacePromise === undefined && workspaceOptions === undefined) {
    throw new TypeError('V2 Workspace middleware requires a workspace or open options')
  }

  return async (context, next) => {
    const pending = workspacePromise ?? openV2Workspace(workspaceOptions)
    workspacePromise = pending
    let workspace: ApiV2Workspace
    try {
      workspace = await pending
    } catch (error) {
      // A transient dependency failure must not poison this process forever.
      workspacePromise = undefined
      throw error
    }
    context.set('v2Workspace', workspace)
    await next()
  }
}

function openV2Workspace(options: V2WorkspaceOpenOptions | undefined): Promise<V2Workspace> {
  if (options === undefined) {
    throw new TypeError('V2 Workspace open options are unavailable')
  }
  return V2Workspace.open(options)
}
