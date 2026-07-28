import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBackend } from '@/api/backend.js'
import {
  type CreateModelArtifactImportRequestV2,
  createModelArtifactImportV2,
  getModelArtifactImportV2,
  getModelArtifactV2,
  listModelArtifactsV2,
  listSwiftStudioOutputsV2,
  type ModelArtifactImportV2,
} from './artifacts.js'
import {
  type CreateSwiftStudioSessionRequestV2,
  closeSwiftStudioSessionV2,
  createSwiftStudioSessionV2,
  listSwiftStudioSessionsV2,
  type SwiftStudioSessionV2,
} from './sessions.js'

function sessionsKey(connectionScope: string, base: string) {
  return [connectionScope, base, 'swift-studio-sessions'] as const
}

function outputsKey(connectionScope: string, base: string, sessionId: string | null) {
  return [connectionScope, base, 'swift-studio-outputs', sessionId] as const
}

function artifactImportKey(connectionScope: string, base: string, importId: string | null) {
  return [connectionScope, base, 'model-artifact-import', importId] as const
}

function artifactsKey(connectionScope: string, base: string) {
  return [connectionScope, base, 'model-artifacts'] as const
}

export function useSwiftStudioSessions() {
  const { base, connectionScope, token } = useBackend()
  return useQuery({
    queryKey: sessionsKey(connectionScope, base),
    queryFn: ({ signal }) =>
      listSwiftStudioSessionsV2({ base, cursor: null, limit: 20, signal, token }),
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (session) => session.status === 'preparing' || session.status === 'closing',
      )
        ? 1_000
        : 10_000,
    retry: false,
  })
}

export function useCreateSwiftStudioSession() {
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: CreateSwiftStudioSessionRequestV2) =>
      createSwiftStudioSessionV2({ base, request, token }),
    onSuccess: async (session) => {
      await updateSessions(queryClient, sessionsKey(connectionScope, base), session)
    },
  })
}

export function useCloseSwiftStudioSession() {
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => closeSwiftStudioSessionV2({ base, sessionId, token }),
    onSuccess: async (session) => {
      await updateSessions(queryClient, sessionsKey(connectionScope, base), session)
    },
  })
}

export function useSwiftStudioOutputs(sessionId: string | null) {
  const { base, connectionScope, token } = useBackend()
  return useQuery({
    enabled: sessionId !== null,
    queryKey: outputsKey(connectionScope, base, sessionId),
    queryFn: ({ signal }) => {
      if (sessionId === null) throw new Error('A ready Studio Session is required')
      return listSwiftStudioOutputsV2({ base, sessionId, signal, token })
    },
    retry: false,
  })
}

export function useCreateModelArtifactImport() {
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: CreateModelArtifactImportRequestV2) =>
      createModelArtifactImportV2({ base, request, token }),
    onSuccess: async (artifactImport) => {
      queryClient.setQueryData(
        artifactImportKey(connectionScope, base, artifactImport.id),
        artifactImport,
      )
      if (artifactImport.status === 'completed') {
        await queryClient.invalidateQueries({ queryKey: artifactsKey(connectionScope, base) })
      }
    },
  })
}

export function useModelArtifactImport(importId: string | null) {
  const { base, connectionScope, token } = useBackend()
  return useQuery({
    enabled: importId !== null,
    queryKey: artifactImportKey(connectionScope, base, importId),
    queryFn: ({ signal }) => {
      if (importId === null) throw new Error('A Model Artifact import ID is required')
      return getModelArtifactImportV2({ base, importId, signal, token })
    },
    refetchInterval: (query) => (isArtifactImportActive(query.state.data) ? 1_000 : false),
    retry: false,
  })
}

export function useModelArtifacts() {
  const { base, connectionScope, token } = useBackend()
  return useQuery({
    queryKey: artifactsKey(connectionScope, base),
    queryFn: ({ signal }) => listModelArtifactsV2({ base, cursor: null, limit: 20, signal, token }),
    retry: false,
  })
}

export function useModelArtifact(artifactId: string | null) {
  const { base, connectionScope, token } = useBackend()
  return useQuery({
    enabled: artifactId !== null,
    queryKey: [connectionScope, base, 'model-artifact', artifactId],
    queryFn: ({ signal }) => {
      if (artifactId === null) throw new Error('A Model Artifact ID is required')
      return getModelArtifactV2({ artifactId, base, signal, token })
    },
    retry: false,
  })
}

export function isArtifactImportActive(artifactImport: ModelArtifactImportV2 | undefined): boolean {
  return (
    artifactImport !== undefined &&
    artifactImport.status !== 'completed' &&
    artifactImport.status !== 'failed'
  )
}

async function updateSessions(
  queryClient: ReturnType<typeof useQueryClient>,
  key: readonly string[],
  session: SwiftStudioSessionV2,
): Promise<void> {
  queryClient.setQueryData(key, (current: { items: SwiftStudioSessionV2[] } | undefined) => {
    if (current === undefined) return current
    return {
      ...current,
      items: [session, ...current.items.filter((item) => item.id !== session.id)],
    }
  })
  await queryClient.invalidateQueries({ queryKey: key })
}
