import { type Query, type QueryClient, useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import {
  getApiBaseUrl,
  getStoredToken,
  normalizeApiBase,
  setStoredApiBase,
  setStoredConnection,
  setStoredToken,
} from './config.js'

interface BackendContextValue {
  base: string
  connectionScope: string
  setBase(nextBase: string): void
  setConnection(nextBase: string, nextToken: string): void
  setToken(nextToken: string): void
  token: string
}

let connectionGeneration = 0

const BackendContext = createContext<BackendContextValue | null>(null)

export function BackendProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [base, setBaseState] = useState(() => normalizeApiBase(getApiBaseUrl()))
  const [token, setTokenState] = useState(() => getStoredToken(base))
  const [connectionScope, setConnectionScope] = useState(createConnectionScope)

  const switchConnection = useCallback(
    (nextBase: string, nextToken: string): void => {
      if (nextBase === base && nextToken === token) {
        return
      }

      clearPrivateConnectionQueries(queryClient, base, connectionScope)
      setConnectionScope(createConnectionScope())
      setBaseState(nextBase)
      setTokenState(nextToken)
    },
    [base, connectionScope, queryClient, token],
  )

  const value = useMemo<BackendContextValue>(
    () => ({
      base,
      connectionScope,
      setBase(nextBase: string) {
        const normalized = setStoredApiBase(nextBase)
        switchConnection(normalized, getStoredToken(normalized))
      },
      setConnection(nextBase: string, nextToken: string) {
        const next = setStoredConnection(nextBase, nextToken)
        switchConnection(next.base, next.token)
      },
      setToken(nextToken: string) {
        const trimmed = setStoredToken(base, nextToken)
        switchConnection(base, trimmed)
      },
      token,
    }),
    [base, connectionScope, switchConnection, token],
  )

  return <BackendContext.Provider value={value}>{children}</BackendContext.Provider>
}

export function createConnectionScope(): string {
  connectionGeneration += 1
  return `connection-${connectionGeneration}`
}

export function clearPrivateConnectionQueries(
  queryClient: QueryClient,
  base: string,
  connectionScope: string,
): void {
  const predicate = (query: Query) => {
    const first = query.queryKey[0]
    return first === connectionScope || first === base
  }

  const cancellation = queryClient.cancelQueries({ predicate })
  queryClient.removeQueries({ predicate })
  void cancellation.finally(() => queryClient.removeQueries({ predicate }))
}

export function useBackend(): BackendContextValue {
  const value = useContext(BackendContext)

  if (value === null) {
    throw new Error('useBackend must be used within BackendProvider')
  }

  return value
}

export function useBackendKey(): string {
  return useBackend().base
}
