import { useQuery } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { useBackend } from './backend.js'
import { queryKeys } from './hooks.js'
import { getCapabilities, getHealth, getVersion } from './meta.js'
import type { Capabilities, HealthInfo, VersionInfo } from './types.js'
import { type Compatibility, checkCompatibility } from './version.js'

export const FEATURES = {
  export: 'export',
  jsonlIngest: 'jsonl_ingest',
  lineage: 'lineage',
  recipes: 'recipes',
  transforms: 'transforms',
  vocabularies: 'vocabularies',
} as const

export type FeatureName = (typeof FEATURES)[keyof typeof FEATURES]

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
  const { base, token } = useBackend()
  const healthQuery = useQuery({
    queryFn: () => getHealth({ base, token }),
    queryKey: queryKeys.health(base),
    refetchInterval: 15_000,
    retry: false,
  })
  const capabilitiesQuery = useQuery({
    queryFn: () => getCapabilities({ base, token }),
    queryKey: queryKeys.capabilities(base),
    refetchInterval: 30_000,
    retry: false,
  })
  const versionQuery = useQuery({
    queryFn: () => getVersion({ base, token }),
    queryKey: queryKeys.version(base),
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

export function useFeature(feature: FeatureName): boolean {
  return isFeatureEnabled(useCapabilities().capabilities, feature)
}

export function useModuleEnabled(feature: FeatureName): boolean {
  return isModuleEnabled(useCapabilities().capabilities, feature)
}

export function isFeatureEnabled(
  capabilities: Capabilities | undefined,
  feature: FeatureName,
): boolean {
  return capabilities?.features[feature] ?? false
}

export function isModuleEnabled(
  capabilities: Capabilities | undefined,
  feature: FeatureName,
): boolean {
  if (capabilities === undefined) {
    return true
  }

  return capabilities.features[feature] !== false
}
