import { getRouteApi } from '@tanstack/react-router'
import { ExternalLink, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { PageHeader } from '@/components/ui/surface.js'
import { EVALSCOPE_CLIENT_CONFIG } from '../api/config.js'

const routeApi = getRouteApi('/evaluations/viewer')

export function EvaluationViewerRoute() {
  const { t } = useTranslation()
  const { document } = routeApi.useSearch()
  const [generation, setGeneration] = useState(0)
  const [state, setState] = useState<'error' | 'loading' | 'ready'>('loading')
  if (document === undefined) {
    return <Alert role="alert">{t('evaluations.foundation.viewerDocumentRequired')}</Alert>
  }
  return (
    <div className="space-y-5">
      <PageHeader
        actions={
          <>
            <Button
              onClick={() => {
                setState('loading')
                setGeneration((value) => value + 1)
              }}
              size="sm"
              variant="outline"
            >
              <RotateCcw aria-hidden="true" size={14} />
              {t('evaluations.foundation.retry')}
            </Button>
            <Button asChild size="sm">
              <a
                href={`/evaluations/viewer?document=${encodeURIComponent(document)}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink aria-hidden="true" size={14} />
                {t('evaluations.viewer.openNewTab')}
              </a>
            </Button>
          </>
        }
        description={t('evaluations.viewer.description')}
        title={t('evaluations.foundation.pages.viewer')}
      />
      <div className="relative min-h-[70svh]">
        {state === 'loading' ? <Skeleton className="absolute inset-0 z-10" /> : null}
        {state === 'error' ? (
          <Alert className="absolute inset-x-0 top-0 z-10" role="alert">
            {t('evaluations.viewer.loadError')}
          </Alert>
        ) : null}
        <iframe
          className="min-h-[70svh] w-full rounded-[6px] border border-border bg-white"
          key={generation}
          onError={() => setState('error')}
          onLoad={() => setState('ready')}
          sandbox="allow-scripts"
          src={`${EVALSCOPE_CLIENT_CONFIG.gatewayBase}/generated-documents/${document}`}
          title={t('evaluations.foundation.pages.viewer')}
        />
      </div>
    </div>
  )
}
