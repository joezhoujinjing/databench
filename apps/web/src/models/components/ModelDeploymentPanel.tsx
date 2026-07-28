import { Activity, Ban, ChevronDown, ChevronUp, Network, Plus, RefreshCw } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Field } from '@/components/ui/field.js'
import { TextInput } from '@/components/ui/input.js'
import type { ModelArtifactV2 } from '@/training/api/artifacts.js'
import { V2MutationError } from '@/v2/components/V2MutationError.js'
import type { ModelDeploymentV2 } from '../api/deployments.js'
import {
  useCheckModelDeployment,
  useCreateModelDeployment,
  useDeploymentEvaluationRuns,
  useDisableModelDeployment,
  useModelDeployments,
} from '../api/hooks.js'

export function ModelDeploymentPanel({ artifact }: { readonly artifact: ModelArtifactV2 }) {
  const { t } = useTranslation()
  const deployments = useModelDeployments({ artifactId: artifact.id })
  const create = useCreateModelDeployment()
  const check = useCheckModelDeployment()
  const disable = useDisableModelDeployment()
  const [displayName, setDisplayName] = useState(`${artifact.display_name} endpoint`)
  const [servedModelName, setServedModelName] = useState(artifact.base_model.reference)
  const [endpointBaseUrl, setEndpointBaseUrl] = useState('')

  useEffect(() => {
    setDisplayName(`${artifact.display_name} endpoint`)
    setServedModelName(artifact.base_model.reference)
    setEndpointBaseUrl('')
  }, [artifact])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    create.mutate({
      artifact_id: artifact.id,
      auth_mode: 'none',
      display_name: displayName.trim(),
      endpoint_base_url: endpointBaseUrl.trim(),
      provider: 'openai_compatible',
      served_model_name: servedModelName.trim(),
    })
  }

  const busy = create.isPending || check.isPending || disable.isPending
  return (
    <section className="space-y-4 rounded-[5px] border border-border bg-background/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold text-sm">
            <Network aria-hidden="true" className="text-primary" size={17} />
            {t('training.deployments.title')}
          </div>
          <p className="mt-1 text-dim-foreground text-xs leading-5">
            {t('training.deployments.description')}
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
          {t('training.deployments.refresh')}
        </Button>
      </div>

      <form className="grid gap-3 md:grid-cols-2" onSubmit={submit}>
        <Field htmlFor={`deployment-name-${artifact.id}`} label={t('training.deployments.name')}>
          <TextInput
            disabled={busy}
            id={`deployment-name-${artifact.id}`}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            required
            value={displayName}
          />
        </Field>
        <Field
          htmlFor={`deployment-model-${artifact.id}`}
          label={t('training.deployments.servedModel')}
        >
          <TextInput
            disabled={busy}
            id={`deployment-model-${artifact.id}`}
            onChange={(event) => setServedModelName(event.currentTarget.value)}
            required
            value={servedModelName}
          />
        </Field>
        <Field
          className="md:col-span-2"
          hint={t('training.deployments.endpointHint')}
          htmlFor={`deployment-endpoint-${artifact.id}`}
          label={t('training.deployments.endpoint')}
        >
          <TextInput
            autoComplete="url"
            disabled={busy}
            id={`deployment-endpoint-${artifact.id}`}
            onChange={(event) => setEndpointBaseUrl(event.currentTarget.value)}
            placeholder="http://model-service:8000/v1"
            required
            type="url"
            value={endpointBaseUrl}
          />
        </Field>
        <div className="md:col-span-2">
          <Button
            disabled={
              busy ||
              displayName.trim() === '' ||
              servedModelName.trim() === '' ||
              endpointBaseUrl.trim() === ''
            }
            size="sm"
            type="submit"
          >
            <Plus aria-hidden="true" size={14} />
            {create.isPending
              ? t('training.deployments.registering')
              : t('training.deployments.register')}
          </Button>
        </div>
      </form>

      {create.isError ? <V2MutationError error={create.error} /> : null}
      {check.isError ? <V2MutationError error={check.error} /> : null}
      {disable.isError ? <V2MutationError error={disable.error} /> : null}
      {deployments.isError ? <V2MutationError error={deployments.error} /> : null}
      {deployments.isLoading ? (
        <p className="text-dim-foreground text-sm">{t('training.deployments.loading')}</p>
      ) : null}
      {deployments.data?.items.length === 0 ? (
        <p className="text-dim-foreground text-sm">{t('training.deployments.empty')}</p>
      ) : null}
      {deployments.data?.items.length ? (
        <ul className="divide-y divide-border rounded-[5px] border border-border">
          {deployments.data.items.map((deployment) => (
            <DeploymentRow
              busy={busy}
              deployment={deployment}
              key={deployment.id}
              onCheck={() => check.mutate(deployment.id)}
              onDisable={() => disable.mutate(deployment.id)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function DeploymentRow({
  busy,
  deployment,
  onCheck,
  onDisable,
}: {
  readonly busy: boolean
  readonly deployment: ModelDeploymentV2
  readonly onCheck: () => void
  readonly onDisable: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const runs = useDeploymentEvaluationRuns(deployment.id, expanded)
  return (
    <li className="px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <strong>{deployment.display_name}</strong>
            <Badge tone={deployment.status === 'active' ? 'green' : 'muted'}>
              {t(`training.deployments.status.${deployment.status}`)}
            </Badge>
            <Badge tone={healthTone(deployment.health_status)}>
              {t(`training.deployments.health.${deployment.health_status}`)}
            </Badge>
          </div>
          <p className="mt-1 break-all text-dim-foreground text-xs">
            {deployment.served_model_name} · {deployment.id}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => setExpanded((current) => !current)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {expanded ? (
              <ChevronUp aria-hidden="true" size={14} />
            ) : (
              <ChevronDown aria-hidden="true" size={14} />
            )}
            {t('training.deployments.evaluationRuns')}
          </Button>
          <Button
            disabled={busy || deployment.status !== 'active'}
            onClick={onCheck}
            size="sm"
            type="button"
            variant="outline"
          >
            <Activity aria-hidden="true" size={14} />
            {t('training.deployments.check')}
          </Button>
          <Button
            disabled={busy || deployment.status !== 'active'}
            onClick={onDisable}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Ban aria-hidden="true" size={14} />
            {t('training.deployments.disable')}
          </Button>
        </div>
      </div>
      {expanded ? (
        <div className="mt-3 border-border border-t pt-3">
          {runs.isLoading ? (
            <p className="text-dim-foreground text-xs">{t('training.deployments.loadingRuns')}</p>
          ) : null}
          {runs.isError ? <V2MutationError error={runs.error} /> : null}
          {runs.data?.items.length === 0 ? (
            <p className="text-dim-foreground text-xs">{t('training.deployments.noRuns')}</p>
          ) : null}
          {runs.data?.items.length ? (
            <ul className="space-y-2">
              {runs.data.items.map((run) => (
                <li className="rounded-[4px] bg-surface-soft px-3 py-2 text-xs" key={run.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        run.status === 'completed'
                          ? 'green'
                          : run.status === 'failed'
                            ? 'orange'
                            : 'blue'
                      }
                    >
                      {run.status}
                    </Badge>
                    <strong className="break-all">{run.id}</strong>
                  </div>
                  <p className="mt-1 break-all text-dim-foreground">
                    Dataset {run.dataset_version} · Artifact {run.model_artifact_id ?? '—'}
                  </p>
                  <p className="mt-1 break-all text-dim-foreground">
                    EvalScope {run.provider_task_id}
                    {run.provider_report_ids?.length
                      ? ` · Reports ${run.provider_report_ids.join(', ')}`
                      : ''}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function healthTone(status: ModelDeploymentV2['health_status']): 'green' | 'orange' | 'muted' {
  if (status === 'healthy') return 'green'
  if (status === 'unhealthy') return 'orange'
  return 'muted'
}
