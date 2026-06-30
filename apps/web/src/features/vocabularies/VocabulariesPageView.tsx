import { Link, useNavigate } from '@tanstack/react-router'
import { BookOpenText, CheckCircle2, Plus, Search, WandSparkles } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FEATURES, useModuleEnabled } from '@/api/capabilities.js'
import {
  useDeriveVocabulary,
  useNormalizeVocabulary,
  useRefs,
  useSaveVocabulary,
  useValidateVocabulary,
  useVocabularies,
  useVocabulary,
} from '@/api/hooks.js'
import type {
  AliasConflict,
  Extractor,
  Term,
  ValidateResponse,
  Vocabulary,
  VocabularyInfo,
  VocabularyInput,
} from '@/api/types.js'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import {
  EmptyState,
  ErrorState,
  FeatureDisabled,
  InlineError,
  Spinner,
} from '@/components/common/State.js'
import { ManifestView } from '@/components/datasets/ManifestView.js'
import { Badge, StatusDot } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Field, FormError } from '@/components/ui/field.js'
import { SelectInput, TextInput } from '@/components/ui/input.js'
import {
  MetricItem,
  MetricStrip,
  PageHeader,
  PageShell,
  Surface,
  SurfaceBody,
  SurfaceDescription,
  SurfaceHeader,
  SurfaceTitle,
  Toolbar,
} from '@/components/ui/surface.js'
import { TermsEditor } from '@/components/vocabularies/TermsEditor.js'
import { VirtualizedTerms } from '@/components/vocabularies/VirtualizedTerms.js'
import { ellipsizeMiddle, formatInteger, shortRef } from '@/lib/format.js'

export function VocabulariesPageView() {
  const { t } = useTranslation()
  const enabled = useModuleEnabled(FEATURES.vocabularies)
  const vocabularies = useVocabularies()
  const [filter, setFilter] = useState('')
  const rows = useMemo(
    () => filterVocabularies(vocabularies.data?.items ?? [], filter),
    [filter, vocabularies.data],
  )

  if (!enabled) {
    return <VocabularyDisabled title={t('vocab.title')} />
  }

  return (
    <PageShell>
      <PageHeader
        actions={
          <Toolbar>
            <Button asChild variant="outline">
              <Link to="/vocabularies/new">
                <Plus aria-hidden="true" size={16} />
                {t('vocab.newAction')}
              </Link>
            </Button>
            <Button asChild>
              <Link to="/vocabularies/derive">
                <WandSparkles aria-hidden="true" size={16} />
                {t('vocab.deriveAction')}
              </Link>
            </Button>
          </Toolbar>
        }
        description={t('vocab.description')}
        title={t('vocab.title')}
      />

      <div className="relative block max-w-[56rem]">
        <Search
          aria-hidden="true"
          className="absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground"
          size={18}
        />
        <TextInput
          aria-label={t('vocab.filterPlaceholder')}
          className="h-12 pl-11"
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder={t('vocab.filterPlaceholder')}
          value={filter}
        />
      </div>

      <Surface className="overflow-hidden">
        <div className="grid grid-cols-[minmax(14rem,1.6fr)_minmax(10rem,1fr)_minmax(8rem,0.7fr)_minmax(8rem,0.8fr)_minmax(10rem,0.8fr)] border-border border-b bg-background/35 px-5 py-3.5 text-muted-foreground text-sm max-lg:hidden">
          <div>{t('vocab.colName')}</div>
          <div>{t('vocab.colDimension')}</div>
          <div>{t('vocab.colTerms')}</div>
          <div>{t('vocab.colStatus')}</div>
          <div>{t('vocab.colId')}</div>
        </div>

        {vocabularies.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : null}
        {vocabularies.isError ? (
          <div className="p-6">
            <ErrorState error={vocabularies.error} />
          </div>
        ) : null}
        {vocabularies.data && vocabularies.data.items.length === 0 ? (
          <div className="p-6">
            <EmptyState>{t('vocab.emptyNone')}</EmptyState>
          </div>
        ) : null}
        {vocabularies.data && vocabularies.data.items.length > 0 && rows.length === 0 ? (
          <div className="p-6">
            <EmptyState>{t('vocab.emptyNoMatch')}</EmptyState>
          </div>
        ) : null}
        {rows.map((row) => (
          <VocabularyRow key={`${row.name ?? row.id}:${row.id}`} row={row} />
        ))}
      </Surface>

      {vocabularies.data && vocabularies.data.total > vocabularies.data.items.length ? (
        <p className="text-muted-foreground text-sm">
          {t('vocab.cappedNote', {
            shown: vocabularies.data.items.length,
            total: vocabularies.data.total,
          })}
        </p>
      ) : null}
    </PageShell>
  )
}

