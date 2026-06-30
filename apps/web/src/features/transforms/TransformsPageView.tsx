import { ExternalLink, Play, Search } from 'lucide-react'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRunTransform, useTransforms } from '@/api/hooks.js'
import type { DatasetManifest, TransformInfo } from '@/api/types.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { EmptyState, ErrorState, InlineError, Spinner } from '@/components/common/State.js'
import { ManifestView } from '@/components/datasets/ManifestView.js'
import { KindBadge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { CodeEditor } from '@/components/ui/code-editor.js'
import { Field, FormError } from '@/components/ui/field.js'
import { TextInput } from '@/components/ui/input.js'
import {
  PageHeader,
  PageShell,
  SplitSurface,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { cn } from '@/lib/utils.js'

export function TransformsPageView() {
  const { t } = useTranslation()
  const transforms = useTransforms()
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const items = transforms.data?.items ?? []
    return needle === '' ? items : items.filter((item) => item.name.toLowerCase().includes(needle))
  }, [filter, transforms.data])
  const selected = filtered.find((item) => item.name === selectedName) ?? filtered[0] ?? null

  return (
    <PageShell>
      <PageHeader
        description="Run deterministic operations over versioned datasets."
        title={t('transforms.title')}
      />
      <div className="grid gap-6 lg:grid-cols-[29rem_1fr]">
        <Surface className="overflow-hidden">
          <SurfaceBody className="space-y-3">
            <div className="relative block">
              <Search
                aria-hidden="true"
                className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
                size={17}
              />
              <TextInput
                aria-label="Search transforms"
                className="pl-10"
                onChange={(event) => setFilter(event.currentTarget.value)}
                placeholder="Search transforms..."
                value={filter}
              />
            </div>
          </SurfaceBody>
          {transforms.isLoading ? (
            <div className="px-5 pb-5">
              <Spinner />
            </div>
          ) : null}
          {transforms.isError ? (
            <div className="px-5 pb-5">
              <ErrorState error={transforms.error} />
            </div>
          ) : null}
          {transforms.data?.items.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState>{t('transforms.emptyList')}</EmptyState>
            </div>
          ) : null}
          <div>
            {filtered.map((transform) => (
              <button
                className={cn(
                  'grid w-full gap-2 border-border border-t px-5 py-4 text-left transition hover:bg-surface-hover',
                  transform.name === selected?.name &&
                    'border-l-2 border-l-primary bg-surface-soft shadow-[inset_18px_0_24px_-24px_var(--primary)]',
                )}
                key={transform.name}
                onClick={() => setSelectedName(transform.name)}
                type="button"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-base">{transform.name}</span>
                  <span className="text-muted-foreground text-sm">v{transform.version}</span>
                </div>
                <span className="text-muted-foreground text-sm leading-6">
                  {descriptionForTransform(transform.name)}
                </span>
              </button>
            ))}
          </div>
        </Surface>

        {selected ? (
          <RunTransformPanel key={selected.name} transform={selected} />
        ) : (
          <Surface>
            <SurfaceBody>
              <EmptyState>{t('transforms.selectPrompt')}</EmptyState>
            </SurfaceBody>
          </Surface>
        )}
      </div>
    </PageShell>
  )
}

function RunTransformPanel({ transform }: { transform: TransformInfo }) {
  const { t } = useTranslation()
  const run = useRunTransform()
  const [inputs, setInputs] = useState('raw')
  const [params, setParams] = useState(defaultParamsForTransform(transform.name))
  const [ref, setRef] = useState(defaultRefForTransform(transform.name))
  const [formError, setFormError] = useState<string | null>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    const parsedInputs = parseTransformInputs(inputs)

    if (parsedInputs.length === 0) {
      setFormError(t('transforms.errNeedInput'))
      return
    }

    const parsedParams = parseJsonObject(params)

    if (!parsedParams.ok) {
      setFormError(
        parsedParams.reason === 'not_object'
          ? t('transforms.errParamsObject')
          : t('transforms.errInvalidParams', { message: parsedParams.message }),
      )
      return
    }

    setFormError(null)
    run.mutate({
      name: transform.name,
      payload: {
        inputs: parsedInputs,
        params: parsedParams.value,
        ref: blankToNull(ref),
      },
    })
  }

  return (
    <Surface className="overflow-hidden">
      <SurfaceHeader className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <SurfaceTitle>{transform.name}</SurfaceTitle>
            <KindBadge kind={`v${transform.version}`} />
          </div>
          <p className="mt-3 text-muted-foreground text-sm leading-6">
            {descriptionForTransform(transform.name)}
          </p>
        </div>
        <Button variant="outline">
          View docs
          <ExternalLink aria-hidden="true" size={15} />
        </Button>
      </SurfaceHeader>
      <SurfaceBody>
        <form className="space-y-4" onSubmit={submit}>
          <Field
            hint="One or more dataset refs, comma or newline separated."
            label={t('transforms.inputsLabel')}
          >
            <CodeEditor
              aria-label={t('transforms.inputsLabel')}
              language="Refs"
              minRows={1}
              onChange={(event) => setInputs(event.currentTarget.value)}
              value={inputs}
            />
          </Field>
          <Field label={t('transforms.paramsLabel')}>
            <CodeEditor
              aria-label={t('transforms.paramsLabel')}
              language="JSON params"
              minRows={4}
              onChange={(event) => setParams(event.currentTarget.value)}
              value={params}
            />
          </Field>
          {transform.params_schema ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-accent-foreground">
                {t('transforms.paramsSchema')}
              </summary>
              <div className="mt-3">
                <JsonBlock value={transform.params_schema} />
              </div>
            </details>
          ) : null}
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem] md:items-end">
            <Field hint="Will be created as a new version." label={t('transforms.outputRefLabel')}>
              <TextInput onChange={(event) => setRef(event.currentTarget.value)} value={ref} />
            </Field>
            <Button className="md:mb-7" disabled={run.isPending} type="submit">
              <Play aria-hidden="true" size={16} />
              {run.isPending ? t('transforms.running') : t('transforms.runAction')}
            </Button>
          </div>
          {formError ? <FormError>{formError}</FormError> : null}
        </form>
      </SurfaceBody>
      <div className="border-border border-t">
        <SurfaceBody>
          <h3 className="font-medium">Expected output</h3>
          <p className="mt-1 text-muted-foreground text-sm">Based on inputs and parameters above</p>
          <ManifestResult
            error={run.error}
            isError={run.isError}
            label={t('transforms.outputManifest')}
            manifest={run.data}
            previewRef={ref}
            transformName={transform.name}
          />
        </SurfaceBody>
      </div>
    </Surface>
  )
}

