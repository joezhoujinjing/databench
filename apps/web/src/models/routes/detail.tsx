import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  type Box,
  Boxes,
  GitBranch,
  History,
  Network,
  Package,
  RefreshCw,
  Rocket,
} from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { ErrorState, Spinner } from '@/components/common/State.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.js'
import { formatDateTime } from '@/lib/format.js'
import { cn } from '@/lib/utils.js'
import {
  activateModelVersionDeploymentV2,
  checkModelVersionDeploymentV2,
  disableModelVersionDeploymentV2,
  findModelSummaryV2,
  getModelV2,
  getModelVersionV2,
  listModelAliasesV2,
  listModelDeploymentAdoptionsV2,
  listModelEvaluationRunsV2,
  type listModelsV2,
  listModelVersionDeploymentsV2,
  listModelVersionsV2,
  type ModelVersionDeploymentV2,
  restoreModelV2,
} from '@/models/api/registry.js'

export type ModelTab =
  | 'overview'
  | 'versions'
  | 'artifacts'
  | 'evaluations'
  | 'deployments'
  | 'lineage'

export const MODEL_DETAIL_TABS: ReadonlyArray<{
  readonly id: ModelTab
  readonly icon: typeof Box
}> = [
  { id: 'overview', icon: Activity },
  { id: 'versions', icon: GitBranch },
  { id: 'artifacts', icon: Package },
  { id: 'evaluations', icon: Boxes },
  { id: 'deployments', icon: Rocket },
  { id: 'lineage', icon: Network },
]