export function VocabularyDerivePageView() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const enabled = useModuleEnabled(FEATURES.vocabularies)
  const refs = useRefs(500)
  const derive = useDeriveVocabulary()
  const [name, setName] = useState('')
  const [dataset, setDataset] = useState('')
  const [dimension, setDimension] = useState('brand')
  const [advanced, setAdvanced] = useState(false)
  const [rawKey, setRawKey] = useState('')
  const [stdKey, setStdKey] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  if (!enabled) {
    return <VocabularyDisabled title={t('vocab.deriveTitle')} />
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const nextName = name.trim()
    const nextDataset = dataset.trim()
    const nextDimension = dimension.trim()

    if (nextName === '' || nextDataset === '' || nextDimension === '') {
      setFormError(t('vocab.errRequired'))
      return
    }

    const extractor = parseExtractorDraft({
      advanced,
      rawKey,
      stdKey,
    })

    if (extractor === 'invalid') {
      setFormError(t('vocab.errExtractorKeys'))
      return
    }

    setFormError(null)
    derive.mutate(
      {
        dataset: nextDataset,
        dimension: nextDimension,
        ...(extractor ? { extractor } : {}),
        name: nextName,
      },
      {
        onSuccess: (vocabulary) => {
          void navigate({
            params: { name: vocabulary.name ?? nextName },
            to: '/vocabularies/$name',
          })
        },
      },
    )
  }

  return (
    <PageShell className="max-w-5xl">
      <PageHeader
        actions={
          <Button asChild variant="quiet">
            <Link to="/vocabularies">{t('vocab.backToList')}</Link>
          </Button>
        }
        description={t('vocab.deriveDescription')}
        title={t('vocab.deriveTitle')}
      />

      <Surface>
        <SurfaceBody>
          <form className="space-y-5" onSubmit={submit}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('vocab.nameLabel')}>
                <TextInput onChange={(event) => setName(event.currentTarget.value)} value={name} />
              </Field>
              <Field label={t('vocab.dimensionLabel')}>
                <TextInput
                  onChange={(event) => setDimension(event.currentTarget.value)}
                  placeholder={t('vocab.dimensionPlaceholder')}
                  value={dimension}
                />
              </Field>
            </div>
            <Field label={t('vocab.datasetLabel')}>
              {refs.isLoading ? <Spinner /> : null}
              {refs.isError ? <ErrorState error={refs.error} /> : null}
              <SelectInput
                aria-label={t('vocab.datasetLabel')}
                className="w-full"
                disabled={refs.isLoading}
                onValueChange={setDataset}
                options={[
                  { label: t('vocab.datasetPlaceholder'), value: '' },
                  ...(refs.data?.items ?? []).map((ref) => ({
                    label: `${ref.name} · ${shortRef(ref.version)}`,
                    value: ref.name,
                  })),
                ]}
                value={dataset}
              />
            </Field>

            <div className="rounded-[5px] border border-border bg-background/35 px-4 py-3">
              <button
                aria-expanded={advanced}
                className="text-sm text-accent-foreground"
                onClick={() => setAdvanced((current) => !current)}
                type="button"
              >
                {t('vocab.extractorAdvanced')}
              </button>
              {advanced ? (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <p className="text-muted-foreground text-sm leading-6 md:col-span-2">
                    {t('vocab.extractorHint')}
                  </p>
                  <Field label={t('vocab.rawKeyLabel')}>
                    <TextInput
                      onChange={(event) => setRawKey(event.currentTarget.value)}
                      value={rawKey}
                    />
                  </Field>
                  <Field label={t('vocab.stdKeyLabel')}>
                    <TextInput
                      onChange={(event) => setStdKey(event.currentTarget.value)}
                      value={stdKey}
                    />
                  </Field>
                </div>
              ) : null}
            </div>

            {formError ? <FormError>{formError}</FormError> : null}
            {derive.isError ? <InlineError error={derive.error} /> : null}

            <Button disabled={derive.isPending} type="submit">
              <WandSparkles aria-hidden="true" size={16} />
              {derive.isPending ? t('vocab.deriving') : t('vocab.deriveAction')}
            </Button>
          </form>
        </SurfaceBody>
      </Surface>
    </PageShell>
  )
}

