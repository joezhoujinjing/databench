import { Link, useNavigate } from '@tanstack/react-router'
import { RotateCcw } from 'lucide-react'
import { type FormEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isApiError } from '@/api/errors.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { EmptyState, ErrorState, Spinner } from '@/components/common/State.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { CodeEditor } from '@/components/ui/code-editor.js'
import { Field, FormError } from '@/components/ui/field.js'
import { TextInput } from '@/components/ui/input.js'
import {
  PageHeader,
  PageShell,
  Surface,
  SurfaceBody,
  SurfaceDescription,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { Tabs } from '@/components/ui/tabs.js'
import { ellipsizeMiddle, formatInteger } from '@/lib/format.js'
import { cn } from '@/lib/utils.js'
import {
  useV2CancelTransformJob,
  useV2CreateBasicCleanJob,
  useV2DatasetResolution,
  useV2RetryTransformJob,
  useV2RunTransform,
  useV2TransformJobs,
  useV2Transforms,
} from '../../api/hooks.js'
import type { TransformDescriptorV2, TransformJobV2 } from '../../api/types.js'
import { RefConflictRecovery, readRefConflictDetail } from '../../components/RefConflictRecovery.js'
import { V2MutationError } from '../../components/V2MutationError.js'

export function V2TransformsPageView() {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'basic-clean' | 'built-in'>('basic-clean')

  return (
    <PageShell>
      <PageHeader
        className="[&_h1]:text-[1.75rem] [&_p]:text-sm [&_p]:leading-6"
        description={t('v2.transforms.description')}
        title={t('v2.transforms.title')}
      />
      <Tabs
        ariaLabel={t('v2.transforms.modeLabel')}
        items={[
          {
            label: t('v2.transforms.jobs.title'),
            panel: <BasicCleanJobs />,
            value: 'basic-clean',
          },
          {
            label: t('v2.transforms.builtIn'),
            panel: <BuiltInTransforms />,
            value: 'built-in',
          },
        ]}
        onChange={setMode}
        value={mode}
      />
    </PageShell>
  )
}

function BuiltInTransforms() {
  const { t } = useTranslation()
  const transforms = useV2Transforms()
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const selected = useMemo(
    () =>
      transforms.data?.items.find((item) => item.name === selectedName) ??
      transforms.data?.items[0] ??
      null,
    [selectedName, transforms.data],
  )

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <Surface className="h-fit overflow-hidden">
        <SurfaceHeader className="py-3.5">
          <SurfaceTitle>{t('v2.transforms.registry')}</SurfaceTitle>
        </SurfaceHeader>
        {transforms.isLoading ? <Spinner /> : null}
        {transforms.isError ? <ErrorState error={transforms.error} /> : null}
        {transforms.data?.items.length === 0 ? (
          <SurfaceBody>
            <EmptyState>{t('v2.transforms.empty')}</EmptyState>
          </SurfaceBody>
        ) : null}
        {transforms.data?.items.map((item) => (
          <button
            aria-pressed={item.name === selected?.name}
            className={cn(
              'grid w-full gap-1 border-border border-b px-4 py-2.5 text-left last:border-b-0 hover:bg-surface-hover',
              item.name === selected?.name && 'border-l-2 border-l-primary bg-surface-soft',
            )}
            key={item.name}
            onClick={() => setSelectedName(item.name)}
            type="button"
          >
            <span className="font-medium text-sm">{item.name}</span>
            <span className="flex items-center gap-2 text-muted-foreground text-xs">
              <span>{t('v2.transforms.version', { version: item.version })}</span>
              <Badge>
                {item.identity_mode === 'preserve'
                  ? t('v2.transforms.preserve')
                  : t('v2.transforms.derive')}
              </Badge>
            </span>
          </button>
        ))}
      </Surface>
      {selected ? (
        <RunTransformPanel key={selected.name} transform={selected} />
      ) : (
        <Surface>
          <SurfaceBody>
            <EmptyState>{t('v2.transforms.select')}</EmptyState>
          </SurfaceBody>
        </Surface>
      )}
    </div>
  )
}