export function ModelDetailRoute() {
  const { t } = useTranslation()
  const { modelId } = useParams({ from: '/models/$modelId' })
  const search = useSearch({ from: '/models/$modelId' })
  const activeTab = search.tab ?? 'overview'
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()
  const modelQuery = useQuery({
    queryKey: [connectionScope, base, 'model', modelId],
    queryFn: ({ signal }) => getModelV2({ base, modelId, signal, token }),
    retry: false,
  })
  const versionsQuery = useInfiniteQuery({
    queryKey: [connectionScope, base, 'model-versions', modelId],
    queryFn: ({ signal, pageParam }) =>
      listModelVersionsV2({ base, cursor: pageParam, limit: 100, modelId, signal, token }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  })
  const aliasesQuery = useQuery({
    queryKey: [connectionScope, base, 'model-aliases', modelId],
    queryFn: ({ signal }) => listModelAliasesV2({ base, modelId, signal, token }),
    retry: false,
  })
  const summaryQuery = useQuery({
    enabled: modelQuery.data !== undefined,
    queryKey: [connectionScope, base, 'model-summary', modelId, modelQuery.data?.key],
    queryFn: ({ signal }) =>
      findModelSummaryV2({
        base,
        modelId,
        modelKey: modelQuery.data?.key ?? '',
        signal,
        token,
      }),
    retry: false,
  })
  const evaluationsQuery = useInfiniteQuery({
    enabled: activeTab === 'evaluations' || activeTab === 'lineage',
    queryKey: [connectionScope, base, 'model-evaluations', modelId],
    queryFn: ({ signal, pageParam }) =>
      listModelEvaluationRunsV2({ base, cursor: pageParam, modelId, signal, token }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  })
  const restore = useMutation({
    mutationFn: () => {
      if (modelQuery.data === undefined) throw new Error('Model is not loaded')
      return restoreModelV2({
        base,
        expectedMetadataRevision: modelQuery.data.metadata_revision,
        modelId,
        token,
      })
    },
    onSuccess: async (restored) => {
      queryClient.setQueryData([connectionScope, base, 'model', modelId], restored)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [connectionScope, base, 'models'] }),
        queryClient.invalidateQueries({
          queryKey: [connectionScope, base, 'model-summary', modelId],
        }),
      ])
    },
  })

  const versions = useMemo(
    () => versionsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [versionsQuery.data?.pages],
  )
  const candidateVersionId = aliasesQuery.data?.items.find(
    (item) => item.alias === 'candidate',
  )?.version_id
  const desiredVersionId = search.version ?? candidateVersionId ?? null
  const loadedDesiredVersion = versions.find((version) => version.id === desiredVersionId)
  const exactVersionQuery = useQuery({
    enabled: desiredVersionId !== null && loadedDesiredVersion === undefined,
    queryKey: [connectionScope, base, 'model-version', desiredVersionId],
    queryFn: ({ signal }) =>
      getModelVersionV2({ base, signal, token, versionId: desiredVersionId ?? '' }),
    retry: false,
  })

  if (modelQuery.isLoading || versionsQuery.isLoading || aliasesQuery.isLoading) {
    return <Spinner label={t('models.loadingModel')} />
  }
  if (modelQuery.isError) return <ErrorState error={modelQuery.error} />
  if (versionsQuery.isError) return <ErrorState error={versionsQuery.error} />
  if (aliasesQuery.isError) return <ErrorState error={aliasesQuery.error} />
  if (summaryQuery.isLoading) return <Spinner label={t('models.loadingModel')} />
  if (summaryQuery.isError) return <ErrorState error={summaryQuery.error} />
  if (
    modelQuery.data === undefined ||
    versionsQuery.data === undefined ||
    aliasesQuery.data === undefined
  ) {
    return <Spinner label={t('models.loadingModel')} />
  }
  const model = modelQuery.data
  const summary = summaryQuery.data ?? null
  if (exactVersionQuery.isLoading) return <Spinner label={t('models.loadingModel')} />
  if (exactVersionQuery.isError) return <ErrorState error={exactVersionQuery.error} />
  if (exactVersionQuery.data !== undefined && exactVersionQuery.data.model_id !== modelId) {
    return <ErrorState error={new Error('Model Version does not belong to this Model')} />
  }
  const selectedVersion = loadedDesiredVersion ?? exactVersionQuery.data ?? versions.at(0) ?? null
  const activeServingCount =
    (summary?.deployment_summary.active ?? 0) + (summary?.active_adopted_deployment_count ?? 0)
  const archivedButServing = model.archived_at !== null && activeServingCount > 0

  return (
    <section className="space-y-6">
      <header className="border-border border-b pb-5">
        <Button asChild size="sm" variant="ghost">
          <Link to="/models">
            <ArrowLeft aria-hidden="true" size={15} />
            {t('models.back')}
          </Link>
        </Button>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-semibold text-3xl tracking-tight">{model.display_name}</h1>
              {model.archived_at === null ? null : (
                <Badge tone="muted">{t('models.archiveArchived')}</Badge>
              )}
              {summary?.candidate === null ? null : (
                <Badge tone="accent">candidate · {summary?.candidate?.version_label}</Badge>
              )}
            </div>
            <p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
              {model.description || t('models.noDescription')}
            </p>
          </div>
          <div className="flex flex-col items-end gap-3 text-right text-dim-foreground text-xs">
            <div>
              <p>{model.key}</p>
              <p className="mt-1">{formatDateTime(model.updated_at)}</p>
            </div>
            {model.archived_at === null ? null : (
              <Button
                disabled={restore.isPending}
                onClick={() => restore.mutate()}
                size="sm"
                type="button"
                variant="outline"
              >
                {restore.isPending ? t('models.restoring') : t('models.restore')}
              </Button>
            )}
          </div>
        </div>
        {archivedButServing ? (
          <p
            className="mt-4 border-warning border-l-2 bg-warning/10 px-4 py-3 text-sm"
            role="status"
          >
            {t('models.archivedButServing', { count: activeServingCount })}
          </p>
        ) : null}
        {restore.isError ? (
          <div className="mt-4">
            <ErrorState error={restore.error} />
          </div>
        ) : null}
      </header>

      <ModelDetailNavigation
        activeTab={activeTab}
        modelId={modelId}
        selectedVersionId={selectedVersion?.id ?? null}
      />

      {activeTab === 'overview' ? (
        <OverviewTab aliases={aliasesQuery.data.items} model={model} summary={summary} />
      ) : null}
      {activeTab === 'versions' ? (
        <VersionsTab modelId={modelId} pager={versionsQuery} versions={versions} />
      ) : null}
      {activeTab === 'artifacts' ? (
        <ArtifactsTab pager={versionsQuery} versions={versions} />
      ) : null}
      {activeTab === 'evaluations' ? (
        <EvaluationsTab query={evaluationsQuery} versions={versions} />
      ) : null}
      {activeTab === 'deployments' ? (
        <DeploymentsTab
          modelId={modelId}
          selectedVersion={selectedVersion}
          versionPager={versionsQuery}
          versions={versions}
        />
      ) : null}
      {activeTab === 'lineage' ? (
        <LineageTab
          evaluationsQuery={evaluationsQuery}
          modelId={modelId}
          selectedVersion={selectedVersion}
          versionPager={versionsQuery}
          versions={versions}
        />
      ) : null}
    </section>
  )
}

