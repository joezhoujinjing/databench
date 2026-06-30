import { Upload } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FEATURES, useModuleEnabled } from '@/api/capabilities.js'
import { useCreateDataset, useIngestJsonl } from '@/api/hooks.js'
import type { DatasetManifest, IngestKind, IngestSamplesRequest } from '@/api/types.js'
import { FeatureDisabled, InlineError } from '@/components/common/State.js'
import { ManifestView } from '@/components/datasets/ManifestView.js'
import { KindBadge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { CodeEditor } from '@/components/ui/code-editor.js'
import { Field, FormError } from '@/components/ui/field.js'
import { SelectInput, TextInput } from '@/components/ui/input.js'
import {
  MetricItem,
  MetricStrip,
  PageHeader,
  PageShell,
  SplitSurface,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { formatInteger } from '@/lib/format.js'

const KINDS: IngestKind[] = ['sft', 'preference', 'rl', 'trajectory']
const KIND_OPTIONS = KINDS.map((value) => ({ label: value, value }))
const SAMPLE_PLACEHOLDER = `[
  {
    "id": "sample_1",
    "kind": "sft",
    "messages": [
      { "role": "user", "content": "如何重置我的密码?" },
      { "role": "assistant", "content": "您可以在登录页面点击「忘记密码」，输入您的邮箱或手机号，我们会发送重置链接给您。链接有效期为 30 分钟。" }
    ]
  },
  {
    "id": "sample_2",
    "kind": "preference",
    "messages": [
      { "role": "user", "content": "Which option is better for data backups?" }
    ],
    "chosen": "Use incremental backups with daily verification.",
    "rejected": "Only copy files manually when needed."
  }
]`

export function IngestPageView() {
  const { t } = useTranslation()

  return (
    <PageShell>
      <PageHeader description={t('ingest.uploadDescription')} title={t('nav.ingest')} />
      <SplitSurface className="lg:grid-cols-[0.95fr_1fr]">
        <JsonlUploadPanel />
        <JsonSamplesPanel />
      </SplitSurface>
      <IngestionPreview />
    </PageShell>
  )
}

function JsonlUploadPanel() {
  const { t } = useTranslation()
  const enabled = useModuleEnabled(FEATURES.jsonlIngest)
  const ingest = useIngestJsonl()
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('raw')
  const [kind, setKind] = useState<IngestKind | ''>('')
  const [source, setSource] = useState('web-collector')

  if (!enabled) {
    return <FeatureDisabled>{t('ingest.jsonlDisabled')}</FeatureDisabled>
  }

  return (
    <section className="border-border border-b p-5 lg:border-r lg:border-b-0">
      <SurfaceTitle>{t('ingest.uploadTitle')}</SurfaceTitle>
      <p className="mt-3 text-muted-foreground text-sm leading-6">
        {t('ingest.uploadDescription')}
      </p>
      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (file === null) {
            return
          }
          ingest.mutate({ file, kind, name, source })
        }}
      >
        <label className="flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-[6px] border border-dashed border-border-strong bg-background/65 px-6 py-8 text-center transition hover:border-primary hover:bg-surface-hover/45">
          <Upload aria-hidden="true" className="text-primary" size={24} />
          <span className="mt-4 text-sm">Drag and drop a JSONL file here</span>
          <span className="mt-2 text-muted-foreground text-sm">
            or <span className="text-accent-foreground">click to browse</span>
          </span>
          <span className="mt-2 text-dim-foreground text-xs">.jsonl or .jsonl.gz up to 10 GB</span>
          <input
            accept=".jsonl,application/x-ndjson,application/jsonl"
            className="sr-only"
            onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
            type="file"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('ingest.nameLabel')}>
            <TextInput onChange={(event) => setName(event.currentTarget.value)} value={name} />
          </Field>
          <Field label={t('ingest.kindLabel')}>
            <SelectInput
              onValueChange={setKind}
              options={[{ label: t('ingest.kindInfer'), value: '' }, ...KIND_OPTIONS]}
              value={kind}
            />
          </Field>
        </div>
        <Field label={t('ingest.sourceLabel')}>
          <TextInput onChange={(event) => setSource(event.currentTarget.value)} value={source} />
        </Field>

        <details className="border-border border-t pt-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground transition hover:text-foreground">
            Advanced options
          </summary>
          <div className="mt-3 text-dim-foreground text-sm">
            Values here are sent as ingest query metadata when the backend supports them.
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-4 border-border border-t pt-4">
          <Button disabled={file === null || ingest.isPending} type="submit">
            {ingest.isPending ? t('ingest.uploading') : t('ingest.ingestAction')}
          </Button>
          <span className="text-muted-foreground text-sm">A new version will be created.</span>
        </div>
      </form>
      <MutationResult
        error={ingest.error}
        isError={ingest.isError}
        label={t('ingest.ingested')}
        manifest={ingest.data}
      />
    </section>
  )
}

