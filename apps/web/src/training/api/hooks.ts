import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBackend } from '@/api/backend.js'
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