export function ModelDetailNavigation({
  activeTab,
  modelId,
  selectedVersionId,
}: {
  readonly activeTab: ModelTab
  readonly modelId: string
  readonly selectedVersionId: string | null
}) {
  const { t } = useTranslation()
  return (
    <nav aria-label={t('models.detailTabs')} className="overflow-x-auto border-border border-b">
      <div className="flex min-w-max gap-1">
        {MODEL_DETAIL_TABS.map(({ id, icon: Icon }) => (
          <Link
            aria-current={activeTab === id ? 'page' : undefined}
            className={cn(
              'flex min-h-11 items-center gap-2 border-primary border-b-2 px-4 font-medium text-muted-foreground text-sm transition-colors',
              activeTab === id
                ? 'border-primary text-foreground'
                : 'border-transparent hover:text-foreground',
            )}
            key={id}
            params={{ modelId }}
            search={{
              tab: id,
              ...(selectedVersionId === null ? {} : { version: selectedVersionId }),
            }}
            to="/models/$modelId"
          >
            <Icon aria-hidden="true" size={15} />
            {t(`models.tabs.${id}`)}
          </Link>
        ))}
      </div>
    </nav>
  )
}

function OverviewTab({
  aliases,
  model,
  summary,
}: {
  readonly aliases: ReadonlyArray<{ readonly alias: string; readonly version_id: string }>
  readonly model: Awaited<ReturnType<typeof getModelV2>>
  readonly summary: Awaited<ReturnType<typeof listModelsV2>>['items'][number] | null
}) {
  const { t } = useTranslation()
  const evaluation = summary?.latest_comparable_evaluation ?? null
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
      <section aria-labelledby="model-identity-title">
        <h2 className="font-semibold" id="model-identity-title">
          {t('models.identity')}
        </h2>
        <dl className="mt-3 divide-y divide-border border-border border-y">
          <Fact label={t('models.taskFamily')} value={model.task_family ?? '—'} />
          <Fact label={t('models.tags')} value={model.tags.join(', ') || '—'} />
          <Fact label={t('models.metadataRevision')} value={String(model.metadata_revision)} />
          <Fact
            label={t('models.aliases')}
            value={aliases.map((item) => `${item.alias}: ${item.version_id}`).join(', ') || '—'}
            mono
          />
        </dl>
      </section>
      <section aria-labelledby="model-operation-title">
        <h2 className="font-semibold" id="model-operation-title">
          {t('models.currentOperation')}
        </h2>
        <dl className="mt-3 divide-y divide-border border-border border-y">
          <Fact label={t('models.versions')} value={String(summary?.version_count ?? 0)} />
          <Fact
            label={t('models.activeDeployments')}
            value={String(summary?.deployment_summary.active ?? 0)}
          />
          <Fact
            label={t('models.healthyDeployments')}
            value={String(summary?.deployment_summary.healthy_active ?? 0)}
          />
        </dl>
      </section>
      <section aria-labelledby="latest-evaluation-title" className="lg:col-span-2">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-semibold" id="latest-evaluation-title">
              {t('models.latestComparableEvaluation')}
            </h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {t('models.noGlobalScoreBoundary')}
            </p>
          </div>
          <Button asChild size="sm" variant="outline">
            <a href="/evaluations/tasks">{t('models.openEvaluations')}</a>
          </Button>
        </div>
        {evaluation === null ? (
          <EmptyLine>{t('models.noComparableEvaluation')}</EmptyLine>
        ) : (
          <dl className="mt-3 grid grid-cols-3 divide-x divide-border border-border border-y max-md:grid-cols-1 max-md:divide-x-0 max-md:divide-y">
            <MetricFact label={t('models.benchmark')} value={evaluation.benchmark} />
            <MetricFact label={t('models.datasetExact')} value={evaluation.dataset_version} mono />
            <MetricFact
              label={`${evaluation.metric_id} / ${evaluation.output_key}`}
              value={String(evaluation.score)}
            />
            <MetricFact
              label={t('models.finished')}
              value={formatDateTime(evaluation.finished_at)}
            />
            <MetricFact
              label={t('models.reproducibility')}
              value={t(`models.reproducibilityKinds.${evaluation.reproducibility.kind}`)}
            />
            <MetricFact
              label={t('models.observedAt')}
              value={formatDateTime(evaluation.reproducibility.source_observed_at)}
            />
          </dl>
        )}
      </section>
    </div>
  )
}

