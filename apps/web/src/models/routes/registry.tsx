import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Check, Plus, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
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
import {
  type ArtifactRegistrationPlanV2,
  type ArtifactRegistrationRequestV2,
  commitArtifactRegistrationV2,
  inspectArtifactRegistrationV2,
  listModelsV2,
  type ModelPageV2,
} from '@/models/api/registry.js'
import { listModelArtifactsV2, type ModelArtifactV2 } from '@/training/api/artifacts.js'

type ArchiveFilter = 'active' | 'archived' | 'all'
type SourceFilter = '' | 'databench_artifact' | 'repository_reference' | 'existing_service'

export function ModelsRoute() {
  const { t } = useTranslation()
  const { artifact } = useSearch({ from: '/models' })
  const { base, connectionScope, token } = useBackend()
  const [registrationOpen, setRegistrationOpen] = useState(artifact !== undefined)
  const [draftSearch, setDraftSearch] = useState('')
  const [search, setSearch] = useState('')
  const [archive, setArchive] = useState<ArchiveFilter>('active')
  const [sourceKind, setSourceKind] = useState<SourceFilter>('')
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const pageIndex = cursors.length - 1
  const modelsQuery = useQuery({
    queryKey: [connectionScope, base, 'models', search, archive, sourceKind, cursors[pageIndex]],
    queryFn: ({ signal }) =>
      listModelsV2({
        archive,
        base,
        cursor: cursors[pageIndex] ?? null,
        limit: 20,
        search,
        signal,
        ...(sourceKind === '' ? {} : { sourceKind }),
        token,
      }),
    retry: false,
  })
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
          models={modelsQuery.data}
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
              onChange={(event) => setDraftSearch(event.target.value)}
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
                  <span className="font-medium tabular-nums">{item.adopted_deployment_count}</span>
                  <span className="ml-2 text-success text-xs">
                    {t('models.healthy', { count: item.healthy_adopted_deployment_count })}
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
                  <span className="font-medium tabular-nums">{item.adopted_deployment_count}</span>
                  <span className="ml-2 text-success text-xs">
                    {t('models.healthy', { count: item.healthy_adopted_deployment_count })}
                  </span>
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
  onClose,
}: {
  readonly initialArtifactId?: string
  readonly models: ModelPageV2 | undefined
  readonly onClose: () => void
}) {
  const { t } = useTranslation()
  const { base, connectionScope, token } = useBackend()
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)
  const [targetKind, setTargetKind] = useState<'create_model' | 'existing_model'>('create_model')
  const [existingModelId, setExistingModelId] = useState(models?.items[0]?.model.id ?? '')
  const [modelKey, setModelKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [taskFamily, setTaskFamily] = useState('chat')
  const [tags, setTags] = useState('')
  const [versionLabel, setVersionLabel] = useState('r1')
  const [artifactId, setArtifactId] = useState(initialArtifactId ?? '')
  const [plan, setPlan] = useState<ArtifactRegistrationPlanV2 | null>(null)
  const artifactsQuery = useQuery({
    queryKey: [connectionScope, base, 'model-registration-artifacts'],
    queryFn: ({ signal }) =>
      listModelArtifactsV2({
        base,
        cursor: null,
        limit: 100,
        registrationStatus: 'all',
        signal,
        token,
      }),
    retry: false,
  })
  const selectedArtifact = artifactsQuery.data?.items.find((item) => item.id === artifactId)
  const registrationRequest = useMemo<ArtifactRegistrationRequestV2 | null>(() => {
    if (artifactId === '' || versionLabel.trim() === '') return null
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
    return {
      target,
      version_label: versionLabel.trim(),
      alias: { alias: 'candidate', expected_version_id: null },
      source: { kind: 'databench_artifact', artifact_id: artifactId },
    }
  }, [
    artifactId,
    description,
    displayName,
    existingModelId,
    modelKey,
    tags,
    targetKind,
    taskFamily,
    versionLabel,
  ])
  const inspect = useMutation({
    mutationFn: async () => {
      if (registrationRequest === null) throw new Error('Registration request is incomplete')
      return await inspectArtifactRegistrationV2({
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
      return await commitArtifactRegistrationV2({
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
        {['model', 'artifact', 'inspect', 'commit'].map((name, index) => (
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
              <FormSelect
                label={t('models.wizard.model')}
                onChange={setExistingModelId}
                value={existingModelId}
              >
                <option value="">{t('models.wizard.chooseModel')}</option>
                {(models?.items ?? []).map((item) => (
                  <option key={item.model.id} value={item.model.id}>
                    {item.model.display_name}
                  </option>
                ))}
              </FormSelect>
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
          <ArtifactPicker
            artifacts={artifactsQuery.data?.items ?? []}
            error={artifactsQuery.error}
            loading={artifactsQuery.isLoading}
            onChange={setArtifactId}
            selected={artifactId}
          />
        ) : null}
        {step === 2 ? (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">{t('models.wizard.inspectHint')}</p>
            <SummaryLine label={t('models.wizard.target')} value={targetKind} />
            <SummaryLine
              label={t('models.wizard.artifact')}
              value={selectedArtifact?.display_name ?? artifactId}
            />
            {plan === null ? null : (
              <div className="border-primary border-l-2 bg-accent/55 px-4 py-3">
                <p className="flex items-center gap-2 font-medium text-sm">
                  <Check aria-hidden="true" className="text-success" size={16} />
                  {t('models.wizard.inspected')}
                </p>
                <code className="mt-2 block break-all text-xs">{plan.registration_digest}</code>
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
              </div>
            )}
            {commit.isError ? <ErrorState error={commit.error} /> : null}
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
          <Button disabled={artifactId === ''} onClick={() => setStep(2)} type="button">
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

function ArtifactPicker({
  artifacts,
  error,
  loading,
  onChange,
  selected,
}: {
  readonly artifacts: readonly ModelArtifactV2[]
  readonly error: unknown
  readonly loading: boolean
  readonly onChange: (id: string) => void
  readonly selected: string
}) {
  const { t } = useTranslation()
  if (loading) return <Spinner label={t('models.wizard.loadingArtifacts')} />
  if (error !== null) return <ErrorState error={error} />
  if (artifacts.length === 0) return <p>{t('models.wizard.noArtifacts')}</p>
  return (
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
