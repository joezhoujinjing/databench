import { useInfiniteQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { SelectInput } from '@/components/ui/input.js'
import {
  listModelEvaluationDeploymentCandidatesV2,
  listModelsV2,
  listModelVersionsV2,
  type ModelEvaluationDeploymentSelectorV2,
} from '@/models/api/registry.js'
import { V2MutationError } from '@/v2/components/V2MutationError.js'
import { TaskFormField } from './TaskFormField.js'

export function DatabenchDeploymentSource({
  deploymentId,
  disabled,
  maxOutputTokens,
  onChange,
}: {
  readonly deploymentId: string | null
  readonly disabled: boolean
  readonly maxOutputTokens?: number | undefined
  readonly onChange: (deploymentId: string | null) => void
}) {
  const { t } = useTranslation()
  const { base, connectionScope, token } = useBackend()
  const [modelId, setModelId] = useState('')
  const [versionId, setVersionId] = useState('')
  const models = useInfiniteQuery({
    queryKey: [connectionScope, base, 'evaluation-model-selector'],
    queryFn: ({ signal, pageParam }) =>
      listModelsV2({
        archive: 'active',
        base,
        cursor: pageParam,
        limit: 100,
        search: '',
        signal,
        token,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  })
  const versions = useInfiniteQuery({
    enabled: modelId !== '',
    queryKey: [connectionScope, base, 'evaluation-version-selector', modelId],
    queryFn: ({ signal, pageParam }) =>
      listModelVersionsV2({ base, cursor: pageParam, limit: 100, modelId, signal, token }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  })
  const candidates = useInfiniteQuery({
    enabled: versionId !== '',
    queryKey: [
      connectionScope,
      base,
      'evaluation-deployment-selector',
      versionId,
      maxOutputTokens ?? null,
    ],
    queryFn: ({ signal, pageParam }) =>
      listModelEvaluationDeploymentCandidatesV2({
        base,
        cursor: pageParam,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        signal,
        token,
        versionId,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  })

  const modelItems = useMemo(
    () => models.data?.pages.flatMap((page) => page.items) ?? [],
    [models.data?.pages],
  )
  const versionItems = useMemo(
    () => versions.data?.pages.flatMap((page) => page.items) ?? [],
    [versions.data?.pages],
  )
  const candidateItems = useMemo(
    () => candidates.data?.pages.flatMap((page) => page.items) ?? [],
    [candidates.data?.pages],
  )
  const selected = candidateItems.find((candidate) => candidate.deployment.id === deploymentId)

  useEffect(() => {
    if (
      shouldClearMissingPaginatedSelection(
        modelId !== '',
        modelItems.some((item) => item.model.id === modelId),
        models.hasNextPage,
        models.isSuccess,
      )
    ) {
      setModelId('')
      setVersionId('')
      onChange(null)
    }
  }, [modelId, modelItems, models.hasNextPage, models.isSuccess, onChange])

  useEffect(() => {
    if (
      shouldClearMissingPaginatedSelection(
        versionId !== '',
        versionItems.some((version) => version.id === versionId),
        versions.hasNextPage,
        versions.isSuccess,
      )
    ) {
      setVersionId('')
      onChange(null)
    }
  }, [onChange, versionId, versionItems, versions.hasNextPage, versions.isSuccess])

  useEffect(() => {
    if (
      deploymentId !== null &&
      (selected?.eligible === false ||
        shouldClearMissingPaginatedSelection(
          true,
          selected !== undefined,
          candidates.hasNextPage,
          candidates.isSuccess,
        ))
    ) {
      onChange(null)
    }
  }, [candidates.hasNextPage, candidates.isSuccess, deploymentId, onChange, selected])
  const refresh = async () => {
    await models.refetch()
    if (modelId !== '') await versions.refetch()
    if (versionId !== '') await candidates.refetch()
  }

  return (
    <div className="space-y-4 border border-border bg-background/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <strong className="text-sm">{t('evaluations.tasks.registryBinding')}</strong>
          <p className="mt-1 text-dim-foreground text-xs leading-5">
            {t('evaluations.tasks.registryBindingHint', {
              count: 4_096 + (maxOutputTokens ?? 0),
            })}
          </p>
        </div>
        <Button
          disabled={models.isFetching || versions.isFetching || candidates.isFetching}
          onClick={() => void refresh()}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={14} />
          {t('evaluations.tasks.refreshDeployments')}
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <TaskFormField id="eval-model-id" label={t('evaluations.tasks.registryModel')} required>
          <SelectInput
            aria-label={t('evaluations.tasks.registryModel')}
            disabled={disabled || models.isLoading || modelItems.length === 0}
            id="eval-model-id"
            onValueChange={(value) => {
              setModelId(value)
              setVersionId('')
              onChange(null)
            }}
            options={[
              { label: t('evaluations.tasks.selectModel'), value: '' },
              ...modelItems.map((item) => ({
                label: item.model.display_name,
                value: item.model.id,
              })),
            ]}
            value={modelId}
          />
          {models.hasNextPage ? (
            <LoadMoreSelectorButton
              disabled={models.isFetchingNextPage}
              onClick={() => void models.fetchNextPage()}
            />
          ) : null}
        </TaskFormField>
        <TaskFormField id="eval-version-id" label={t('evaluations.tasks.registryVersion')} required>
          <SelectInput
            aria-label={t('evaluations.tasks.registryVersion')}
            disabled={disabled || modelId === '' || versions.isLoading}
            id="eval-version-id"
            onValueChange={(value) => {
              setVersionId(value)
              onChange(null)
            }}
            options={[
              { label: t('evaluations.tasks.selectVersion'), value: '' },
              ...versionItems.map((version) => ({
                label: `${version.version_label} · ${t(`models.sources.${version.source_kind}`)}`,
                value: version.id,
              })),
            ]}
            value={versionId}
          />
          {versions.hasNextPage ? (
            <LoadMoreSelectorButton
              disabled={versions.isFetchingNextPage}
              onClick={() => void versions.fetchNextPage()}
            />
          ) : null}
        </TaskFormField>
      </div>

      {versionId === '' ? null : (
        <fieldset className="border-border border-t pt-3">
          <legend className="px-1 font-medium text-sm">
            {t('evaluations.tasks.registryDeployment')}
          </legend>
          {candidates.isLoading ? (
            <p className="py-4 text-muted-foreground text-sm" role="status">
              {t('evaluations.tasks.loadingCandidates')}
            </p>
          ) : null}
          {!candidates.isLoading && candidateItems.length === 0 ? (
            <p className="py-4 text-warning text-sm">
              {t('evaluations.tasks.noVersionDeployments')}
            </p>
          ) : null}
          <DatabenchDeploymentCandidateOptions
            candidates={candidateItems}
            deploymentId={deploymentId}
            disabled={disabled}
            onChange={onChange}
          />
          {candidates.hasNextPage ? (
            <LoadMoreSelectorButton
              disabled={candidates.isFetchingNextPage}
              onClick={() => void candidates.fetchNextPage()}
            />
          ) : null}
        </fieldset>
      )}

      {selected === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={selected.deployment.health_status === 'healthy' ? 'green' : 'orange'}>
            {t(`evaluations.tasks.deploymentHealth.${selected.deployment.health_status}`)}
          </Badge>
          <span className="break-all text-dim-foreground">{selected.deployment.id}</span>
        </div>
      )}
      {models.isError ? <V2MutationError error={models.error} /> : null}
      {versions.isError ? <V2MutationError error={versions.error} /> : null}
      {candidates.isError ? <V2MutationError error={candidates.error} /> : null}
      {!models.isLoading && !models.isError && modelItems.length === 0 ? (
        <p className="text-warning text-sm">{t('evaluations.tasks.noRegistryModels')}</p>
      ) : null}
    </div>
  )
}

export function shouldClearMissingPaginatedSelection(
  hasSelection: boolean,
  selectionIsLoaded: boolean,
  hasNextPage: boolean,
  queryIsReady: boolean,
): boolean {
  return hasSelection && queryIsReady && !selectionIsLoaded && !hasNextPage
}

function LoadMoreSelectorButton({
  disabled,
  onClick,
}: {
  readonly disabled: boolean
  readonly onClick: () => void
}) {
  const { t } = useTranslation()
  return (
    <Button
      className="mt-2"
      disabled={disabled}
      onClick={onClick}
      size="sm"
      type="button"
      variant="ghost"
    >
      {t('evaluations.tasks.loadMoreRegistryItems')}
    </Button>
  )
}

export function DatabenchDeploymentCandidateOptions({
  candidates,
  deploymentId,
  disabled,
  onChange,
}: {
  readonly candidates: ModelEvaluationDeploymentSelectorV2['items']
  readonly deploymentId: string | null
  readonly disabled: boolean
  readonly onChange: (deploymentId: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="divide-y divide-border">
      {candidates.map((candidate) => {
        const deployment = candidate.deployment
        return (
          <label
            className={`grid gap-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] ${
              candidate.eligible ? 'cursor-pointer' : 'cursor-not-allowed opacity-65'
            }`}
            key={deployment.id}
          >
            <input
              checked={deploymentId === deployment.id}
              disabled={disabled || !candidate.eligible}
              name="evaluation-deployment"
              onChange={() => onChange(deployment.id)}
              type="radio"
              value={deployment.id}
            />
            <span>
              <strong className="block text-sm">{deployment.display_name}</strong>
              <span className="mt-1 block text-dim-foreground text-xs">
                {deployment.served_model_name} ·{' '}
                {deployment.declared_capabilities.interfaces.join(', ')}
              </span>
              {candidate.exclusion_reasons.length === 0 ? null : (
                <span className="mt-1 block text-warning text-xs">
                  {candidate.exclusion_reasons
                    .map((reason) => t(`evaluations.tasks.selectorExclusions.${reason}`))
                    .join(' · ')}
                </span>
              )}
            </span>
            <span className="flex flex-wrap items-start gap-1">
              <Badge tone={deployment.lifecycle === 'active' ? 'green' : 'muted'}>
                {t(`models.lifecycle.${deployment.lifecycle}`)}
              </Badge>
              <Badge tone={deployment.availability === 'available' ? 'green' : 'orange'}>
                {t(`models.availability.${deployment.availability}`)}
              </Badge>
            </span>
          </label>
        )
      })}
    </div>
  )
}
