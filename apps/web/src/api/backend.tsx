import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'
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
  setBase(nextBase: string): void
  setConnection(nextBase: string, nextToken: string): void
  setToken(nextToken: string): void
  token: string
}

const BackendContext = createContext<BackendContextValue | null>(null)

export function BackendProvider({ children }: { children: ReactNode }) {
  const [base, setBaseState] = useState(() => normalizeApiBase(getApiBaseUrl()))
  const [token, setTokenState] = useState(() => getStoredToken(base))

  const value = useMemo<BackendContextValue>(
    () => ({
      base,
      setBase(nextBase: string) {
        const normalized = setStoredApiBase(nextBase)
        setBaseState(normalized)
        setTokenState(getStoredToken(normalized))
      },
      setConnection(nextBase: string, nextToken: string) {
        const next = setStoredConnection(nextBase, nextToken)
        setBaseState(next.base)
        setTokenState(next.token)
      },
      setToken(nextToken: string) {
        const trimmed = setStoredToken(base, nextToken)
        setTokenState(trimmed)
      },
      token,
    }),
    [base, token],
  )

  return <BackendContext.Provider value={value}>{children}</BackendContext.Provider>
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
