import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBackend } from '@/api/backend.js'
import {
  type CreateModelDeploymentRequestV2,
  checkModelDeploymentV2,
  createModelDeploymentV2,
  disableModelDeploymentV2,
  listDeploymentEvaluationRunsV2,
  listModelDeploymentsV2,
  type ModelDeploymentV2,
} from './deployments.js'

function deploymentsKey(connectionScope: string, base: string) {
  return [connectionScope, base, 'model-deployments'] as const
}

export function useModelDeployments(
  options: { readonly artifactId?: string; readonly status?: ModelDeploymentV2['status'] } = {},
) {
  const { base, connectionScope, token } = useBackend()
  return useQuery({
    queryKey: [...deploymentsKey(connectionScope, base), options.artifactId, options.status],
    queryFn: ({ signal }) =>
      listModelDeploymentsV2({
        base,
        cursor: null,
        limit: 100,
        signal,
        token,
        ...(options.artifactId === undefined ? {} : { artifactId: options.artifactId }),
        ...(options.status === undefined ? {} : { status: options.status }),
      }),
    retry: false,
  })
}

export function useCreateModelDeployment() {
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: CreateModelDeploymentRequestV2) =>
      createModelDeploymentV2({ base, request, token }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: deploymentsKey(connectionScope, base) })
    },
  })
}

export function useCheckModelDeployment() {
  return useDeploymentAction(checkModelDeploymentV2)
}

export function useDisableModelDeployment() {
  return useDeploymentAction(disableModelDeploymentV2)
}

export function useDeploymentEvaluationRuns(deploymentId: string, enabled: boolean) {
  const { base, connectionScope, token } = useBackend()
  return useQuery({
    enabled,
    queryKey: [connectionScope, base, 'evaluation-runs', 'model-deployment', deploymentId],
    queryFn: ({ signal }) =>
      listDeploymentEvaluationRunsV2({
        base,
        cursor: null,
        deploymentId,
        limit: 20,
        signal,
        token,
      }),
    retry: false,
  })
}

function useDeploymentAction(
  action: typeof checkModelDeploymentV2 | typeof disableModelDeploymentV2,
) {
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (deploymentId: string) => action({ base, deploymentId, token }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: deploymentsKey(connectionScope, base) })
    },
  })
}
