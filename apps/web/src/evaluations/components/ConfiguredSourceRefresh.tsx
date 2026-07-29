import { Database, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'

export function ConfiguredSourceRefresh({
  configured,
  isRefreshing,
  onRefresh,
}: {
  readonly configured: boolean
  readonly isRefreshing: boolean
  readonly onRefresh: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <Badge className="gap-2" tone={configured ? 'green' : 'orange'}>
        <Database aria-hidden="true" size={12} />
        {configured
          ? t('evaluations.reports.configuredSource')
          : t('evaluations.reports.sourceUnavailable')}
      </Badge>
      <Button
        disabled={isRefreshing || !configured}
        onClick={onRefresh}
        size="sm"
        variant="outline"
      >
        <RefreshCw
          aria-hidden="true"
          className={isRefreshing ? 'animate-spin' : undefined}
          size={14}
        />
        {isRefreshing ? t('evaluations.reports.scanning') : t('evaluations.reports.scan')}
      </Button>
    </div>
  )
}