function BasicCleanJobs() {
  const { t } = useTranslation()
  const jobs = useV2TransformJobs()
  const create = useV2CreateBasicCleanJob()
  const cancel = useV2CancelTransformJob()
  const retry = useV2RetryTransformJob()
  const [input, setInput] = useState('')
  const [resultRef, setResultRef] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const items = jobs.data?.items ?? []
  const pageCount = getTransformJobPageCount(items.length)
  const visibleJobs = paginateTransformJobs(items, page)

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount))
  }, [pageCount])

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = input.trim()
    if (value === '') {
      setFormError(t('v2.transforms.jobs.inputRequired'))
      return
    }
    const normalizedResultRef = resultRef.trim()
    if (normalizedResultRef === '') {
      setFormError(t('v2.transforms.jobs.resultRefRequired'))
      return
    }
    setFormError(null)
    create.mutate({ input: value, resultRef: normalizedResultRef }, { onSuccess: () => setPage(1) })
  }

  return (
    <div className="space-y-5">
      <Surface className="overflow-hidden">
        <SurfaceHeader>
          <SurfaceTitle>{t('v2.transforms.jobs.title')}</SurfaceTitle>
          <SurfaceDescription>{t('v2.transforms.jobs.description')}</SurfaceDescription>
        </SurfaceHeader>
        <div className="grid lg:grid-cols-[minmax(0,1.08fr)_minmax(21rem,0.92fr)]">
          <form className="space-y-4 px-5 py-5" onSubmit={submit}>
            <div className="grid gap-4">
              <Field hint={t('v2.transforms.jobs.inputHint')} label={t('v2.transforms.jobs.input')}>
                <TextInput
                  aria-label={t('v2.transforms.jobs.input')}
                  onChange={(event) => setInput(event.currentTarget.value)}
                  placeholder={t('v2.transforms.inputPlaceholder')}
                  value={input}
                />
              </Field>
              <Field
                hint={t('v2.transforms.jobs.resultRefHint')}
                label={t('v2.transforms.jobs.resultRef')}
              >
                <TextInput
                  aria-label={t('v2.transforms.jobs.resultRef')}
                  onChange={(event) => setResultRef(event.currentTarget.value)}
                  placeholder={t('v2.transforms.jobs.resultRefPlaceholder')}
                  value={resultRef}
                />
              </Field>
            </div>
            {formError ? <FormError>{formError}</FormError> : null}
            {create.isError ? (
              <V2MutationError
                error={create.error}
                message={
                  isTransformJobIdentityConflict(create.error)
                    ? t('v2.transforms.jobs.identityConflict')
                    : undefined
                }
              />
            ) : null}
            <div className="flex justify-end">
              <Button disabled={create.isPending} type="submit">
                {create.isPending
                  ? t('v2.transforms.jobs.submitting')
                  : t('v2.transforms.jobs.submit')}
              </Button>
            </div>
          </form>
          <BasicCleanPipeline />
        </div>
      </Surface>

      <Surface className="overflow-hidden">
        <SurfaceHeader className="flex items-center justify-between gap-3">
          <SurfaceTitle>{t('v2.transforms.jobs.recent')}</SurfaceTitle>
          {jobs.isFetching ? (
            <span className="text-dim-foreground text-xs">{t('common.loading')}</span>
          ) : null}
        </SurfaceHeader>
        {jobs.isLoading ? <Spinner /> : null}
        {jobs.isError ? <ErrorState error={jobs.error} /> : null}
        {jobs.data?.items.length === 0 ? (
          <SurfaceBody>
            <EmptyState>{t('v2.transforms.jobs.empty')}</EmptyState>
          </SurfaceBody>
        ) : null}
        {visibleJobs.map((job) => (
          <TransformJobRow
            cancelling={cancel.isPending && cancel.variables === job.id}
            job={job}
            key={job.id}
            onCancel={() => cancel.mutate(job.id)}
            onRetry={() => retry.mutate(job.id)}
            retrying={retry.isPending && retry.variables === job.id}
          />
        ))}
        {cancel.isError ? (
          <SurfaceBody className="border-border border-t">
            <V2MutationError error={cancel.error} />
          </SurfaceBody>
        ) : null}
        {retry.isError ? (
          <SurfaceBody className="border-border border-t">
            <V2MutationError error={retry.error} />
          </SurfaceBody>
        ) : null}
        {items.length > TRANSFORM_JOB_PAGE_SIZE ? (
          <div className="flex items-center justify-end gap-2 border-border border-t px-5 py-2.5">
            <span className="mr-1 text-muted-foreground text-xs tabular-nums">
              {t('v2.datasets.pageStatus', { current: page, total: pageCount })}
            </span>
            <Button
              disabled={page === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              size="sm"
              variant="outline"
            >
              {t('v2.datasets.previousPage')}
            </Button>
            <Button
              disabled={page === pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              size="sm"
              variant="outline"
            >
              {t('v2.datasets.nextPage')}
            </Button>
          </div>
        ) : null}
      </Surface>
    </div>
  )
}

export const TRANSFORM_JOB_PAGE_SIZE = 5

export function getTransformJobPageCount(totalItems: number): number {
  return Math.max(1, Math.ceil(Math.max(0, totalItems) / TRANSFORM_JOB_PAGE_SIZE))
}

export function paginateTransformJobs<T>(items: readonly T[], page: number): readonly T[] {
  const normalizedPage = Math.min(Math.max(1, page), getTransformJobPageCount(items.length))
  const start = (normalizedPage - 1) * TRANSFORM_JOB_PAGE_SIZE
  return items.slice(start, start + TRANSFORM_JOB_PAGE_SIZE)
}

function TransformJobRow({
  cancelling,
  job,
  onCancel,
  onRetry,
  retrying,
}: {
  cancelling: boolean
  job: TransformJobV2
  onCancel(): void
  onRetry(): void
  retrying: boolean
}) {
  const { t } = useTranslation()
  const active = ['queued', 'leased', 'running', 'finalizing'].includes(job.status)
  const canRetry = job.status === 'failed' || job.status === 'cancelled'
  const filtered = job.output_count === null ? null : job.input_count - job.output_count
  const progress = transformJobProgressPercent(job)
  const inputVersion = job.input_dataset_versions[0] ?? ''
  const unchanged = job.status === 'completed' && job.output_dataset_version === inputVersion
  const resultTarget =
    job.result_ref?.status === 'updated'
      ? job.result_ref.name
      : (job.output_dataset_version ?? null)
  return (
    <article className="border-border border-t px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={transformJobTone(job.status)}>
            {t(`v2.transforms.jobs.status.${job.status}`)}
          </Badge>
          <span className="font-medium text-sm">{t('v2.transforms.jobs.basicClean')}</span>
          <code className="text-dim-foreground text-xs" title={job.id}>
            {ellipsizeMiddle(job.id, 9)}
          </code>
          {job.cache_hit ? <Badge tone="accent">{t('v2.transforms.jobs.cacheHit')}</Badge> : null}
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          {active ? (
            <Button disabled={cancelling} onClick={onCancel} size="sm" variant="outline">
              {cancelling ? t('v2.transforms.jobs.cancelling') : t('common.cancel')}
            </Button>
          ) : null}
          {canRetry ? (
            <Button disabled={retrying} onClick={onRetry} size="sm" variant="outline">
              {retrying ? t('v2.transforms.jobs.retrying') : t('v2.transforms.jobs.retry')}
            </Button>
          ) : null}
          {resultTarget ? (
            <>
              <Button asChild size="sm">
                <Link params={{ ref: resultTarget }} to="/datasets/$ref">
                  {t('v2.transforms.jobs.openDataset')}
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link params={{ ref: resultTarget }} to="/lineage/$ref">
                  {t('v2.transforms.jobs.openLineage')}
                </Link>
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-x-8 gap-y-2 text-xs lg:grid-cols-[minmax(0,1.2fr)_minmax(17rem,0.8fr)]">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground">
          <span>{t('v2.transforms.jobs.attempt', { count: job.attempt })}</span>
          <span>
            {t('v2.transforms.jobs.inputCount', { count: formatInteger(job.input_count) })}
          </span>
          {job.output_count === null ? null : (
            <span>
              {t('v2.transforms.jobs.outputCount', { count: formatInteger(job.output_count) })}
            </span>
          )}
          {filtered === null ? null : (
            <span>{t('v2.transforms.jobs.filteredCount', { count: formatInteger(filtered) })}</span>
          )}
          <span title={inputVersion}>
            {t('v2.transforms.jobs.inputVersion', {
              version: ellipsizeMiddle(inputVersion, 8),
            })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {job.result_ref === null ? (
            <span className="text-dim-foreground">{t('v2.transforms.jobs.noResultRef')}</span>
          ) : (
            <>
              <span className="text-muted-foreground">{t('v2.transforms.jobs.resultLabel')}</span>
              <code>{job.result_ref.name}</code>
              <Badge tone={job.result_ref.status === 'conflict' ? 'orange' : 'muted'}>
                {t(`v2.transforms.jobs.resultRefStatus.${job.result_ref.status}`)}
              </Badge>
            </>
          )}
          {unchanged ? <Badge tone="accent">{t('v2.transforms.jobs.unchanged')}</Badge> : null}
        </div>
      </div>
      {job.result_ref?.status === 'conflict' ? (
        <p className="mt-3 text-danger text-sm">
          {t('v2.transforms.jobs.resultRefConflict', {
            version: ellipsizeMiddle(job.result_ref.version ?? '', 8),
          })}
        </p>
      ) : null}
      {job.progress === null ? null : (
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between text-dim-foreground text-xs">
            <span>{job.progress.phase}</span>
            <span>
              {progress === null ? formatInteger(job.progress.completed_units) : `${progress}%`}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-soft">
            <div
              className="h-full bg-primary transition-[width] duration-300"
              style={{ width: `${progress ?? 8}%` }}
            />
          </div>
        </div>
      )}
      {job.error ? <p className="mt-3 text-danger text-sm">{job.error.message}</p> : null}
    </article>
  )
}

function BasicCleanPipeline() {
  const { t } = useTranslation()
  const steps = [
    {
      operator: 'whitespace_normalization_mapper',
      title: t('v2.transforms.jobs.pipeline.whitespace.title'),
      detail: t('v2.transforms.jobs.pipeline.whitespace.detail'),
    },
    {
      operator: 'text_length_filter',
      title: t('v2.transforms.jobs.pipeline.length.title'),
      detail: t('v2.transforms.jobs.pipeline.length.detail'),
    },
    {
      operator: 'document_deduplicator',
      title: t('v2.transforms.jobs.pipeline.deduplicate.title'),
      detail: t('v2.transforms.jobs.pipeline.deduplicate.detail'),
    },
  ]
  return (
    <section className="border-border border-t bg-surface-soft/40 px-5 py-5 lg:border-t-0 lg:border-l">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-sm">{t('v2.transforms.jobs.pipeline.title')}</h3>
          <p className="mt-1 text-muted-foreground text-xs leading-5">
            {t('v2.transforms.jobs.pipeline.description')}
          </p>
        </div>
        <Badge>{t('v2.transforms.jobs.pipeline.version')}</Badge>
      </div>
      <ol className="mt-4 grid divide-y divide-border border-border border-y xl:grid-cols-3 xl:divide-x xl:divide-y-0">
        {steps.map((step, index) => (
          <li className="min-w-0 py-3 xl:px-3 xl:first:pl-0 xl:last:pr-0" key={step.operator}>
            <div className="flex items-center gap-2">
              <span className="font-mono text-dim-foreground text-xs">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="font-medium text-sm">{step.title}</span>
            </div>
            <code className="mt-2 block break-all text-primary text-xs">{step.operator}</code>
            <p className="mt-2 text-muted-foreground text-xs leading-5">{step.detail}</p>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-dim-foreground text-xs leading-5">
        {t('v2.transforms.jobs.pipeline.publication')}
      </p>
    </section>
  )
}

export function transformJobProgressPercent(job: TransformJobV2): number | null {
  if (job.status === 'completed') return 100
  const progress = job.progress
  if (progress === null || progress.total_units === null || progress.total_units === 0) return null
  return Math.min(100, Math.round((progress.completed_units / progress.total_units) * 100))
}

export function isTransformJobIdentityConflict(error: unknown): boolean {
  if (!isApiError(error) || error.detail === null || typeof error.detail !== 'object') return false
  return 'reason' in error.detail && error.detail.reason === 'transform_job_identity_conflict'
}

function transformJobTone(status: TransformJobV2['status']): 'blue' | 'green' | 'orange' | 'muted' {
  if (status === 'completed') return 'green'
  if (status === 'failed' || status === 'cancelled') return 'muted'
  if (status === 'finalizing') return 'orange'
  return 'blue'
}

function RunTransformPanel({ transform }: { transform: TransformDescriptorV2 }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const run = useV2RunTransform()
  const [inputs, setInputs] = useState<OrderedInput[]>(() =>
    createOrderedInputs(transform.input_roles),
  )
  const paramsExample = formatParamsExample(transform.params_example)
  const [paramsText, setParamsText] = useState(paramsExample)
  const [ref, setRef] = useState('')
  const [expectedVersion, setExpectedVersion] = useState('')
  const [message, setMessage] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const conflict = readRefConflictDetail(run.error)
  const deferredOutputRef = useDeferredValue(ref.trim())
  const outputResolution = useV2DatasetResolution(deferredOutputRef)
  const controllerRef = useRef<AbortController | null>(null)
  const hasParams = hasTransformParams(transform.params_schema)
  useEffect(() => () => controllerRef.current?.abort(), [])

  function submit(event: FormEvent) {
    event.preventDefault()
    const normalizedInputs = inputs.map((input) => input.value.trim())
    if (normalizedInputs.some((input) => input === '')) {
      setFormError(t('v2.transforms.inputRequired'))
      return
    }
    const params = parseJsonObject(paramsText)
    if (!params.ok) {
      setFormError(
        params.reason === 'not_object'
          ? t('v2.transforms.paramsObject')
          : t('v2.transforms.paramsInvalid', { message: params.message }),
      )
      return
    }
    if (expectedVersion.trim() !== '' && ref.trim() === '') {
      setFormError(t('v2.transforms.expectedNeedsRef'))
      return
    }
    if (message.trim() !== '' && ref.trim() === '') {
      setFormError(t('v2.transforms.messageNeedsRef'))
      return
    }
    setFormError(null)
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    run.mutate(
      {
        name: transform.name,
        request: {
          expected_ref_version: blankToNull(expectedVersion),
          inputs: normalizedInputs,
          message: blankToNull(message),
          params: params.value,
          ref: blankToNull(ref),
        },
        signal: controller.signal,
      },
      {
        onSuccess: (result) => {
          if (controller.signal.aborted) return
          void navigate({
            params: { ref: result.manifest.dataset_version },
            to: '/datasets/$ref',
          })
        },
        onSettled: () => {
          if (controllerRef.current === controller) controllerRef.current = null
          if (controller.signal.aborted) run.reset()
        },
      },
    )
  }

  return (
    <Surface className="overflow-hidden">
      <SurfaceHeader className="py-3">
        <div className="flex flex-wrap items-center gap-3">
          <SurfaceTitle>{transform.name}</SurfaceTitle>
          <Badge>{t('v2.transforms.version', { version: transform.version })}</Badge>
          <Badge>
            {transform.identity_mode === 'preserve'
              ? t('v2.transforms.preserve')
              : t('v2.transforms.derive')}
          </Badge>
        </div>
      </SurfaceHeader>
      <div className="grid xl:grid-cols-[minmax(13rem,0.62fr)_minmax(0,2fr)]">
        <aside className="space-y-3 border-border border-b px-4 py-4 xl:border-r xl:border-b-0">
          <div>
            <h3 className="font-semibold text-[0.95rem]">
              {t(`v2.transforms.guidance.${transform.name}.title`, {
                defaultValue: transform.name,
              })}
            </h3>
            <p className="mt-1.5 text-muted-foreground text-xs leading-5">
              {t(`v2.transforms.guidance.${transform.name}.description`, {
                defaultValue:
                  transform.identity_mode === 'preserve'
                    ? t('v2.transforms.identityPreserve')
                    : t('v2.transforms.identityDerive'),
              })}
            </p>
          </div>
          <TransformFact
            label={t('v2.transforms.inputRequirement')}
            value={t(`v2.transforms.guidance.${transform.name}.inputRequirement`, {
              count: transform.input_roles.length,
              defaultValue: t('v2.transforms.inputRequirementFallback', {
                count: transform.input_roles.length,
              }),
            })}
          />
          <TransformFact
            label={t('v2.transforms.outputResult')}
            value={t(`v2.transforms.guidance.${transform.name}.outputResult`, {
              defaultValue:
                transform.identity_mode === 'preserve'
                  ? t('v2.transforms.identityPreserve')
                  : t('v2.transforms.identityDerive'),
            })}
          />
          <TransformFact
            label={t('v2.transforms.parameters')}
            value={t(`v2.transforms.guidance.${transform.name}.paramsNote`, {
              defaultValue: hasParams
                ? t('v2.transforms.paramsHint')
                : t('v2.transforms.noParamsBody'),
            })}
          />
        </aside>

        <form
          className="grid gap-4 px-4 py-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(16rem,0.85fr)]"
          onSubmit={submit}
        >
          <div className="min-w-0 space-y-3">
            <div className="grid gap-3">
              {inputs.map((input, index) => (
                <Field
                  hint={t(`v2.transforms.guidance.${transform.name}.roles.${input.role}.hint`, {
                    defaultValue: t('v2.transforms.inputRoleHint'),
                  })}
                  key={input.id}
                  label={t(`v2.transforms.guidance.${transform.name}.roles.${input.role}.label`, {
                    defaultValue: input.role,
                  })}
                >
                  <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] overflow-hidden rounded-[4px] border border-border bg-background/70 focus-within:border-primary focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_72%,transparent)]">
                    <span className="flex items-center justify-center border-border border-r text-dim-foreground text-sm">
                      {index + 1}
                    </span>
                    <TextInput
                      className="rounded-none border-0 bg-transparent focus:shadow-none"
                      aria-label={t('v2.transforms.inputNumber', { number: index + 1 })}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.value
                        setInputs((current) =>
                          current.map((value, itemIndex) =>
                            itemIndex === index ? { ...value, value: nextValue } : value,
                          ),
                        )
                      }}
                      placeholder={t('v2.transforms.inputPlaceholder')}
                      value={input.value}
                    />
                  </div>
                </Field>
              ))}
            </div>
            {hasParams ? (
              <>
                <Field label={t('v2.transforms.params')}>
                  <CodeEditor
                    aria-label={t('v2.transforms.params')}
                    header={
                      <Button
                        onClick={() => setParamsText(paramsExample)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <RotateCcw aria-hidden="true" size={14} />
                        {t('v2.transforms.resetExample')}
                      </Button>
                    }
                    language="JSON"
                    maxRows={3}
                    minRows={2}
                    onChange={(event) => setParamsText(event.currentTarget.value)}
                    value={paramsText}
                  />
                </Field>
                <details>
                  <summary className="cursor-pointer text-muted-foreground text-sm">
                    {t('v2.transforms.schema')}
                  </summary>
                  <div className="mt-3">
                    <JsonBlock value={transform.params_schema} />
                  </div>
                </details>
              </>
            ) : (
              <div className="rounded-[5px] border border-border bg-surface-soft px-3 py-2.5">
                <div className="font-medium text-sm">{t('v2.transforms.noParams')}</div>
                <p className="mt-1 text-dim-foreground text-xs leading-5">
                  {t(`v2.transforms.guidance.${transform.name}.paramsNote`, {
                    defaultValue: t('v2.transforms.noParamsBody'),
                  })}
                </p>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col border-border border-t pt-4 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-4">
            <div className="space-y-3">
              <h3 className="font-medium text-muted-foreground text-sm">
                {t('v2.transforms.resultOptions')}
              </h3>
              <Field label={t('v2.transforms.outputRef')}>
                <TextInput
                  aria-label={t('v2.transforms.outputRef')}
                  onChange={(event) => setRef(event.currentTarget.value)}
                  value={ref}
                />
              </Field>
              <Field hint={t('v2.transforms.expectedHint')} label={t('v2.transforms.expected')}>
                <TextInput
                  aria-label={t('v2.transforms.expected')}
                  disabled={ref.trim() === ''}
                  onChange={(event) => setExpectedVersion(event.currentTarget.value)}
                  value={expectedVersion}
                />
              </Field>
              <Field label={t('v2.transforms.message')}>
                <TextInput
                  aria-label={t('v2.transforms.message')}
                  disabled={ref.trim() === ''}
                  onChange={(event) => setMessage(event.currentTarget.value)}
                  value={message}
                />
              </Field>
              {deferredOutputRef === '' ? null : (
                <CurrentOutputRef
                  error={outputResolution.error}
                  isError={outputResolution.isError}
                  isFetching={outputResolution.isFetching}
                  onUse={(version) => setExpectedVersion(version)}
                  version={outputResolution.data?.dataset_version ?? null}
                />
              )}
              {formError ? <FormError>{formError}</FormError> : null}
            </div>
            <div className="mt-auto flex flex-wrap justify-end gap-2 pt-3">
              <Button disabled={run.isPending} type="submit">
                {run.isPending ? t('v2.transforms.running') : t('v2.transforms.run')}
              </Button>
              {run.isPending ? (
                <Button
                  onClick={() => controllerRef.current?.abort()}
                  type="button"
                  variant="outline"
                >
                  {t('v2.transforms.cancel')}
                </Button>
              ) : null}
            </div>
          </div>
        </form>
      </div>
      {run.isError ? (
        <SurfaceBody className="border-border border-t">
          {conflict ? (
            <RefConflictRecovery
              error={run.error}
              onResolved={(version) => {
                void navigate({ params: { ref: version }, to: '/datasets/$ref' })
              }}
            />
          ) : (
            <V2MutationError error={run.error} />
          )}
        </SurfaceBody>
      ) : null}
    </Surface>
  )
}

interface OrderedInput {
  id: string
  role: string
  value: string
}

function TransformFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border border-t pt-3">
      <h3 className="font-medium text-muted-foreground text-xs">{label}</h3>
      <p className="mt-1 text-xs leading-5">{value}</p>
    </div>
  )
}

function CurrentOutputRef({
  error,
  isError,
  isFetching,
  onUse,
  version,
}: {
  error: unknown
  isError: boolean
  isFetching: boolean
  onUse(version: string): void
  version: string | null
}) {
  const { t } = useTranslation()
  if (isFetching && version === null) {
    return <div className="text-muted-foreground text-sm">{t('v2.transforms.resolvingRef')}</div>
  }
  if (isError && isApiError(error) && error.code === 'not_found') {
    return <div className="text-muted-foreground text-sm">{t('v2.transforms.newRef')}</div>
  }
  if (isError) {
    return <div className="text-danger text-sm">{t('v2.transforms.refLookupFailed')}</div>
  }
  if (version === null) return null
  return (
    <div className="flex items-center justify-between gap-2 rounded-[5px] border border-border bg-surface-soft px-3 py-2 text-xs">
      <span className="min-w-0 truncate">
        {t('v2.transforms.currentRef')} <code title={version}>{ellipsizeMiddle(version, 12)}</code>
      </span>
      <Button onClick={() => onUse(version)} size="sm" type="button" variant="outline">
        {t('v2.transforms.useCurrent')}
      </Button>
    </div>
  )
}

export type JsonObjectParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { message: string; ok: false; reason: 'invalid_json' }
  | { ok: false; reason: 'not_object' }

export function parseJsonObject(text: string): JsonObjectParseResult {
  try {
    const value = JSON.parse(text) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'not_object' }
    }
    return { ok: true, value: value as Record<string, unknown> }
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
      reason: 'invalid_json',
    }
  }
}

export function createOrderedInputs(inputRoles: readonly string[]): OrderedInput[] {
  return inputRoles.map((role, index) => ({
    id: `${role}-${index + 1}`,
    role,
    value: '',
  }))
}

export function formatParamsExample(paramsExample: Record<string, unknown>): string {
  return JSON.stringify(paramsExample, null, 2)
}

export function hasTransformParams(paramsSchema: Record<string, unknown>): boolean {
  const properties = paramsSchema.properties
  return (
    properties !== null &&
    typeof properties === 'object' &&
    !Array.isArray(properties) &&
    Object.keys(properties).length > 0
  )
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
