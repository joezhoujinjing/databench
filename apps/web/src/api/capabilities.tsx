import { useQuery } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { useBackend } from './backend.js'
import { getCapabilities, getHealth, getVersion } from './meta.js'
import type { Capabilities, HealthInfo, VersionInfo } from './types.js'
import { type Compatibility, checkCompatibility } from './version.js'

const metaQueryKeys = {
  capabilities: (scope: string, base: string) => [scope, base, 'capabilities'] as const,
  health: (scope: string, base: string) => [scope, base, 'health'] as const,
  version: (scope: string, base: string) => [scope, base, 'version'] as const,
} as const

interface CapabilitiesContextValue {
  capabilities: Capabilities | undefined
  compatibility: Compatibility
  error: unknown
  health: HealthInfo | undefined
  healthError: unknown
  isHealthError: boolean
  isHealthLoading: boolean
  isError: boolean
  isLoading: boolean
  ready: boolean
  refetch(): void
  version: VersionInfo | undefined
}

const CapabilitiesContext = createContext<CapabilitiesContextValue | null>(null)

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const { base, connectionScope, token } = useBackend()
  const healthQuery = useQuery({
    queryFn: ({ signal }) => getHealth({ base, signal, token }),
    queryKey: metaQueryKeys.health(connectionScope, base),
    refetchInterval: 15_000,
    retry: false,
  })
  const capabilitiesQuery = useQuery({
    queryFn: ({ signal }) => getCapabilities({ base, signal, token }),
    queryKey: metaQueryKeys.capabilities(connectionScope, base),
    refetchInterval: 30_000,
    retry: false,
  })
  const versionQuery = useQuery({
    queryFn: ({ signal }) => getVersion({ base, signal, token }),
    queryKey: metaQueryKeys.version(connectionScope, base),
    retry: false,
  })
  const compatibility = checkCompatibility(capabilitiesQuery.data)
  const value = useMemo<CapabilitiesContextValue>(
    () => ({
      capabilities: capabilitiesQuery.data,
      compatibility,
      error: capabilitiesQuery.error ?? healthQuery.error ?? versionQuery.error,
      health: healthQuery.data,
      healthError: healthQuery.error,
      isError: capabilitiesQuery.isError || healthQuery.isError,
      isHealthError: healthQuery.isError,
      isHealthLoading: healthQuery.isLoading,
      isLoading: capabilitiesQuery.isLoading,
      ready:
        compatibility.status === 'ok' &&
        capabilitiesQuery.data !== undefined &&
        !healthQuery.isError,
      refetch() {
        void healthQuery.refetch()
        void capabilitiesQuery.refetch()
        void versionQuery.refetch()
      },
      version: versionQuery.data,
    }),
    [capabilitiesQuery, compatibility, healthQuery, versionQuery],
  )

  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>
}

export function useCapabilities(): CapabilitiesContextValue {
  const value = useContext(CapabilitiesContext)

  if (value === null) {
    throw new Error('useCapabilities must be used within CapabilitiesProvider')
  }

  return value
}
