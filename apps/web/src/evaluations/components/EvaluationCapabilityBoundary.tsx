import { useQuery } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { evalScopeClient } from '../api/client.js'
import { isEvalScopeApiError } from '../api/errors.js'
import type { EvalScopePublicConfig } from '../api/schemas.js'
import { EvaluationRoutePending } from '../routes/route-state.js'

const REQUIRED_CAPABILITIES = [
  'evaluation',
  'performance',
  'reports',
  'generated-documents',
] as const

type EvaluationServiceContextValue = {
  readonly config: EvalScopePublicConfig
  refresh(): Promise<unknown>
}

const EvaluationServiceContext = createContext<EvaluationServiceContextValue | null>(null)

export function EvaluationCapabilityBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['evalscope', 'public-config'],
    queryFn: ({ signal }) => evalScopeClient.request('config', { signal }),
    refetchInterval: 30_000,
    retry: false,
  })

  const missing = REQUIRED_CAPABILITIES.filter(
    (capability) => !query.data?.capabilities.includes(capability),
  )
  const context = useMemo<EvaluationServiceContextValue | null>(
    () =>
      query.data === undefined
        ? null
        : {
            config: query.data,
            refresh: () => query.refetch(),
          },
    [query.data, query.refetch],
  )

  if (query.isLoading) return <EvaluationRoutePending />
  if (query.error !== null || context === null) {
    const unavailable =
      isEvalScopeApiError(query.error) &&
      ['network', 'unavailable', 'http-5xx'].includes(query.error.kind)
    return (
      <Alert className="border-warning/40 bg-warning/8 py-6" role="alert">
        <h2 className="font-semibold text-lg">
          {t(
            unavailable
              ? 'evaluations.foundation.serviceUnavailable'
              : 'evaluations.foundation.serviceInvalid',
          )}
        </h2>
        <p className="mt-2 max-w-3xl text-muted-foreground leading-6">
          {t(
            unavailable
              ? 'evaluations.foundation.serviceUnavailableDescription'
              : 'evaluations.foundation.serviceInvalidDescription',
          )}
        </p>
        <Button className="mt-4" onClick={() => void query.refetch()} size="sm" variant="outline">
          {t('evaluations.foundation.retry')}
        </Button>
      </Alert>
    )
  }
  if (missing.length > 0) {
    return (
      <Alert className="border-warning/40 bg-warning/8" role="alert">
        <strong>{t('evaluations.foundation.capabilityUnavailable')}</strong>
        <span className="ml-2 text-muted-foreground">{missing.join(', ')}</span>
      </Alert>
    )
  }
  return (
    <EvaluationServiceContext.Provider value={context}>
      {children}
    </EvaluationServiceContext.Provider>
  )
}

export function useEvaluationService(): EvaluationServiceContextValue {
  const value = useContext(EvaluationServiceContext)
  if (value === null) {
    throw new Error('useEvaluationService must be used within EvaluationCapabilityBoundary')
  }
  return value
}