function VersionsTab({
  modelId,
  pager,
  versions,
}: {
  readonly modelId: string
  readonly pager: DetailPager
  readonly versions: Awaited<ReturnType<typeof listModelVersionsV2>>['items']
}) {
  const { t } = useTranslation()
  if (versions.length === 0) return <EmptyLine>{t('models.noVersions')}</EmptyLine>
  return (
    <div className="space-y-3">
      <TableContainer aria-label={t('models.versions')}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('models.version')}</TableHead>
              <TableHead>{t('models.source')}</TableHead>
              <TableHead>{t('models.mutabilityLabel')}</TableHead>
              <TableHead>{t('models.verificationLabel')}</TableHead>
              <TableHead>{t('models.baseModel')}</TableHead>
              <TableHead>{t('models.created')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((version) => (
              <TableRow key={version.id}>
                <TableCell>
                  <Link
                    className="font-medium hover:text-primary focus-visible:text-primary focus-visible:outline-none"
                    params={{ modelId, versionId: version.id }}
                    to="/models/$modelId/versions/$versionId"
                  >
                    {version.version_label}
                  </Link>
                  <p className="mt-1 font-mono text-dim-foreground text-[0.68rem]">{version.id}</p>
                </TableCell>
                <TableCell>{t(`models.sources.${version.source_kind}`)}</TableCell>
                <TableCell>
                  {t(`models.mutability.${version.classification.source_mutability}`)}
                </TableCell>
                <TableCell>
                  <VerificationBadge value={version.classification.verification_level} />
                </TableCell>
                <TableCell>{version.base_model?.reference ?? '—'}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDateTime(version.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <DetailLoadMore pager={pager} />
    </div>
  )
}

function ArtifactsTab({
  pager,
  versions,
}: {
  readonly pager: DetailPager
  readonly versions: Awaited<ReturnType<typeof listModelVersionsV2>>['items']
}) {
  const { t } = useTranslation()
  return (
    <div className="divide-y divide-border border-border border-y">
      {versions.map((version) => (
        <section className="grid gap-4 py-4 lg:grid-cols-[12rem_minmax(0,1fr)]" key={version.id}>
          <div>
            <strong className="text-sm">{version.version_label}</strong>
            <p className="mt-1 text-dim-foreground text-xs">
              {t(`models.sources.${version.source_kind}`)}
            </p>
          </div>
          {version.source.kind === 'databench_artifact' ? (
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
              <CompactFact label={t('models.artifactId')} value={version.source.artifact_id} mono />
              <CompactFact label={t('models.artifactKind')} value={version.source.artifact_kind} />
              <CompactFact
                label={t('models.archiveDigest')}
                value={version.source.archive_digest}
                mono
              />
              <CompactFact
                label={t('models.manifestDigest')}
                value={version.source.manifest_digest}
                mono
              />
            </dl>
          ) : (
            <div>
              <p className="text-muted-foreground text-sm">{t('models.unmanagedWeights')}</p>
              <p className="mt-1 text-dim-foreground text-xs">
                {version.source.kind === 'repository_reference'
                  ? `${version.source.provider} · ${version.source.repository_id}@${version.source.revision}`
                  : `${version.source.external_model_ref}@${version.source.external_version_ref}`}
              </p>
            </div>
          )}
        </section>
      ))}
      {versions.length === 0 ? <EmptyLine>{t('models.noVersions')}</EmptyLine> : null}
      <DetailLoadMore pager={pager} />
    </div>
  )
}

function EvaluationsTab({
  query,
  versions,
}: {
  readonly query: EvaluationRunsPager
  readonly versions: Awaited<ReturnType<typeof listModelVersionsV2>>['items']
}) {
  const { t } = useTranslation()
  if (query.isLoading) return <Spinner label={t('models.loadingEvaluations')} />
  if (query.isError) return <ErrorState error={query.error} />
  const runs = query.data?.pages.flatMap((page) => page.items) ?? []
  if (runs.length === 0) return <EmptyLine>{t('models.noEvaluations')}</EmptyLine>
  const versionById = new Map(versions.map((version) => [version.id, version]))
  return (
    <>
      <p className="mb-4 text-muted-foreground text-sm">{t('models.evaluationBoundary')}</p>
      <TableContainer aria-label={t('models.tabs.evaluations')}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('models.version')}</TableHead>
              <TableHead>{t('models.benchmark')}</TableHead>
              <TableHead>{t('models.datasetExact')}</TableHead>
              <TableHead>{t('models.metricOutput')}</TableHead>
              <TableHead>{t('models.status')}</TableHead>
              <TableHead>{t('models.finished')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => {
              const primary = run.metrics?.find(
                (metric) =>
                  metric.metric_id === run.primary_metric_id &&
                  metric.output_key === run.primary_output_key,
              )
              const version = run.model_version_id
                ? versionById.get(run.model_version_id)
                : undefined
              const observation = run.source_mutability_snapshot !== 'immutable'
              return (
                <TableRow key={run.id}>
                  <TableCell>
                    {version?.version_label ?? '—'}
                    {observation ? (
                      <p className="mt-1 text-warning text-xs">{t('models.serviceObservation')}</p>
                    ) : null}
                  </TableCell>
                  <TableCell>{run.benchmark}</TableCell>
                  <TableCell className="max-w-48 break-all font-mono text-xs">
                    {run.dataset_version}
                  </TableCell>
                  <TableCell>
                    {run.primary_metric_id === null
                      ? '—'
                      : `${run.primary_metric_id} / ${run.primary_output_key}: ${primary?.score ?? '—'}`}
                  </TableCell>
                  <TableCell>
                    <Badge tone={run.status === 'completed' ? 'green' : 'muted'}>
                      {run.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {run.finished_at === null ? '—' : formatDateTime(run.finished_at)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <DetailLoadMore pager={query} />
    </>
  )
}

function DeploymentsTab({
  modelId,
  selectedVersion,
  versionPager,
  versions,
}: {
  readonly modelId: string
  readonly selectedVersion: Awaited<ReturnType<typeof listModelVersionsV2>>['items'][number] | null
  readonly versionPager: DetailPager
  readonly versions: Awaited<ReturnType<typeof listModelVersionsV2>>['items']
}) {
  const { t } = useTranslation()
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()
  const deployments = useInfiniteQuery({
    enabled: selectedVersion !== null,
    queryKey: [connectionScope, base, 'model-version-deployments', selectedVersion?.id],
    queryFn: ({ signal, pageParam }) =>
      listModelVersionDeploymentsV2({
        base,
        cursor: pageParam,
        signal,
        token,
        versionId: selectedVersion?.id ?? '',
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  })
  const deploymentItems = useMemo(
    () => deployments.data?.pages.flatMap((page) => page.items) ?? [],
    [deployments.data?.pages],
  )
  const action = useMutation({
    mutationFn: async ({
      action,
      deployment,
    }: {
      readonly action: 'activate' | 'check' | 'disable'
      readonly deployment: ModelVersionDeploymentV2
    }) => {
      const options = {
        base,
        token,
        versionId: deployment.model_version_id,
        deploymentId: deployment.id,
      }
      return action === 'activate'
        ? await activateModelVersionDeploymentV2(options)
        : action === 'check'
          ? await checkModelVersionDeploymentV2(options)
          : await disableModelVersionDeploymentV2(options)
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: [connectionScope, base, 'model-version-deployments'],
        }),
        queryClient.invalidateQueries({
          queryKey: [connectionScope, base, 'model-summary', modelId],
        }),
      ])
    },
  })
  return (
    <div className="space-y-4">
      <VersionChooser
        modelId={modelId}
        selectedVersion={selectedVersion}
        tab="deployments"
        versions={versions}
      />
      <DetailLoadMore pager={versionPager} />
      {selectedVersion?.source_kind === 'repository_reference' ? (
        <p className="border-warning border-l-2 bg-warning/10 px-4 py-3 text-sm">
          {t('models.repositoryDeploymentBoundary')}
        </p>
      ) : null}
      {deployments.isLoading ? <Spinner label={t('models.loadingDeployments')} /> : null}
      {deployments.isError ? <ErrorState error={deployments.error} /> : null}
      {action.isError ? <ErrorState error={action.error} /> : null}
      {deploymentItems.length === 0 ? (
        <EmptyLine>{t('models.noVersionDeployments')}</EmptyLine>
      ) : null}
      {deploymentItems.length > 0 ? (
        <TableContainer aria-label={t('models.tabs.deployments')}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('models.deployment')}</TableHead>
                <TableHead>{t('models.lifecycleLabel')}</TableHead>
                <TableHead>{t('models.availabilityLabel')}</TableHead>
                <TableHead>{t('models.healthLabel')}</TableHead>
                <TableHead>{t('models.capabilities')}</TableHead>
                <TableHead>{t('models.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deploymentItems.map((deployment) => (
                <TableRow key={deployment.id}>
                  <TableCell>
                    <strong>{deployment.display_name}</strong>
                    <p className="mt-1 text-dim-foreground text-xs">
                      {deployment.served_model_name}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge tone={deployment.lifecycle === 'active' ? 'green' : 'muted'}>
                      {t(`models.lifecycle.${deployment.lifecycle}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge tone={deployment.availability === 'available' ? 'green' : 'orange'}>
                      {t(`models.availability.${deployment.availability}`)}
                    </Badge>
                    {deployment.unavailable_reason === null ? null : (
                      <p className="mt-1 text-warning text-xs">
                        {t(`models.unavailableReasons.${deployment.unavailable_reason}`)}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>{t(`models.health.${deployment.health_status}`)}</TableCell>
                  <TableCell className="max-w-64 text-xs">
                    {deployment.declared_capabilities.interfaces.join(', ')}
                    <p className="mt-1 text-dim-foreground">
                      {t('models.contextLimitValue', {
                        value: deployment.declared_capabilities.context_limit ?? '—',
                      })}
                    </p>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {deployment.lifecycle === 'registered' ? (
                        <Button
                          disabled={action.isPending}
                          onClick={() => action.mutate({ action: 'activate', deployment })}
                          size="sm"
                          type="button"
                        >
                          {t('models.activate')}
                        </Button>
                      ) : null}
                      {deployment.lifecycle !== 'disabled' ? (
                        <Button
                          disabled={action.isPending}
                          onClick={() => action.mutate({ action: 'check', deployment })}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <RefreshCw aria-hidden="true" size={13} />
                          {t('models.check')}
                        </Button>
                      ) : null}
                      {deployment.lifecycle !== 'disabled' ? (
                        <Button
                          disabled={action.isPending}
                          onClick={() => action.mutate({ action: 'disable', deployment })}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          {t('models.disable')}
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}
      <DetailLoadMore pager={deployments} />
    </div>
  )
}

function LineageTab({
  evaluationsQuery,
  modelId,
  selectedVersion,
  versionPager,
  versions,
}: {
  readonly evaluationsQuery: EvaluationRunsPager
  readonly modelId: string
  readonly selectedVersion: Awaited<ReturnType<typeof listModelVersionsV2>>['items'][number] | null
  readonly versionPager: DetailPager
  readonly versions: Awaited<ReturnType<typeof listModelVersionsV2>>['items']
}) {
  const { t } = useTranslation()
  const { base, connectionScope, token } = useBackend()
  const adoptions = useInfiniteQuery({
    enabled: selectedVersion !== null,
    queryKey: [connectionScope, base, 'model-deployment-adoptions', selectedVersion?.id],
    queryFn: ({ signal, pageParam }) =>
      listModelDeploymentAdoptionsV2({
        base,
        cursor: pageParam,
        signal,
        token,
        versionId: selectedVersion?.id ?? '',
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  })
  const deployments = useInfiniteQuery({
    enabled: selectedVersion !== null,
    queryKey: [connectionScope, base, 'model-version-deployments', selectedVersion?.id],
    queryFn: ({ signal, pageParam }) =>
      listModelVersionDeploymentsV2({
        base,
        cursor: pageParam,
        signal,
        token,
        versionId: selectedVersion?.id ?? '',
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    retry: false,
  })
  const adoptionItems = useMemo(
    () => adoptions.data?.pages.flatMap((page) => page.items) ?? [],
    [adoptions.data?.pages],
  )
  const deploymentItems = useMemo(
    () => deployments.data?.pages.flatMap((page) => page.items) ?? [],
    [deployments.data?.pages],
  )
  const runs = (evaluationsQuery.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (run) => run.model_version_id === selectedVersion?.id,
  )
  return (
    <div className="space-y-5">
      <VersionChooser
        modelId={modelId}
        selectedVersion={selectedVersion}
        tab="lineage"
        versions={versions}
      />
      <DetailLoadMore pager={versionPager} />
      {selectedVersion === null ? (
        <EmptyLine>{t('models.noVersions')}</EmptyLine>
      ) : (
        <div className="overflow-x-auto border-border border-y py-7">
          <div className="flex min-w-[54rem] items-stretch justify-center gap-3 px-4">
            <LineageNode label={t('models.lineageSource')} value={sourceLine(selectedVersion)} />
            <LineageArrow />
            <LineageNode label={t('models.version')} value={selectedVersion.version_label} />
            <LineageArrow />
            <LineageNode
              label={t('models.tabs.deployments')}
              value={t(
                deployments.hasNextPage
                  ? 'models.lineageDeploymentLoadedCount'
                  : 'models.lineageDeploymentCount',
                {
                  count: deploymentItems.length,
                },
              )}
            />
            <LineageArrow />
            <LineageNode
              label={t('models.tabs.evaluations')}
              value={t(
                evaluationsQuery.hasNextPage
                  ? 'models.lineageEvaluationLoadedCount'
                  : 'models.lineageEvaluationCount',
                { count: runs.length },
              )}
            />
          </div>
        </div>
      )}
      {deployments.isError ? <ErrorState error={deployments.error} /> : null}
      {adoptions.isError ? <ErrorState error={adoptions.error} /> : null}
      {adoptionItems.length > 0 ? (
        <section aria-labelledby="historical-adoptions-title">
          <h2 className="flex items-center gap-2 font-semibold" id="historical-adoptions-title">
            <History aria-hidden="true" className="text-primary" size={17} />
            {t('models.historicalAdoptions')}
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">{t('models.adoptionNavigationOnly')}</p>
          <ul className="mt-3 divide-y divide-border border-border border-y">
            {adoptionItems.map((item) => (
              <li
                className="grid gap-2 py-3 text-sm sm:grid-cols-[1fr_1fr_auto]"
                key={item.deployment_id}
              >
                <code className="break-all text-xs">{item.deployment_id}</code>
                <code className="break-all text-dim-foreground text-xs">{item.artifact_id}</code>
                <span>{formatDateTime(item.adopted_at)}</span>
              </li>
            ))}
          </ul>
          <DetailLoadMore pager={adoptions} />
        </section>
      ) : null}
      <DetailLoadMore pager={deployments} />
    </div>
  )
}

function VersionChooser({
  modelId,
  selectedVersion,
  tab,
  versions,
}: {
  readonly modelId: string
  readonly selectedVersion: Awaited<ReturnType<typeof listModelVersionsV2>>['items'][number] | null
  readonly tab: 'deployments' | 'lineage'
  readonly versions: Awaited<ReturnType<typeof listModelVersionsV2>>['items']
}) {
  const { t } = useTranslation()
  const choices =
    selectedVersion !== null && !versions.some((version) => version.id === selectedVersion.id)
      ? [selectedVersion, ...versions]
      : versions
  return (
    <div className="flex flex-wrap items-center gap-2 border-border border-b pb-4">
      <span className="mr-2 text-muted-foreground text-sm">{t('models.versionContext')}</span>
      {choices.map((version) => (
        <Button
          asChild
          key={version.id}
          size="sm"
          variant={selectedVersion?.id === version.id ? 'default' : 'outline'}
        >
          <Link params={{ modelId }} search={{ tab, version: version.id }} to="/models/$modelId">
            {version.version_label}
          </Link>
        </Button>
      ))}
    </div>
  )
}

interface DetailPager {
  readonly hasNextPage: boolean
  readonly isFetchingNextPage: boolean
  readonly fetchNextPage: () => Promise<unknown>
}

interface EvaluationRunsPager extends DetailPager {
  readonly data:
    | {
        readonly pages: readonly Awaited<ReturnType<typeof listModelEvaluationRunsV2>>[]
      }
    | undefined
  readonly error: Error | null
  readonly isError: boolean
  readonly isLoading: boolean
}

function DetailLoadMore({ pager }: { readonly pager: DetailPager }) {
  const { t } = useTranslation()
  if (!pager.hasNextPage) return null
  return (
    <Button
      disabled={pager.isFetchingNextPage}
      onClick={() => void pager.fetchNextPage()}
      type="button"
      variant="ghost"
    >
      {t('common.next')}
    </Button>
  )
}

function VerificationBadge({ value }: { readonly value: string }) {
  const { t } = useTranslation()
  return (
    <Badge
      tone={value === 'content_verified' || value === 'provider_verified' ? 'green' : 'orange'}
    >
      {t(`models.verification.${value}`)}
    </Badge>
  )
}

function Fact({
  label,
  mono = false,
  value,
}: {
  readonly label: string
  readonly mono?: boolean
  readonly value: string
}) {
  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)] gap-4 py-3 text-sm max-sm:grid-cols-1 max-sm:gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('break-all', mono && 'font-mono text-xs')}>{value}</dd>
    </div>
  )
}

function CompactFact({
  label,
  mono = false,
  value,
}: {
  readonly label: string
  readonly mono?: boolean
  readonly value: string
}) {
  return (
    <div>
      <dt className="text-dim-foreground text-xs">{label}</dt>
      <dd className={cn('mt-1 break-all text-sm', mono && 'font-mono text-[0.7rem]')}>{value}</dd>
    </div>
  )
}

function MetricFact({
  label,
  mono = false,
  value,
}: {
  readonly label: string
  readonly mono?: boolean
  readonly value: string
}) {
  return (
    <div className="min-w-0 px-5 py-4">
      <dt className="text-dim-foreground text-xs">{label}</dt>
      <dd className={cn('mt-2 break-all font-medium text-sm', mono && 'font-mono text-xs')}>
        {value}
      </dd>
    </div>
  )
}

function EmptyLine({ children }: { readonly children: string }) {
  return (
    <p className="border-border border-y py-12 text-center text-muted-foreground text-sm">
      {children}
    </p>
  )
}

function LineageNode({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex w-44 shrink-0 flex-col justify-center border-border border-y px-4 py-5">
      <span className="text-dim-foreground text-xs">{label}</span>
      <strong className="mt-2 break-all text-sm">{value}</strong>
    </div>
  )
}

function LineageArrow() {
  return (
    <div className="flex items-center text-primary">
      <ArrowRight aria-hidden="true" size={18} />
    </div>
  )
}

function sourceLine(
  version: Awaited<ReturnType<typeof listModelVersionsV2>>['items'][number],
): string {
  if (version.source.kind === 'databench_artifact') return version.source.artifact_id
  if (version.source.kind === 'repository_reference') {
    return `${version.source.provider}:${version.source.repository_id}@${version.source.revision}`
  }
  return `${version.source.external_model_ref}@${version.source.external_version_ref}`
}