export function VocabularyCreatePageView() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const enabled = useModuleEnabled(FEATURES.vocabularies)
  const save = useSaveVocabulary()
  const [name, setName] = useState('')
  const [dimension, setDimension] = useState('')
  const [terms, setTerms] = useState<Term[]>([])
  const [formError, setFormError] = useState<string | null>(null)

  if (!enabled) {
    return <VocabularyDisabled title={t('vocab.createTitle')} />
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const nextName = name.trim()
    const nextDimension = dimension.trim()

    if (nextName === '' || nextDimension === '') {
      setFormError(t('vocab.errNameDimension'))
      return
    }

    if (terms.length === 0) {
      setFormError(t('vocab.errNoTerms'))
      return
    }

    const payload: VocabularyInput = {
      dimension: nextDimension,
      meta: {},
      name: nextName,
      source: null,
      status: 'curated',
      terms,
    }

    setFormError(null)
    save.mutate(
      { name: nextName, payload },
      {
        onSuccess: () => {
          void navigate({ params: { name: nextName }, to: '/vocabularies/$name' })
        },
      },
    )
  }

  return (
    <PageShell className="max-w-6xl">
      <PageHeader
        actions={
          <Button asChild variant="quiet">
            <Link to="/vocabularies">{t('vocab.backToList')}</Link>
          </Button>
        }
        description={t('vocab.createDescription')}
        title={t('vocab.createTitle')}
      />

      <Surface>
        <SurfaceBody>
          <form className="space-y-5" onSubmit={submit}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('vocab.nameLabel')}>
                <TextInput onChange={(event) => setName(event.currentTarget.value)} value={name} />
              </Field>
              <Field label={t('vocab.dimensionLabel')}>
                <TextInput
                  onChange={(event) => setDimension(event.currentTarget.value)}
                  placeholder={t('vocab.dimensionPlaceholder')}
                  value={dimension}
                />
              </Field>
            </div>
            <Field label={t('vocab.termsTitle')}>
              <TermsEditor onChange={setTerms} terms={terms} />
            </Field>
            {formError ? <FormError>{formError}</FormError> : null}
            {save.isError ? <InlineError error={save.error} /> : null}
            <Button disabled={save.isPending} type="submit">
              <Plus aria-hidden="true" size={16} />
              {save.isPending ? t('vocab.submitting') : t('vocab.createAction')}
            </Button>
          </form>
        </SurfaceBody>
      </Surface>
    </PageShell>
  )
}

export function VocabularyDetailPageView({ name }: { name: string }) {
  const { t } = useTranslation()
  const enabled = useModuleEnabled(FEATURES.vocabularies)
  const vocabulary = useVocabulary(name)

  if (!enabled) {
    return <VocabularyDisabled title={name} />
  }

  return (
    <PageShell>
      <PageHeader
        actions={
          <Toolbar>
            <Button asChild variant="quiet">
              <Link to="/vocabularies">{t('vocab.backToList')}</Link>
            </Button>
          </Toolbar>
        }
        description={t('vocab.description')}
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <Link className="hover:text-foreground" to="/vocabularies">
              {t('vocab.title')}
            </Link>
            <span>/</span>
            <span>{name}</span>
          </span>
        }
        title={name}
      />

      {vocabulary.isLoading ? <Spinner /> : null}
      {vocabulary.isError ? <ErrorState error={vocabulary.error} /> : null}
      {vocabulary.data ? (
        <VocabularyDetailContent routeName={name} vocabulary={vocabulary.data} />
      ) : null}
    </PageShell>
  )
}

