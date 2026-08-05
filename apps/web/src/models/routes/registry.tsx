import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Check, Plus, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { ApiError } from '@/api/errors.js'
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
import {
  activateModelVersionDeploymentV2,
  commitModelRegistrationV2,
  inspectModelRegistrationV2,
  listModelsV2,
  type ModelPageV2,
  type ModelRegistrationPlanV2,
  type ModelRegistrationRequestV2,
} from '@/models/api/registry.js'
import { listModelArtifactsV2, type ModelArtifactV2 } from '@/training/api/artifacts.js'

type ArchiveFilter = 'active' | 'archived' | 'all'
type SourceFilter = '' | 'databench_artifact' | 'repository_reference' | 'existing_service'
type MutabilityFilter = '' | 'immutable' | 'mutable' | 'unknown'
type VerificationFilter =
  | ''
  | 'content_verified'
  | 'provider_verified'
  | 'operator_attested'
  | 'unverified'
type AliasFilter = '' | 'candidate' | 'none'
type LifecycleFilter = '' | 'registered' | 'active' | 'disabled'
type HealthFilter = '' | 'unknown' | 'healthy' | 'unhealthy'

export function ModelsRoute() {
  const { t } = useTranslation()
  const { artifact } = useSearch({ from: '/models' })
  const { base, connectionScope, token } = useBackend()
  const [registrationOpen, setRegistrationOpen] = useState(artifact !== undefined)
  const [draftSearch, setDraftSearch] = useState('')
  const [search, setSearch] = useState('')
  const [archive, setArchive] = useState<ArchiveFilter>('active')
  const [sourceKind, setSourceKind] = useState<SourceFilter>('')
  const [sourceMutability, setSourceMutability] = useState<MutabilityFilter>('')
  const [verification, setVerification] = useState<VerificationFilter>('')
  const [taskFamily, setTaskFamily] = useState('')
  const [artifactKind, setArtifactKind] = useState<'' | 'lora_adapter'>('')
  const [alias, setAlias] = useState<AliasFilter>('')
  const [deploymentLifecycle, setDeploymentLifecycle] = useState<LifecycleFilter>('')
  const [deploymentHealth, setDeploymentHealth] = useState<HealthFilter>('')
  const [tag, setTag] = useState('')
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const pageIndex = cursors.length - 1
  const modelsQuery = useQuery({
    queryKey: [
      connectionScope,
      base,
      'models',
      search,
      archive,
      sourceKind,
      sourceMutability,
      verification,
      taskFamily,
      artifactKind,
      artifact,
      alias,
      deploymentLifecycle,
      deploymentHealth,
      tag,
      cursors[pageIndex],
    ],
    queryFn: ({ signal }) =>
      listModelsV2({
        archive,
        base,
        cursor: cursors[pageIndex] ?? null,
        limit: 20,
        search,
        signal,
        ...(sourceKind === '' ? {} : { sourceKind }),
        ...(sourceMutability === '' ? {} : { sourceMutability }),
        ...(verification === '' ? {} : { verificationLevel: verification }),
        ...(taskFamily.trim() === '' ? {} : { taskFamily: taskFamily.trim() }),
        ...(artifactKind === '' ? {} : { artifactKind }),
        ...(artifact === undefined ? {} : { artifactId: artifact }),
        ...(alias === '' ? {} : { alias }),
        ...(deploymentLifecycle === '' ? {} : { deploymentLifecycle }),
        ...(deploymentHealth === '' ? {} : { deploymentHealth }),
        ...(tag.trim() === '' ? {} : { tag: tag.trim() }),
        token,
      }),
    retry: false,
  })
  const registrationModelsQuery = useInfiniteQuery({
    queryKey: [connectionScope, base, 'models', 'registration-targets'],
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
    enabled: registrationOpen,
    retry: false,
  })
  const registrationModels = useMemo(
    () => registrationModelsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [registrationModelsQuery.data?.pages],
  )
  const resetPage = (): void => setCursors([null])

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-5 border-border border-b pb-5">
        <div>
          <p className="font-medium text-primary text-xs uppercase tracking-[0.18em]">
            {t('models.eyebrow')}
          </p>
          <h1 className="mt-2 font-semibold text-3xl tracking-tight">{t('models.title')}</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
            {t('models.description')}
          </p>
        </div>
        <Button onClick={() => setRegistrationOpen(true)} type="button">
          <Plus aria-hidden="true" size={16} />
          {t('models.register')}
        </Button>
      </header>

      {registrationOpen ? (
        <RegistrationWorkflow
          models={registrationModels}
          modelsError={registrationModelsQuery.error}
          modelsHasMore={registrationModelsQuery.hasNextPage}
          modelsLoading={registrationModelsQuery.isLoading}
          modelsLoadingMore={registrationModelsQuery.isFetchingNextPage}
          onLoadMoreModels={() => void registrationModelsQuery.fetchNextPage()}
          onClose={() => setRegistrationOpen(false)}
          {...(artifact === undefined ? {} : { initialArtifactId: artifact })}
        />
      ) : null}

      <form
        className="grid grid-cols-[minmax(16rem,1fr)_12rem_14rem_auto] items-end gap-3 max-lg:grid-cols-2 max-sm:grid-cols-1"
        onSubmit={(event) => {
          event.preventDefault()
          setSearch(draftSearch.trim())
          resetPage()
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-muted-foreground text-xs">{t('models.search')}</span>
          <span className="relative block">
            <Search
              aria-hidden="true"
              className="absolute top-1/2 left-3 -translate-y-1/2 text-dim-foreground"
              size={15}
            />
            <input
              className="input pl-9"
              onChange={(event) => {
                setDraftSearch(event.target.value)
                setSearch(event.target.value.trim())
                resetPage()
              }}
              placeholder={t('models.searchPlaceholder')}
              value={draftSearch}
            />
          </span>
        </label>
        <FilterSelect
          label={t('models.archive')}
          onChange={(value) => {
            setArchive(value as ArchiveFilter)
            resetPage()
          }}
          value={archive}
        >
          <option value="active">{t('models.archiveActive')}</option>
          <option value="archived">{t('models.archiveArchived')}</option>
          <option value="all">{t('models.archiveAll')}</option>
        </FilterSelect>
        <FilterSelect
          label={t('models.source')}
          onChange={(value) => {
            setSourceKind(value as SourceFilter)
            resetPage()
          }}
          value={sourceKind}
        >
          <option value="">{t('models.sourceAll')}</option>
          <option value="databench_artifact">{t('models.sourceArtifact')}</option>
          <option value="repository_reference">{t('models.sourceRepository')}</option>
          <option value="existing_service">{t('models.sourceService')}</option>
        </FilterSelect>
        <Button type="submit" variant="outline">
          {t('common.apply')}
        </Button>
      </form>

      <details className="border-border border-y py-3">
        <summary className="cursor-pointer select-none font-medium text-sm text-primary">
          {t('models.moreFilters')}
        </summary>
        <div className="mt-4 grid grid-cols-4 gap-3 max-xl:grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
          <FilterSelect
            label={t('models.mutabilityLabel')}
            onChange={(value) => {
              setSourceMutability(value as MutabilityFilter)
              resetPage()
            }}
            value={sourceMutability}
          >
            <option value="">{t('models.filterAll')}</option>
            {(['immutable', 'mutable', 'unknown'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`models.mutability.${value}`)}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label={t('models.verificationLabel')}
            onChange={(value) => {
              setVerification(value as VerificationFilter)
              resetPage()
            }}
            value={verification}
          >
            <option value="">{t('models.filterAll')}</option>
            {(
              ['content_verified', 'provider_verified', 'operator_attested', 'unverified'] as const
            ).map((value) => (
              <option key={value} value={value}>
                {t(`models.verification.${value}`)}
              </option>
            ))}
          </FilterSelect>
          <FormInput
            label={t('models.taskFamily')}
            onChange={(value) => {
              setTaskFamily(value)
              resetPage()
            }}
            value={taskFamily}
          />
          <FormInput
            label={t('models.tagFilter')}
            onChange={(value) => {
              setTag(value)
              resetPage()
            }}
            value={tag}
          />
          <FilterSelect
            label={t('models.artifactKind')}
            onChange={(value) => {
              setArtifactKind(value as '' | 'lora_adapter')
              resetPage()
            }}
            value={artifactKind}
          >
            <option value="">{t('models.filterAll')}</option>
            <option value="lora_adapter">LoRA adapter</option>
          </FilterSelect>
          <FilterSelect
            label={t('models.aliasStage')}
            onChange={(value) => {
              setAlias(value as AliasFilter)
              resetPage()
            }}
            value={alias}
          >
            <option value="">{t('models.filterAll')}</option>
            <option value="candidate">candidate</option>
            <option value="none">{t('models.noCandidate')}</option>
          </FilterSelect>
          <FilterSelect
            label={t('models.lifecycleLabel')}
            onChange={(value) => {
              setDeploymentLifecycle(value as LifecycleFilter)
              resetPage()
            }}
            value={deploymentLifecycle}
          >
            <option value="">{t('models.filterAll')}</option>
            {(['registered', 'active', 'disabled'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`models.lifecycle.${value}`)}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label={t('models.healthLabel')}
            onChange={(value) => {
              setDeploymentHealth(value as HealthFilter)
              resetPage()
            }}
            value={deploymentHealth}
          >
            <option value="">{t('models.filterAll')}</option>
            {(['unknown', 'healthy', 'unhealthy'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`models.health.${value}`)}
              </option>
            ))}
          </FilterSelect>
        </div>
      </details>

      {modelsQuery.isLoading ? <Spinner label={t('models.loading')} /> : null}
      {modelsQuery.isError ? <ErrorState error={modelsQuery.error} /> : null}
      {modelsQuery.data !== undefined ? <ModelRegistryResults page={modelsQuery.data} /> : null}
      {modelsQuery.data !== undefined ? (
        <nav aria-label={t('models.pagination')} className="flex items-center justify-between">
          <Button
            disabled={pageIndex === 0}
            onClick={() => setCursors((current) => current.slice(0, -1))}
            type="button"
            variant="ghost"
          >
            <ArrowLeft aria-hidden="true" size={15} />
            {t('common.prev')}
          </Button>
          <span className="text-dim-foreground text-xs">
            {t('models.page', { page: pageIndex + 1 })}
          </span>
          <Button
            disabled={modelsQuery.data.next_cursor === null}
            onClick={() => {
              const cursor = modelsQuery.data.next_cursor
              if (cursor !== null) setCursors((current) => [...current, cursor])
            }}
            type="button"
            variant="ghost"
          >
            {t('common.next')}
            <ArrowRight aria-hidden="true" size={15} />
          </Button>
        </nav>
      ) : null}
    </section>
  )
}

export function ModelRegistryResults({ page }: { readonly page: ModelPageV2 }) {
  const { t } = useTranslation()
  if (page.items.length === 0) {
    return (
      <div className="border-border border-y py-16 text-center text-muted-foreground text-sm">
        {t('models.empty')}
      </div>
    )
  }
  return (
    <>
      <TableContainer aria-label={t('models.tableLabel')} className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('models.model')}</TableHead>
              <TableHead>{t('models.candidate')}</TableHead>
              <TableHead>{t('models.source')}</TableHead>
              <TableHead>{t('models.baseModel')}</TableHead>
              <TableHead>{t('models.latestEvaluation')}</TableHead>
              <TableHead>{t('models.deployments')}</TableHead>
              <TableHead>{t('models.updated')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.map((item) => (
              <TableRow key={item.model.id}>
                <TableCell>
                  <Link
                    className="font-medium transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-none"
                    params={{ modelId: item.model.id }}
                    to="/models/$modelId"
                  >
                    {item.model.display_name}
                  </Link>
                  <p className="mt-1 text-dim-foreground text-xs">
                    {item.model.key} · {t('models.versionCount', { count: item.version_count })}
                  </p>
                </TableCell>
                <TableCell>
                  {item.candidate === null ? (
                    <span className="text-dim-foreground">—</span>
                  ) : (
                    <div className="space-y-1">
                      <Badge tone="accent">{item.candidate.version_label}</Badge>
                      <p className="text-dim-foreground text-xs">
                        {t(`models.verification.${item.candidate.verification_level}`)}
                      </p>
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  {item.candidate === null
                    ? '—'
                    : t(`models.sources.${item.candidate.source_kind}`)}
                </TableCell>
                <TableCell className="max-w-64 break-words text-muted-foreground">
                  {item.candidate?.base_model_reference ?? '—'}
                </TableCell>
                <TableCell>
                  {item.latest_comparable_evaluation === null ? (
                    <span className="text-dim-foreground">—</span>
                  ) : (
                    <div className="space-y-1">
                      <span className="font-medium tabular-nums">
                        {item.latest_comparable_evaluation.score}
                      </span>
                      <p className="text-dim-foreground text-xs">
                        {item.latest_comparable_evaluation.benchmark} ·{' '}
                        {item.latest_comparable_evaluation.output_key}
                      </p>
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <span className="font-medium tabular-nums">{item.deployment_summary.active}</span>
                  <span className="ml-2 text-success text-xs">
                    {t('models.healthy', { count: item.deployment_summary.healthy_active })}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatDateTime(item.model.updated_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <section aria-label={t('models.mobileListLabel')} className="sm:hidden">
        <ol className="divide-y divide-border border-border border-y">
          {page.items.map((item) => (
            <li className="py-3" key={item.model.id}>
              <Link
                className="group block min-h-11 rounded-[3px] py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                params={{ modelId: item.model.id }}
                to="/models/$modelId"
              >
                <span className="block font-medium transition-colors group-hover:text-primary">
                  {item.model.display_name}
                </span>
                <span className="mt-1 block break-all text-dim-foreground text-xs">
                  {item.model.key} · {t('models.versionCount', { count: item.version_count })}
                </span>
              </Link>
              <dl className="mt-3 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('models.candidate')}</dt>
                <dd className="min-w-0">
                  {item.candidate === null ? (
                    <span className="text-dim-foreground">—</span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge tone="accent">{item.candidate.version_label}</Badge>
                      <span className="text-dim-foreground text-xs">
                        {t(`models.verification.${item.candidate.verification_level}`)}
                      </span>
                    </div>
                  )}
                </dd>
                <dt className="text-muted-foreground">{t('models.source')}</dt>
                <dd className="min-w-0 break-words">
                  {item.candidate === null
                    ? '—'
                    : t(`models.sources.${item.candidate.source_kind}`)}
                </dd>
                <dt className="text-muted-foreground">{t('models.baseModel')}</dt>
                <dd className="min-w-0 break-all text-muted-foreground">
                  {item.candidate?.base_model_reference ?? '—'}
                </dd>
                <dt className="text-muted-foreground">{t('models.deployments')}</dt>
                <dd className="min-w-0">
                  <span className="font-medium tabular-nums">{item.deployment_summary.active}</span>
                  <span className="ml-2 text-success text-xs">
                    {t('models.healthy', { count: item.deployment_summary.healthy_active })}
                  </span>
                </dd>
                <dt className="text-muted-foreground">{t('models.latestEvaluation')}</dt>
                <dd className="min-w-0">
                  {item.latest_comparable_evaluation === null
                    ? '—'
                    : `${item.latest_comparable_evaluation.score} · ${item.latest_comparable_evaluation.benchmark} / ${item.latest_comparable_evaluation.output_key}`}
                </dd>
                <dt className="text-muted-foreground">{t('models.updated')}</dt>
                <dd className="min-w-0 text-muted-foreground">
                  {formatDateTime(item.model.updated_at)}
                </dd>
              </dl>
            </li>
          ))}
        </ol>
      </section>
    </>
  )
}

function RegistrationWorkflow({
  initialArtifactId,
  models,
  modelsError,
  modelsHasMore,
  modelsLoading,
  modelsLoadingMore,
  onClose,
  onLoadMoreModels,
}: {
  readonly initialArtifactId?: string
  readonly models: ModelPageV2['items']
  readonly modelsError: unknown
  readonly modelsHasMore: boolean
  readonly modelsLoading: boolean
  readonly modelsLoadingMore: boolean
  readonly onClose: () => void
  readonly onLoadMoreModels: () => void
}) {
  const { t } = useTranslation()
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)
  const [targetKind, setTargetKind] = useState<'create_model' | 'existing_model'>('create_model')
  const [existingModelId, setExistingModelId] = useState(models[0]?.model.id ?? '')
  const [modelKey, setModelKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [taskFamily, setTaskFamily] = useState('chat')
  const [tags, setTags] = useState('')
  const [versionLabel, setVersionLabel] = useState('r1')
  const [sourceKind, setSourceKind] = useState<
    'databench_artifact' | 'repository_reference' | 'existing_service'
  >('databench_artifact')
  const [artifactId, setArtifactId] = useState(initialArtifactId ?? '')
  const [repositoryProvider, setRepositoryProvider] = useState<'modelscope' | 'operator_managed'>(
    'modelscope',
  )
  const [repositoryId, setRepositoryId] = useState('')
  const [repositoryRevision, setRepositoryRevision] = useState('')
  const [repositoryRevisionKind, setRepositoryRevisionKind] = useState<
    'commit' | 'digest' | 'tag' | 'opaque'
  >('commit')
  const [baseModelReference, setBaseModelReference] = useState('')
  const [baseModelRevision, setBaseModelRevision] = useState('')
  const [externalModelRef, setExternalModelRef] = useState('')
  const [externalVersionRef, setExternalVersionRef] = useState('')
  const [declaredReferenceKind, setDeclaredReferenceKind] = useState<
    'immutable_version' | 'mutable_alias' | 'opaque'
  >('immutable_version')
  const [connectivityScope, setConnectivityScope] = useState<'private_network' | 'public_network'>(
    'private_network',
  )
  const [deploymentDisplayName, setDeploymentDisplayName] = useState('')
  const [servedModelName, setServedModelName] = useState('')
  const [endpointBaseUrl, setEndpointBaseUrl] = useState('')
  const [authProfile, setAuthProfile] = useState<'none' | 'bearer_ref'>('none')
  const [credentialRef, setCredentialRef] = useState('')
  const [declaredInterface, setDeclaredInterface] = useState<
    'chat_completions' | 'embeddings' | 'vision' | 'tools'
  >('chat_completions')
  const [contextLimit, setContextLimit] = useState('')
  const [plan, setPlan] = useState<ModelRegistrationPlanV2 | null>(null)
  const artifactsQuery = useInfiniteQuery({
    queryKey: [connectionScope, base, 'model-registration-artifacts'],
    queryFn: ({ signal, pageParam }) =>
      listModelArtifactsV2({
        base,
        cursor: pageParam,
        limit: 100,
        registrationStatus: 'all',
        signal,
        token,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: sourceKind === 'databench_artifact',
    retry: false,
  })
  const artifacts = useMemo(
    () => artifactsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [artifactsQuery.data?.pages],
  )
  const selectedArtifact = artifacts.find((item) => item.id === artifactId)
  const candidateExpectedVersionId = candidateExpectedVersionIdV2(
    models,
    targetKind,
    existingModelId,
  )
  const registrationRequest = useMemo<ModelRegistrationRequestV2 | null>(() => {
    if (versionLabel.trim() === '') return null
    const target =
      targetKind === 'existing_model'
        ? existingModelId === ''
          ? null
          : ({ kind: 'existing_model', model_id: existingModelId } as const)
        : modelKey.trim() === '' || displayName.trim() === ''
          ? null
          : ({
              kind: 'create_model',
              key: modelKey.trim(),
              display_name: displayName.trim(),
              description: description.trim(),
              task_family: taskFamily.trim() === '' ? null : taskFamily.trim(),
              tags: tags
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item !== ''),
            } as const)
    if (target === null) return null
    if (sourceKind === 'databench_artifact') {
      if (artifactId === '') return null
      return {
        target,
        version_label: versionLabel.trim(),
        alias: { alias: 'candidate', expected_version_id: candidateExpectedVersionId },
        source: { kind: 'databench_artifact', artifact_id: artifactId },
      }
    }
    if (sourceKind === 'existing_service') {
      if (
        externalModelRef.trim() === '' ||
        externalVersionRef.trim() === '' ||
        deploymentDisplayName.trim() === '' ||
        servedModelName.trim() === '' ||
        endpointBaseUrl.trim() === '' ||
        (authProfile === 'bearer_ref' && credentialRef.trim() === '')
      ) {
        return null
      }
      const parsedContextLimit = contextLimit.trim() === '' ? null : Number(contextLimit)
      if (
        parsedContextLimit !== null &&
        (!Number.isSafeInteger(parsedContextLimit) || parsedContextLimit < 1)
      ) {
        return null
      }
      return {
        target,
        version_label: versionLabel.trim(),
        source: {
          kind: 'existing_service',
          provider: 'openai_compatible',
          external_model_ref: externalModelRef.trim(),
          external_version_ref: externalVersionRef.trim(),
          declared_reference_kind: declaredReferenceKind,
          base_model:
            baseModelReference.trim() === ''
              ? null
              : {
                  reference: baseModelReference.trim(),
                  revision: baseModelRevision.trim() === '' ? null : baseModelRevision.trim(),
                },
          deployment: {
            display_name: deploymentDisplayName.trim(),
            served_model_name: servedModelName.trim(),
            connectivity_scope: connectivityScope,
            endpoint_base_url: endpointBaseUrl.trim(),
            auth_profile: authProfile,
            credential_ref: authProfile === 'none' ? null : credentialRef.trim(),
            declared_capabilities: {
              interfaces: [declaredInterface],
              context_limit: parsedContextLimit,
            },
          },
        },
      }
    }
    if (repositoryId.trim() === '' || repositoryRevision.trim() === '') return null
    return {
      target,
      version_label: versionLabel.trim(),
      source: {
        kind: 'repository_reference',
        provider: repositoryProvider,
        repository_id: repositoryId.trim(),
        revision: repositoryRevision.trim(),
        revision_kind: repositoryRevisionKind,
        base_model:
          baseModelReference.trim() === ''
            ? null
            : {
                reference: baseModelReference.trim(),
                revision: baseModelRevision.trim() === '' ? null : baseModelRevision.trim(),
              },
      },
    }
  }, [
    artifactId,
    baseModelReference,
    baseModelRevision,
    candidateExpectedVersionId,
    description,
    authProfile,
    displayName,
    connectivityScope,
    contextLimit,
    credentialRef,
    declaredInterface,
    declaredReferenceKind,
    deploymentDisplayName,
    endpointBaseUrl,
    externalModelRef,
    externalVersionRef,
    existingModelId,
    modelKey,
    repositoryId,
    repositoryProvider,
    repositoryRevision,
    repositoryRevisionKind,
    servedModelName,
    sourceKind,
    tags,
    targetKind,
    taskFamily,
    versionLabel,
  ])
  const inspect = useMutation({
    mutationFn: async () => {
      if (registrationRequest === null) throw new Error('Registration request is incomplete')
      return await inspectModelRegistrationV2({
        base,
        request: registrationRequest,
        token,
      })
    },
    onSuccess: setPlan,
  })
  const commit = useMutation({
    mutationFn: async () => {
      if (registrationRequest === null || plan === null) {
        throw new Error('Registration must be inspected before commit')
      }
      return await commitModelRegistrationV2({
        base,
        request: {
          request: registrationRequest,
          expected_registration_digest: plan.registration_digest,
        },
        token,
      })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [connectionScope, base, 'models'] }),
        queryClient.invalidateQueries({
          queryKey: [connectionScope, base, 'model-registration-artifacts'],
        }),
      ])
    },
    onError: async (error) => {
      if (modelRegistrationConflictReason(error) === 'model_alias_conflict') {
        await queryClient.invalidateQueries({ queryKey: [connectionScope, base, 'models'] })
      }
    },
  })
  const activate = useMutation({
    mutationFn: async () => {
      if (commit.data?.deployment_id === null || commit.data === undefined) {
        throw new Error('Registration did not create a Deployment')
      }
      return await activateModelVersionDeploymentV2({
        base,
        token,
        versionId: commit.data.model_version_id,
        deploymentId: commit.data.deployment_id,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [connectionScope, base, 'models'] })
    },
  })
  const canContinueModel =
    versionLabel.trim() !== '' &&
    (targetKind === 'existing_model'
      ? existingModelId !== ''
      : modelKey.trim() !== '' && displayName.trim() !== '')

  return (
    <section
      aria-labelledby="model-registration-title"
      className="border-border border-y bg-surface/55 px-5 py-5"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-lg" id="model-registration-title">
            {t('models.wizard.title')}
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">{t('models.wizard.description')}</p>
        </div>
        <Button aria-label={t('common.cancel')} onClick={onClose} size="sm" variant="ghost">
          <X aria-hidden="true" size={16} />
        </Button>
      </header>
      <ol className="mt-5 grid grid-cols-4 border-border border-y max-sm:grid-cols-2">
        {['model', 'source', 'inspect', 'commit'].map((name, index) => (
          <li
            aria-current={index === step ? 'step' : undefined}
            className={`flex items-center gap-2 border-border px-3 py-2 text-xs ${
              index === step ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
            } ${index > 0 ? 'border-l' : ''}`}
            key={name}
          >
            <span className="font-semibold tabular-nums">0{index + 1}</span>
            {t(`models.wizard.steps.${name}`)}
          </li>
        ))}
      </ol>

      <div className="mt-5 min-h-56">
        {step === 0 ? (
          <div className="grid max-w-4xl grid-cols-2 gap-4 max-sm:grid-cols-1">
            <FormSelect
              label={t('models.wizard.target')}
              onChange={(value) => setTargetKind(value as typeof targetKind)}
              value={targetKind}
            >
              <option value="create_model">{t('models.wizard.createModel')}</option>
              <option value="existing_model">{t('models.wizard.existingModel')}</option>
            </FormSelect>
            {targetKind === 'existing_model' ? (
              <div>
                <FormSelect
                  label={t('models.wizard.model')}
                  onChange={setExistingModelId}
                  value={existingModelId}
                >
                  <option value="">
                    {modelsLoading ? t('models.loading') : t('models.wizard.chooseModel')}
                  </option>
                  {models.map((item) => (
                    <option key={item.model.id} value={item.model.id}>
                      {item.model.display_name}
                    </option>
                  ))}
                </FormSelect>
                {modelsHasMore ? (
                  <Button
                    className="mt-2"
                    disabled={modelsLoadingMore}
                    onClick={onLoadMoreModels}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {t('common.next')}
                  </Button>
                ) : null}
                {modelsError !== null ? <ErrorState error={modelsError} /> : null}
              </div>
            ) : (
              <FormInput label={t('models.wizard.key')} onChange={setModelKey} value={modelKey} />
            )}
            {targetKind === 'create_model' ? (
              <>
                <FormInput
                  label={t('models.wizard.displayName')}
                  onChange={setDisplayName}
                  value={displayName}
                />
                <FormInput
                  label={t('models.wizard.descriptionLabel')}
                  onChange={setDescription}
                  value={description}
                />
                <FormInput
                  label={t('models.wizard.taskFamily')}
                  onChange={setTaskFamily}
                  value={taskFamily}
                />
                <FormInput label={t('models.wizard.tags')} onChange={setTags} value={tags} />
              </>
            ) : null}
            <FormInput
              label={t('models.wizard.versionLabel')}
              onChange={setVersionLabel}
              value={versionLabel}
            />
          </div>
        ) : null}
        {step === 1 ? (
          <div className="space-y-4">
            <FormSelect
              label={t('models.wizard.sourceType')}
              onChange={(value) => {
                setSourceKind(value as typeof sourceKind)
                setPlan(null)
              }}
              value={sourceKind}
            >
              <option value="databench_artifact">{t('models.wizard.sourceArtifact')}</option>
              <option value="repository_reference">{t('models.wizard.sourceRepository')}</option>
              <option value="existing_service">{t('models.wizard.sourceService')}</option>
            </FormSelect>
            {sourceKind === 'databench_artifact' ? (
              <ArtifactPicker
                artifacts={artifacts}
                error={artifactsQuery.error}
                hasMore={artifactsQuery.hasNextPage}
                loading={artifactsQuery.isLoading}
                loadingMore={artifactsQuery.isFetchingNextPage}
                onChange={setArtifactId}
                onLoadMore={() => void artifactsQuery.fetchNextPage()}
                selected={artifactId}
              />
            ) : sourceKind === 'repository_reference' ? (
              <div className="grid max-w-4xl grid-cols-2 gap-4 max-sm:grid-cols-1">
                <FormSelect
                  label={t('models.wizard.repositoryProvider')}
                  onChange={(value) => setRepositoryProvider(value as typeof repositoryProvider)}
                  value={repositoryProvider}
                >
                  <option value="modelscope">ModelScope</option>
                  <option value="operator_managed">{t('models.wizard.operatorManaged')}</option>
                </FormSelect>
                <FormInput
                  label={t('models.wizard.repositoryId')}
                  onChange={setRepositoryId}
                  value={repositoryId}
                />
                <FormInput
                  label={t('models.wizard.repositoryRevision')}
                  onChange={setRepositoryRevision}
                  value={repositoryRevision}
                />
                <FormSelect
                  label={t('models.wizard.revisionKind')}
                  onChange={(value) =>
                    setRepositoryRevisionKind(value as typeof repositoryRevisionKind)
                  }
                  value={repositoryRevisionKind}
                >
                  {(['commit', 'digest', 'tag', 'opaque'] as const).map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`models.wizard.revisionKinds.${kind}`)}
                    </option>
                  ))}
                </FormSelect>
                <FormInput
                  label={t('models.wizard.baseModelOptional')}
                  onChange={setBaseModelReference}
                  value={baseModelReference}
                />
                <FormInput
                  label={t('models.wizard.baseRevisionOptional')}
                  onChange={setBaseModelRevision}
                  value={baseModelRevision}
                />
                <p className="col-span-2 border-primary border-l-2 bg-accent/45 px-4 py-3 text-muted-foreground text-sm max-sm:col-span-1">
                  {t('models.wizard.repositoryBoundary')}
                </p>
              </div>
            ) : (
              <div className="grid max-w-5xl grid-cols-2 gap-4 max-sm:grid-cols-1">
                <FormInput
                  label={t('models.wizard.externalModelRef')}
                  onChange={setExternalModelRef}
                  value={externalModelRef}
                />
                <FormInput
                  label={t('models.wizard.externalVersionRef')}
                  onChange={setExternalVersionRef}
                  value={externalVersionRef}
                />
                <FormSelect
                  label={t('models.wizard.referenceKind')}
                  onChange={(value) =>
                    setDeclaredReferenceKind(value as typeof declaredReferenceKind)
                  }
                  value={declaredReferenceKind}
                >
                  {(['immutable_version', 'mutable_alias', 'opaque'] as const).map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`models.wizard.referenceKinds.${kind}`)}
                    </option>
                  ))}
                </FormSelect>
                <FormSelect
                  label={t('models.wizard.serviceLocation')}
                  onChange={(value) => setConnectivityScope(value as typeof connectivityScope)}
                  value={connectivityScope}
                >
                  <option value="private_network">{t('models.wizard.privateService')}</option>
                  <option value="public_network">{t('models.wizard.publicService')}</option>
                </FormSelect>
                <FormInput
                  label={t('models.wizard.deploymentDisplayName')}
                  onChange={setDeploymentDisplayName}
                  value={deploymentDisplayName}
                />
                <FormInput
                  label={t('models.wizard.servedModelName')}
                  onChange={setServedModelName}
                  value={servedModelName}
                />
                <FormInput
                  label={t('models.wizard.endpointBaseUrl')}
                  onChange={setEndpointBaseUrl}
                  value={endpointBaseUrl}
                />
                <FormSelect
                  label={t('models.wizard.authProfile')}
                  onChange={(value) => setAuthProfile(value as typeof authProfile)}
                  value={authProfile}
                >
                  <option value="none">{t('models.wizard.noAuth')}</option>
                  <option value="bearer_ref">{t('models.wizard.bearerRef')}</option>
                </FormSelect>
                {authProfile === 'bearer_ref' ? (
                  <FormInput
                    label={t('models.wizard.credentialRef')}
                    onChange={setCredentialRef}
                    value={credentialRef}
                  />
                ) : null}
                <FormSelect
                  label={t('models.wizard.declaredInterface')}
                  onChange={(value) => setDeclaredInterface(value as typeof declaredInterface)}
                  value={declaredInterface}
                >
                  {(['chat_completions', 'embeddings', 'vision', 'tools'] as const).map(
                    (interfaceName) => (
                      <option key={interfaceName} value={interfaceName}>
                        {interfaceName}
                      </option>
                    ),
                  )}
                </FormSelect>
                <FormInput
                  label={t('models.wizard.contextLimit')}
                  onChange={setContextLimit}
                  value={contextLimit}
                />
                <FormInput
                  label={t('models.wizard.baseModelOptional')}
                  onChange={setBaseModelReference}
                  value={baseModelReference}
                />
                <FormInput
                  label={t('models.wizard.baseRevisionOptional')}
                  onChange={setBaseModelRevision}
                  value={baseModelRevision}
                />
                <p className="col-span-2 border-warning border-l-2 bg-warning/10 px-4 py-3 text-muted-foreground text-sm max-sm:col-span-1">
                  {connectivityScope === 'public_network'
                    ? t('models.wizard.publicActivationBoundary')
                    : t('models.wizard.serviceBoundary')}
                </p>
              </div>
            )}
          </div>
        ) : null}
        {step === 2 ? (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">{t('models.wizard.inspectHint')}</p>
            <SummaryLine label={t('models.wizard.target')} value={targetKind} />
            <SummaryLine
              label={t('models.wizard.sourceType')}
              value={
                sourceKind === 'databench_artifact'
                  ? (selectedArtifact?.display_name ?? artifactId)
                  : sourceKind === 'repository_reference'
                    ? `${repositoryProvider} · ${repositoryId}@${repositoryRevision}`
                    : `${externalModelRef}@${externalVersionRef} · ${deploymentDisplayName}`
              }
            />
            {plan === null ? null : (
              <div className="border-primary border-l-2 bg-accent/55 px-4 py-3">
                <p className="flex items-center gap-2 font-medium text-sm">
                  <Check aria-hidden="true" className="text-success" size={16} />
                  {t('models.wizard.inspected')}
                </p>
                <code className="mt-2 block break-all text-xs">{plan.registration_digest}</code>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge tone="accent">
                    {t(`models.mutability.${plan.classification.source_mutability}`)}
                  </Badge>
                  <Badge tone="muted">
                    {t(`models.verification.${plan.classification.verification_level}`)}
                  </Badge>
                </div>
                {plan.warnings.map((warning) => (
                  <p className="mt-2 text-warning text-xs" key={`${warning.code}:${warning.path}`}>
                    {warning.message}
                  </p>
                ))}
              </div>
            )}
            {inspect.isError ? <ErrorState error={inspect.error} /> : null}
          </div>
        ) : null}
        {step === 3 ? (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">{t('models.wizard.commitHint')}</p>
            <SummaryLine
              label={t('models.wizard.digest')}
              value={plan?.registration_digest ?? '—'}
            />
            {commit.data === undefined ? null : (
              <div className="border-success border-l-2 bg-success/10 px-4 py-3">
                <p className="font-medium text-success">{t('models.wizard.complete')}</p>
                <Link
                  className="mt-2 inline-block text-sm text-primary hover:underline"
                  params={{ modelId: commit.data.model_id }}
                  to="/models/$modelId"
                >
                  {t('models.wizard.openModel')}
                </Link>
                {commit.data.deployment_id === null ? null : (
                  <div className="mt-3 border-border border-t pt-3">
                    <p className="text-muted-foreground text-xs">
                      {t('models.wizard.registeredDeployment')}
                    </p>
                    {activate.data === undefined ? (
                      <Button
                        className="mt-2"
                        disabled={activate.isPending}
                        onClick={() => activate.mutate()}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {activate.isPending
                          ? t('models.wizard.activating')
                          : t('models.wizard.activateNow')}
                      </Button>
                    ) : (
                      <Badge
                        className="mt-2"
                        tone={activate.data.availability === 'available' ? 'green' : 'orange'}
                      >
                        {t(`models.lifecycle.${activate.data.lifecycle}`)} ·{' '}
                        {t(`models.availability.${activate.data.availability}`)}
                      </Badge>
                    )}
                    {activate.isError ? <ErrorState error={activate.error} /> : null}
                  </div>
                )}
              </div>
            )}
            {commit.isError ? (
              <>
                <ErrorState error={commit.error} />
                <RegistrationConflictRecovery error={commit.error} />
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <footer className="mt-5 flex items-center justify-between border-border border-t pt-4">
        <Button
          disabled={step === 0 || commit.isPending}
          onClick={() => {
            setStep((current) => Math.max(0, current - 1))
            setPlan(null)
            commit.reset()
          }}
          type="button"
          variant="ghost"
        >
          <ArrowLeft aria-hidden="true" size={15} />
          {t('common.prev')}
        </Button>
        {step === 0 ? (
          <Button disabled={!canContinueModel} onClick={() => setStep(1)} type="button">
            {t('common.next')}
            <ArrowRight aria-hidden="true" size={15} />
          </Button>
        ) : null}
        {step === 1 ? (
          <Button
            disabled={
              sourceKind === 'databench_artifact'
                ? artifactId === ''
                : sourceKind === 'repository_reference'
                  ? repositoryId.trim() === '' || repositoryRevision.trim() === ''
                  : registrationRequest === null
            }
            onClick={() => setStep(2)}
            type="button"
          >
            {t('common.next')}
            <ArrowRight aria-hidden="true" size={15} />
          </Button>
        ) : null}
        {step === 2 ? (
          plan === null ? (
            <Button
              disabled={registrationRequest === null || inspect.isPending}
              onClick={() => inspect.mutate()}
              type="button"
            >
              {inspect.isPending ? t('models.wizard.inspecting') : t('models.wizard.inspect')}
            </Button>
          ) : (
            <Button onClick={() => setStep(3)} type="button">
              {t('models.wizard.reviewCommit')}
              <ArrowRight aria-hidden="true" size={15} />
            </Button>
          )
        ) : null}
        {step === 3 && commit.data === undefined ? (
          <Button disabled={commit.isPending} onClick={() => commit.mutate()} type="button">
            {commit.isPending ? t('models.wizard.committing') : t('models.wizard.commit')}
          </Button>
        ) : null}
        {step === 3 && commit.data !== undefined ? (
          <Button onClick={onClose} type="button" variant="outline">
            {t('models.wizard.done')}
          </Button>
        ) : null}
      </footer>
    </section>
  )
}

function RegistrationConflictRecovery({ error }: { readonly error: unknown }) {
  const { t } = useTranslation()
  const reason = modelRegistrationConflictReason(error)
  const hint =
    reason === 'model_key_conflict'
      ? t('models.wizard.modelKeyConflictHint')
      : reason === 'model_alias_conflict'
        ? t('models.wizard.aliasConflictHint')
        : reason === 'registration_digest_mismatch'
          ? t('models.wizard.digestMismatchHint')
          : null

  if (hint === null) return null
  return <p className="border-warning border-l-2 bg-warning/10 px-4 py-3 text-sm">{hint}</p>
}

export function candidateExpectedVersionIdV2(
  models: ModelPageV2['items'],
  targetKind: 'create_model' | 'existing_model',
  existingModelId: string,
): string | null {
  if (targetKind !== 'existing_model') return null
  return models.find((item) => item.model.id === existingModelId)?.candidate?.version_id ?? null
}

function modelRegistrationConflictReason(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'model_registry_conflict') return null
  if (error.detail === null || typeof error.detail !== 'object') return null
  if (!('reason' in error.detail) || typeof error.detail.reason !== 'string') return null
  return error.detail.reason
}

function ArtifactPicker({
  artifacts,
  error,
  hasMore,
  loading,
  loadingMore,
  onChange,
  onLoadMore,
  selected,
}: {
  readonly artifacts: readonly ModelArtifactV2[]
  readonly error: unknown
  readonly hasMore: boolean
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly onChange: (id: string) => void
  readonly onLoadMore: () => void
  readonly selected: string
}) {
  const { t } = useTranslation()
  if (loading) return <Spinner label={t('models.wizard.loadingArtifacts')} />
  if (error !== null) return <ErrorState error={error} />
  if (artifacts.length === 0) return <p>{t('models.wizard.noArtifacts')}</p>
  return (
    <div>
      <div className="grid gap-2">
        {artifacts.map((artifact) => (
          <label
            className={`flex cursor-pointer items-center justify-between gap-4 border px-4 py-3 transition-colors ${
              selected === artifact.id
                ? 'border-primary bg-accent/55'
                : 'border-border bg-surface hover:bg-surface-hover/55'
            }`}
            key={artifact.id}
          >
            <span>
              <strong className="block text-sm">{artifact.display_name}</strong>
              <span className="mt-1 block text-dim-foreground text-xs">
                {artifact.base_model.reference} · {artifact.artifact_kind}
              </span>
            </span>
            <input
              checked={selected === artifact.id}
              name="artifact"
              onChange={() => onChange(artifact.id)}
              type="radio"
              value={artifact.id}
            />
          </label>
        ))}
      </div>
      {hasMore ? (
        <Button
          className="mt-2"
          disabled={loadingMore}
          onClick={onLoadMore}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t('common.next')}
        </Button>
      ) : null}
    </div>
  )
}

function FilterSelect({
  children,
  label,
  onChange,
  value,
}: {
  readonly children: React.ReactNode
  readonly label: string
  readonly onChange: (value: string) => void
  readonly value: string
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-muted-foreground text-xs">{label}</span>
      <select className="input" onChange={(event) => onChange(event.target.value)} value={value}>
        {children}
      </select>
    </label>
  )
}

const FormSelect = FilterSelect

function FormInput({
  label,
  onChange,
  value,
}: {
  readonly label: string
  readonly onChange: (value: string) => void
  readonly value: string
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-muted-foreground text-xs">{label}</span>
      <input className="input" onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  )
}

function SummaryLine({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-4 border-border border-b py-2 text-sm max-sm:grid-cols-1 max-sm:gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all">{value}</span>
    </div>
  )
}
