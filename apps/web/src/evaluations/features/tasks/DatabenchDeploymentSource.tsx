import { RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { SelectInput } from '@/components/ui/input.js'
import { useModelDeployments } from '@/models/api/hooks.js'
import { V2MutationError } from '@/v2/components/V2MutationError.js'
import { TaskFormField } from './TaskFormField.js'

export function DatabenchDeploymentSource({
  deploymentId,
  disabled,
  onChange,
}: {
  readonly deploymentId: string | null
  readonly disabled: boolean
  readonly onChange: (deploymentId: string | null) => void
}) {
  const { t } = useTranslation()
  const deployments = useModelDeployments({ status: 'active' })
  const items = deployments.data?.items ?? []

  useEffect(() => {
    if (deploymentId !== null && !items.some((item) => item.id === deploymentId)) {
      onChange(null)
    }
  }, [deploymentId, items, onChange])

  const selected = items.find((item) => item.id === deploymentId)
  return (
    <div className="space-y-3 rounded-[5px] border border-border bg-background/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <strong className="text-sm">{t('evaluations.tasks.deploymentBinding')}</strong>
          <p className="mt-1 text-dim-foreground text-xs leading-5">
            {t('evaluations.tasks.deploymentBindingHint')}
          </p>
        </div>
        <Button
          disabled={deployments.isFetching}
          onClick={() => void deployments.refetch()}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={14} />
          {t('evaluations.tasks.refreshDeployments')}
        </Button>
      </div>
      <TaskFormField id="eval-deployment-id" label={t('evaluations.tasks.deployment')} required>
        <SelectInput
          aria-label={t('evaluations.tasks.deployment')}
          disabled={disabled || deployments.isLoading || items.length === 0}
          id="eval-deployment-id"
          onValueChange={(value) => onChange(value === '' ? null : value)}
          options={[
            { label: t('evaluations.tasks.selectDeployment'), value: '' },
            ...items.map((item) => ({
              label: `${item.display_name} · ${item.served_model_name}`,
              value: item.id,
            })),
          ]}
          value={deploymentId ?? ''}
        />
      </TaskFormField>
      {selected === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={selected.health_status === 'healthy' ? 'green' : 'orange'}>
            {t(`evaluations.tasks.deploymentHealth.${selected.health_status}`)}
          </Badge>
          <span className="break-all text-dim-foreground">{selected.id}</span>
        </div>
      )}
      {deployments.isError ? <V2MutationError error={deployments.error} /> : null}
      {!deployments.isLoading && !deployments.isError && items.length === 0 ? (
        <p className="text-warning text-sm">{t('evaluations.tasks.noDeployments')}</p>
      ) : null}
    </div>
  )
}
