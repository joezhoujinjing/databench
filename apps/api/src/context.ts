import type { V2Workspace } from '@databench/workspace'
import type { Context } from 'hono'

export type ApiV2Workspace = Pick<
  V2Workspace,
  | 'addJsonl'
  | 'audit'
  | 'describeDataset'
  | 'export'
  | 'getConverter'
  | 'getRecordPage'
  | 'getRecordView'
  | 'getRef'
  | 'inspectExport'
  | 'lineage'
  | 'listConverters'
  | 'listRefs'
  | 'listTransforms'
  | 'materializeCanonicalDraftJsonl'
  | 'postTrainingV2Capability'
  | 'previewCanonicalJsonl'
  | 'previewCanonicalDraftJsonl'
  | 'putRef'
  | 'runTransform'
>

export interface ApiVariables {
  requestId: string
  v2Workspace: ApiV2Workspace
}

export interface ApiEnv {
  Variables: ApiVariables
}

export function getV2Workspace(context: Context<ApiEnv>): ApiV2Workspace {
  return context.get('v2Workspace')
}

export function getRequestId(context: Context<ApiEnv>): string {
  return context.get('requestId')
}