export function filterVocabularies(
  vocabularies: readonly VocabularyInfo[],
  filter: string,
): VocabularyInfo[] {
  const needle = filter.trim().toLowerCase()
  const rows =
    needle === ''
      ? [...vocabularies]
      : vocabularies.filter(
          (vocabulary) =>
            (vocabulary.name ?? '').toLowerCase().includes(needle) ||
            vocabulary.dimension.toLowerCase().includes(needle) ||
            vocabulary.id.toLowerCase().includes(needle),
        )

  return rows.sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id))
}

function VocabularyRow({ row }: { row: VocabularyInfo }) {
  const { t } = useTranslation()
  const routeName = row.name ?? row.id

  return (
    <div className="border-border border-b last:border-b-0">
      <div className="grid w-full items-center gap-4 px-5 py-4 text-sm transition hover:bg-surface-hover/70 lg:grid-cols-[minmax(14rem,1.6fr)_minmax(10rem,1fr)_minmax(8rem,0.7fr)_minmax(8rem,0.8fr)_minmax(10rem,0.8fr)]">
        <Link
          className="group flex min-w-0 items-center gap-3 text-left transition hover:text-foreground"
          params={{ name: routeName }}
          to="/vocabularies/$name"
        >
          <span className="text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary">
            ›
          </span>
          <BookOpenText aria-hidden="true" className="text-dim-foreground" size={17} />
          <span className="truncate font-semibold text-base">{row.name ?? shortRef(row.id)}</span>
        </Link>
        <div>
          <Badge tone="muted">{row.dimension}</Badge>
        </div>
        <div className="text-muted-foreground">{formatInteger(row.num_terms)}</div>
        <div>
          {row.status ? (
            <StatusBadge status={row.status} />
          ) : (
            <span className="text-dim-foreground">{t('common.dash')}</span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <code className="truncate text-muted-foreground" title={row.id}>
            {shortRef(row.id)}
          </code>
          <CopyTextButton label="Copy vocabulary id" text={row.id} />
        </div>
      </div>
    </div>
  )
}

function VocabularyDetailContent({
  routeName,
  vocabulary,
}: {
  routeName: string
  vocabulary: Vocabulary
}) {
  const { t } = useTranslation()
  const save = useSaveVocabulary()
  const [editing, setEditing] = useState(false)
  const [draftTerms, setDraftTerms] = useState<Term[]>(vocabulary.terms)
  const terms = editing ? draftTerms : vocabulary.terms
  const extractor = readExtractor(vocabulary)
  const conflicts = useMemo(() => collectConflicts(vocabulary.terms), [vocabulary.terms])

  useEffect(() => {
    if (!editing) {
      setDraftTerms(vocabulary.terms)
    }
  }, [editing, vocabulary.terms])

  function startEditing() {
    setDraftTerms(vocabulary.terms.map((term) => ({ ...term, aliases: [...term.aliases] })))
    save.reset()
    setEditing(true)
  }

  function saveDraft(status: Vocabulary['status']) {
    const payload: VocabularyInput = {
      dimension: vocabulary.dimension,
      meta: vocabulary.meta,
      name: routeName,
      source: vocabulary.source,
      status,
      terms: draftTerms,
    }

    save.mutate(
      { name: routeName, payload },
      {
        onSuccess: () => setEditing(false),
      },
    )
  }

  return (
    <div className="space-y-5">
      <MetricStrip className="lg:grid-cols-5">
        <MetricItem
          label={t('vocab.colStatus')}
          value={<StatusBadge status={vocabulary.status} />}
        />
        <MetricItem
          label={t('vocab.colDimension')}
          value={<Badge tone="muted">{vocabulary.dimension}</Badge>}
        />
        <MetricItem label={t('vocab.colTerms')} value={formatInteger(vocabulary.terms.length)} />
        <MetricItem label={t('vocab.colId')} value={<VocabularyId id={vocabulary.id} />} />
        <MetricItem
          label={t('vocab.colSource')}
          value={
            vocabulary.source ?? <span className="text-dim-foreground">{t('common.dash')}</span>
          }
        />
      </MetricStrip>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="space-y-5">
          <ApplyToDataset dimension={vocabulary.dimension} vocabularyName={routeName} />
          {conflicts.length > 0 ? <ConflictsPanel conflicts={conflicts} /> : null}
          <Surface>
            <SurfaceHeader className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <SurfaceTitle>{t('vocab.termsTitle')}</SurfaceTitle>
                <SurfaceDescription>
                  {t('vocab.termCount', { count: terms.length })}
                </SurfaceDescription>
              </div>
              {editing ? (
                <Toolbar>
                  <Button
                    disabled={save.isPending}
                    onClick={() => {
                      save.reset()
                      setEditing(false)
                    }}
                    type="button"
                    variant="outline"
                  >
                    {t('common.cancel')}
                  </Button>
                  {vocabulary.status === 'draft' ? (
                    <Button
                      disabled={save.isPending}
                      onClick={() => saveDraft('curated')}
                      type="button"
                    >
                      <CheckCircle2 aria-hidden="true" size={16} />
                      {save.isPending ? t('vocab.submitting') : t('vocab.promoteAction')}
                    </Button>
                  ) : null}
                  <Button
                    disabled={save.isPending}
                    onClick={() => saveDraft(vocabulary.status)}
                    type="button"
                    variant="outline"
                  >
                    {save.isPending ? t('vocab.submitting') : t('vocab.saveAction')}
                  </Button>
                </Toolbar>
              ) : (
                <Button onClick={startEditing} type="button" variant="outline">
                  {t('vocab.curateAction')}
                </Button>
              )}
            </SurfaceHeader>
            <SurfaceBody className="space-y-4">
              {editing ? (
                <p className="text-muted-foreground text-sm">{t('vocab.curateHint')}</p>
              ) : null}
              {save.isError ? <InlineError error={save.error} /> : null}
              {save.isSuccess && !editing ? (
                <div className="text-success text-sm">{t('vocab.saved')}</div>
              ) : null}
              {editing ? (
                <TermsEditor onChange={setDraftTerms} terms={draftTerms} />
              ) : (
                <VirtualizedTerms terms={terms} />
              )}
            </SurfaceBody>
          </Surface>
        </div>

        <div className="space-y-5">
          <Surface>
            <SurfaceHeader>
              <SurfaceTitle>{t('vocab.provenance')}</SurfaceTitle>
              <SurfaceDescription>{t('vocab.extractorHint')}</SurfaceDescription>
            </SurfaceHeader>
            <SurfaceBody>
              {extractor ? (
                <JsonBlock value={extractor} />
              ) : (
                <EmptyState>{t('common.none')}</EmptyState>
              )}
            </SurfaceBody>
          </Surface>
          <Surface>
            <SurfaceHeader>
              <SurfaceTitle>{t('vocab.rawVocabulary')}</SurfaceTitle>
            </SurfaceHeader>
            <SurfaceBody>
              <JsonBlock value={vocabulary} />
            </SurfaceBody>
          </Surface>
        </div>
      </div>
    </div>
  )
}

function ApplyToDataset({
  dimension,
  vocabularyName,
}: {
  dimension: string
  vocabularyName: string
}) {
  const { t } = useTranslation()
  const refs = useRefs(500)
  const normalize = useNormalizeVocabulary()
  const validate = useValidateVocabulary()
  const [dataset, setDataset] = useState('')
  const [outputRef, setOutputRef] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const pending = normalize.isPending || validate.isPending

  function run(action: 'normalize' | 'validate') {
    const nextDataset = dataset.trim()

    if (nextDataset === '') {
      setFormError(t('vocab.applyErrDataset'))
      return
    }

    setFormError(null)
    const variables = {
      dataset: nextDataset,
      name: vocabularyName,
      ref: outputRef.trim(),
    }

    if (action === 'normalize') {
      validate.reset()
      normalize.mutate(variables)
    } else {
      normalize.reset()
      validate.mutate(variables)
    }
  }

  return (
    <Surface>
      <SurfaceHeader>
        <SurfaceTitle>{t('vocab.applyTitle')}</SurfaceTitle>
        <SurfaceDescription>{t('vocab.applyDescription')}</SurfaceDescription>
      </SurfaceHeader>
      <SurfaceBody className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <Field label={t('vocab.applyDatasetLabel')}>
            <SelectInput
              aria-label={t('vocab.applyDatasetLabel')}
              className="w-full"
              disabled={refs.isLoading}
              onValueChange={setDataset}
              options={[
                { label: t('vocab.applyDatasetPlaceholder'), value: '' },
                ...(refs.data?.items ?? []).map((ref) => ({
                  label: `${ref.name} · ${shortRef(ref.version)}`,
                  value: ref.name,
                })),
              ]}
              value={dataset}
            />
          </Field>
          <Field label={t('vocab.applyOutputLabel')}>
            <TextInput
              onChange={(event) => setOutputRef(event.currentTarget.value)}
              placeholder={t('vocab.applyOutputPlaceholder')}
              value={outputRef}
            />
          </Field>
          <Toolbar>
            <Button
              disabled={pending}
              onClick={() => run('validate')}
              type="button"
              variant="outline"
            >
              {validate.isPending ? t('vocab.applyRunning') : t('vocab.validateAction')}
            </Button>
            <Button disabled={pending} onClick={() => run('normalize')} type="button">
              {normalize.isPending ? t('vocab.applyRunning') : t('vocab.normalizeAction')}
            </Button>
          </Toolbar>
        </div>

        {refs.isError ? <InlineError error={refs.error} /> : null}
        {formError ? <FormError>{formError}</FormError> : null}
        {validate.isError ? <InlineError error={validate.error} /> : null}
        {normalize.isError ? <InlineError error={normalize.error} /> : null}

        {validate.data ? <ValidateResult dimension={dimension} result={validate.data} /> : null}
        {normalize.data ? (
          <ResultBlock title={t('vocab.normalizeDone')}>
            <ManifestView linkToDetail manifest={normalize.data} />
          </ResultBlock>
        ) : null}
      </SurfaceBody>
    </Surface>
  )
}

function ValidateResult({ dimension, result }: { dimension: string; result: ValidateResponse }) {
  const { t } = useTranslation()
  const offending = Object.entries(result.summary.offending_values)

  return (
    <ResultBlock title={t('vocab.validateDone')}>
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone="muted">{t('vocab.validateChecked', { count: result.summary.checked })}</Badge>
        <Badge tone={result.summary.invalid > 0 ? 'orange' : 'green'}>
          {t('vocab.validateInvalid', { count: result.summary.invalid })}
        </Badge>
        <Badge tone="muted">
          {t('vocab.validateSignal')}: <code>vocab_{dimension}_valid</code>
        </Badge>
      </div>
      {offending.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2 text-sm">
          <span className="text-muted-foreground">{t('vocab.offendingValues')}</span>
          {offending.map(([value, count]) => (
            <Badge key={value} tone="orange">
              {value} · {count}
            </Badge>
          ))}
        </div>
      ) : null}
      <ManifestView linkToDetail manifest={result.dataset} />
    </ResultBlock>
  )
}

function ConflictsPanel({ conflicts }: { conflicts: readonly CollectedConflict[] }) {
  const { t } = useTranslation()

  return (
    <Surface>
      <SurfaceHeader>
        <SurfaceTitle>{t('vocab.needsReviewTitle')}</SurfaceTitle>
        <SurfaceDescription>{t('vocab.needsReviewHint')}</SurfaceDescription>
      </SurfaceHeader>
      <SurfaceBody className="space-y-4">
        {conflicts.map((conflict) => (
          <div
            className="rounded-[5px] border border-border bg-background/35 p-4"
            key={conflict.canonical}
          >
            <div className="font-semibold">{conflict.canonical}</div>
            <div className="mt-3 space-y-2">
              {conflict.aliases.map((alias) => (
                <div className="flex flex-wrap items-center gap-2 text-sm" key={alias.alias}>
                  <code className="rounded-[3px] bg-surface-soft px-1.5 py-1">{alias.alias}</code>
                  <span className="text-muted-foreground">→</span>
                  <Badge tone="violet">{alias.chosen ?? t('common.dash')}</Badge>
                  {alias.also_seen.length > 0 ? (
                    <>
                      <span className="text-dim-foreground">{t('vocab.alsoSeen')}</span>
                      {alias.also_seen.map((value) => (
                        <Badge key={value} tone="muted">
                          {value}
                          {alias.counts[value] !== undefined ? ` · ${alias.counts[value]}` : ''}
                        </Badge>
                      ))}
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </SurfaceBody>
    </Surface>
  )
}

function ResultBlock({ children, title }: { children: ReactNode; title: ReactNode }) {
  return (
    <div className="rounded-[5px] border border-border bg-background/35 p-4">
      <div className="mb-4 flex items-center gap-2 font-medium text-success text-sm">
        <CheckCircle2 aria-hidden="true" size={16} />
        {title}
      </div>
      {children}
    </div>
  )
}

function VocabularyDisabled({ title }: { title: ReactNode }) {
  const { t } = useTranslation()

  return (
    <PageShell>
      <PageHeader title={title} />
      <FeatureDisabled>{t('vocab.disabled')}</FeatureDisabled>
    </PageShell>
  )
}

function StatusBadge({ status }: { status: Vocabulary['status'] }) {
  const { t } = useTranslation()

  return (
    <Badge tone={status === 'curated' ? 'green' : 'orange'}>
      <span className="mr-2">
        <StatusDot tone={status === 'curated' ? 'green' : 'amber'} />
      </span>
      {t(`vocab.status.${status}`)}
    </Badge>
  )
}

function VocabularyId({ id }: { id: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 truncate text-[0.95rem] text-muted-foreground" title={id}>
        {ellipsizeMiddle(id, 10)}
      </code>
      <CopyTextButton label="Copy vocabulary id" text={id} />
    </div>
  )
}

function parseExtractorDraft({
  advanced,
  rawKey,
  stdKey,
}: {
  advanced: boolean
  rawKey: string
  stdKey: string
}): Extractor | 'invalid' | null {
  if (!advanced) {
    return null
  }

  const raw = rawKey.trim()
  const std = stdKey.trim()

  if (raw === '' && std === '') {
    return null
  }

  if (raw === '' || std === '') {
    return 'invalid'
  }

  return {
    source: 'assistant_json',
    raw_key: raw,
    std_key: std,
  }
}

function readExtractor(vocabulary: Vocabulary): Extractor | null {
  const extractor = vocabulary.meta.extractor

  if (!isRecord(extractor)) {
    return null
  }

  return extractor.source === 'assistant_json' &&
    typeof extractor.raw_key === 'string' &&
    typeof extractor.std_key === 'string'
    ? {
        source: 'assistant_json',
        raw_key: extractor.raw_key,
        std_key: extractor.std_key,
      }
    : null
}

interface CollectedConflict {
  readonly aliases: ReadonlyArray<{
    readonly alias: string
    readonly also_seen: readonly string[]
    readonly chosen?: string
    readonly counts: Record<string, number>
  }>
  readonly canonical: string
}

function collectConflicts(terms: readonly Term[]): CollectedConflict[] {
  const out: CollectedConflict[] = []

  for (const term of terms) {
    const conflicts = isRecord(term.meta.alias_conflicts) ? term.meta.alias_conflicts : null

    if (!conflicts) {
      continue
    }

    const aliases = Object.entries(conflicts)
      .map(([alias, value]) => readAliasConflict(alias, value))
      .filter((value): value is CollectedConflict['aliases'][number] => value !== null)

    if (aliases.length > 0) {
      out.push({ aliases, canonical: term.canonical })
    }
  }

  return out
}

function readAliasConflict(
  alias: string,
  value: unknown,
): CollectedConflict['aliases'][number] | null {
  if (!isRecord(value)) {
    return null
  }

  return {
    alias,
    also_seen: Array.isArray(value.also_seen)
      ? value.also_seen.filter((item): item is string => typeof item === 'string')
      : [],
    ...(typeof value.chosen === 'string' ? { chosen: value.chosen } : {}),
    counts: readCounts(value.counts),
  } satisfies AliasConflict & { alias: string }
}

function readCounts(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
