import { getRouteApi } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { PageHeader } from '@/components/ui/surface.js'
import { EVALSCOPE_CLIENT_CONFIG } from '../api/config.js'

const routeApi = getRouteApi('/evaluations/viewer')

export function EvaluationViewerRoute() {
  const { t } = useTranslation()
  const { document } = routeApi.useSearch()
  if (document === undefined) {
    return <Alert role="alert">{t('evaluations.foundation.viewerDocumentRequired')}</Alert>
  }
  return (
    <div className="space-y-5">
      <PageHeader title={t('evaluations.foundation.pages.viewer')} />
      <iframe
        className="min-h-[70svh] w-full rounded-[6px] border border-border bg-white"
        sandbox="allow-scripts"
        src={`${EVALSCOPE_CLIENT_CONFIG.gatewayBase}/generated-documents/${document}`}
        title={t('evaluations.foundation.pages.viewer')}
      />
    </div>
  )
}