function ManifestResult({
  error,
  isError,
  label,
  manifest,
  previewRef,
  transformName,
}: {
  error: unknown
  isError: boolean
  label: string
  manifest: DatasetManifest | undefined
  previewRef: string
  transformName: string
}) {
  if (isError) {
    return (
      <div className="mt-4">
        <InlineError error={error} />
      </div>
    )
  }

  return (
    <SplitSurface className="mt-4">
      <SurfaceBody>
        {manifest === undefined ? (
          <ExpectedOutputPreview outputRef={previewRef} transformName={transformName} />
        ) : (
          <>
            <div className="mb-4 font-medium text-sm">{label}</div>
            <ManifestView linkToDetail manifest={manifest} />
          </>
        )}
      </SurfaceBody>
    </SplitSurface>
  )
}

function ExpectedOutputPreview({
  outputRef,
  transformName,
}: {
  outputRef: string
  transformName: string
}) {
  return (
    <div className="grid gap-4 text-sm lg:grid-cols-[minmax(9rem,1fr)_8rem_10rem_1fr_8rem]">
      <PreviewCell
        label="Version"
        value={`${outputRef || defaultRefForTransform(transformName)}@new`}
      />
      <PreviewCell label="Rows" value={formatPreviewRows(transformName)} />
      <PreviewCell
        label="Kinds"
        value={
          <div className="flex flex-wrap gap-2">
            <KindBadge kind="sft" />
            <KindBadge kind="preference" />
          </div>
        }
      />
      <PreviewCell label="Storage" value={`s3://databench-prod/${outputRef || transformName}/`} />
      <PreviewCell label="Lineage" value="new edge" />
    </div>
  )
}

function PreviewCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 border-border border-b pb-3 last:border-b-0 lg:border-r lg:border-b-0 lg:pr-4 lg:last:border-r-0">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-2 min-w-0 break-words">{value}</div>
    </div>
  )
}

function descriptionForTransform(name: string): string {
  switch (name) {
    case 'dedup':
      return 'Remove near-duplicate conversations by content hash.'
    case 'enrich_length':
      return 'Add token and character length features.'
    case 'filter_by_signal':
      return 'Filter samples by response quality signal.'
    case 'sample_n':
      return 'Randomly sample N rows from a dataset.'
    default:
      return 'Run a registered deterministic transform.'
  }
}

function defaultParamsForTransform(name: string): string {
  switch (name) {
    case 'dedup':
      return `{
  "hash_fields": ["prompt", "response"],
  "strategy": "minhash",
  "threshold": 0.85,
  "keep": "first"
}`
    case 'enrich_length':
      return JSON.stringify({ fields: ['messages'], tokenizer: 'cl100k_base' }, null, 2)
    case 'filter_by_signal':
      return JSON.stringify({ field: 'quality_score', min: 0.72 }, null, 2)
    case 'sample_n':
      return JSON.stringify({ n: 10000, seed: 42 }, null, 2)
    default:
      return '{}'
  }
}

function defaultRefForTransform(name: string): string {
  switch (name) {
    case 'dedup':
      return 'deduped'
    case 'enrich_length':
      return 'enriched'
    case 'filter_by_signal':
      return 'filtered'
    case 'sample_n':
      return 'sampled'
    default:
      return 'transformed'
  }
}

function formatPreviewRows(name: string): string {
  return name === 'sample_n' ? '10,000' : '10,234,567'
}

export type JsonObjectParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string; reason: 'invalid_json' }
  | { ok: false; reason: 'not_object' }

export function parseTransformInputs(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((part) => part.trim())
    .filter(Boolean)
}

export function parseJsonObject(value: string): JsonObjectParseResult {
  try {
    const parsed = JSON.parse(value) as unknown

    if (!isPlainObject(parsed)) {
      return { ok: false, reason: 'not_object' }
    }

    return { ok: true, value: parsed }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      reason: 'invalid_json',
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