function JsonSamplesPanel() {
  const { t } = useTranslation()
  const create = useCreateDataset()
  const [name, setName] = useState('raw')
  const [kind, setKind] = useState<IngestKind>('sft')
  const [message, setMessage] = useState('')
  const [text, setText] = useState(SAMPLE_PLACEHOLDER)
  const [formError, setFormError] = useState<string | null>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    const parsed = parseSamplesJson(text)

    if (!parsed.ok) {
      setFormError(
        parsed.reason === 'not_array'
          ? t('ingest.errExpectArray')
          : t('ingest.errInvalidJson', { message: parsed.message }),
      )
      return
    }

    setFormError(null)
    create.mutate({
      payload: {
        message: blankToNull(message),
        name: blankToNull(name),
        samples: applyDefaultKind(parsed.samples, kind),
      },
    })
  }

  return (
    <section className="p-5">
      <SurfaceTitle>{t('ingest.createTitle')}</SurfaceTitle>
      <p className="mt-3 text-muted-foreground text-sm leading-6">
        {t('ingest.createDescription')}
      </p>
      <form className="mt-6 space-y-5" onSubmit={submit}>
        <div className="grid gap-4 lg:grid-cols-3">
          <Field label={t('ingest.nameLabel')}>
            <TextInput onChange={(event) => setName(event.currentTarget.value)} value={name} />
          </Field>
          <Field label={t('ingest.kindLabel')}>
            <SelectInput onValueChange={setKind} options={KIND_OPTIONS} value={kind} />
          </Field>
          <Field label={t('ingest.messageLabel')}>
            <TextInput
              onChange={(event) => setMessage(event.currentTarget.value)}
              value={message}
            />
          </Field>
        </div>
        <Field label={t('ingest.samplesLabel')}>
          <CodeEditor
            aria-label={t('ingest.samplesLabel')}
            language="JSON array"
            maxRows={12}
            minRows={12}
            onChange={(event) => setText(event.currentTarget.value)}
            value={text}
          />
        </Field>
        {formError ? <FormError>{formError}</FormError> : null}
        <div className="flex justify-end">
          <Button disabled={text.trim() === '' || create.isPending} type="submit">
            {create.isPending ? t('ingest.creating') : t('ingest.createAction')}
          </Button>
        </div>
      </form>
      <MutationResult
        error={create.error}
        isError={create.isError}
        label={t('ingest.created')}
        manifest={create.data}
      />
    </section>
  )
}

function MutationResult({
  error,
  isError,
  label,
  manifest,
}: {
  error: unknown
  isError: boolean
  label: string
  manifest: DatasetManifest | undefined
}) {
  if (isError) {
    return (
      <div className="mt-5">
        <InlineError error={error} />
      </div>
    )
  }

  if (manifest === undefined) {
    return null
  }

  return (
    <Surface className="mt-5">
      <SurfaceHeader>
        <SurfaceTitle>{label}</SurfaceTitle>
      </SurfaceHeader>
      <SurfaceBody>
        <ManifestView linkToDetail manifest={manifest} />
      </SurfaceBody>
    </Surface>
  )
}

function IngestionPreview() {
  return (
    <Surface>
      <SurfaceHeader>
        <SurfaceTitle>Ingestion preview</SurfaceTitle>
      </SurfaceHeader>
      <MetricStrip className="border-0 lg:grid-cols-6">
        <MetricItem label="Dataset ref" value="raw (new version)" />
        <MetricItem label="Inferred kind" value={<KindBadge kind="sft" />} />
        <MetricItem label="Rows" value={formatInteger(12_843_901)} />
        <MetricItem label="Source" value="web-collector" />
        <MetricItem label="Schema" value="raw.v12" />
        <MetricItem label="Size" value="28.7 GB" />
      </MetricStrip>
    </Surface>
  )
}

export type SamplesParseResult =
  | { ok: true; samples: IngestSamplesRequest['samples'] }
  | { ok: false; message: string; reason: 'invalid_json' }
  | { ok: false; reason: 'not_array' }

export function parseSamplesJson(text: string): SamplesParseResult {
  try {
    const value = JSON.parse(text) as unknown

    if (!Array.isArray(value)) {
      return { ok: false, reason: 'not_array' }
    }

    return { ok: true, samples: value as IngestSamplesRequest['samples'] }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      reason: 'invalid_json',
    }
  }
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function applyDefaultKind(
  samples: IngestSamplesRequest['samples'],
  kind: IngestKind,
): IngestSamplesRequest['samples'] {
  return samples.map((sample) => {
    if (typeof sample !== 'object' || sample === null || 'kind' in sample) {
      return sample
    }

    return {
      ...(sample as Record<string, unknown>),
      kind,
    } as IngestSamplesRequest['samples'][number]
  })
}
