import type { V2Workspace } from '@databench/workspace'
import type { Context } from 'hono'

export type ApiV2Workspace = Pick<
  V2Workspace,
  | 'addCanonicalDraftJsonl'
  | 'addJsonl'
  | 'audit'
  | 'cancelTransformJob'
  | 'cancelEvaluationRun'
  | 'completeEvaluationRun'
  | 'createEvaluationRun'
  | 'createSwiftStudioSession'
  | 'createModelArtifactImport'
  | 'createModelDeployment'
  | 'createBasicCleanJob'
  | 'deleteRef'
  | 'describeDataset'
  | 'export'
  | 'getConverter'
  | 'getEvaluationRun'
  | 'getSwiftStudioSession'
  | 'getModelArtifactImport'
  | 'getModelArtifact'
  | 'getModelDeployment'
  | 'getDeletedRef'
  | 'getRecordPage'
  | 'getRecordView'
  | 'getTransformJob'
  | 'getRef'
  | 'inspectExport'
  | 'inspectModelRegistration'
  | 'lineage'
  | 'listConverters'
  | 'listDeletedRefs'
  | 'listEvaluationRuns'
  | 'listSwiftStudioSessions'
  | 'listSwiftStudioOutputs'
  | 'listModelArtifacts'
  | 'listModelDeployments'
  | 'listModels'
  | 'getModel'
  | 'updateModel'
  | 'archiveModel'
  | 'listModelVersions'
  | 'getModelVersion'
  | 'listModelAliases'
  | 'moveCandidateModelAlias'
  | 'adoptModelDeployment'
  | 'commitModelRegistration'
  | 'listRefs'
  | 'listTransforms'
  | 'listTransformJobs'
  | 'materializeCanonicalDraftJsonl'
  | 'postTrainingV2Capability'
  | 'previewExport'
  | 'previewCanonicalJsonl'
  | 'previewCanonicalDraftJsonl'
  | 'putRef'
  | 'runTransform'
  | 'restoreRef'
  | 'failEvaluationRun'
  | 'failEvaluationResultUpload'
  | 'finalizeEvaluationResultUpload'
  | 'prepareEvaluationResultUpload'
  | 'retryTransformJob'
  | 'startEvaluationRun'
  | 'closeSwiftStudioSession'
  | 'downloadModelArtifact'
  | 'disableModelDeployment'
  | 'checkModelDeployment'
  | 'resolveModelDeployment'
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
