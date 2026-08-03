import { Link } from '@tanstack/react-router'
import { ArrowLeft, Download, Eye } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { ApiError } from '@/api/errors.js'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { ErrorState, Spinner } from '@/components/common/State.js'
import { Alert } from '@/components/ui/alert.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { CodeEditor } from '@/components/ui/code-editor.js'
import { Field, FormError } from '@/components/ui/field.js'
import { SelectInput } from '@/components/ui/input.js'
import {
  PageShell,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { formatInteger } from '@/lib/format.js'
import { chooseExportTarget, downloadExportV2, ExportDownloadError } from '../../api/export.js'
import { useV2Converters, useV2PreviewExport } from '../../api/hooks.js'
import type {
  ConverterDescriptorV2,
  ConverterNameV2,
  ExportPlanV2,
  ExportPreviewV2,
} from '../../api/types.js'
import { FidelityReview, hasSemanticChanges } from '../../components/export/FidelityReview.js'
import { V2MutationError } from '../../components/V2MutationError.js'
import { parseJsonObject } from '../transforms/TransformsPageView.js'

type DownloadState =
  | { kind: 'idle' }
  | { bytes: number; kind: 'running' }
  | { bytes: number; kind: 'complete' }
  | { cliCommand?: string; error: unknown; kind: 'failed' }
  | { kind: 'cancelled' }

type EvalScopeTargetSource = 'selected-candidate' | 'verification-ground-truth' | 'none'

type ConverterOptionsMode =
  | { kind: 'none' }
  | { kind: 'evalscope-target-source' }
  | { kind: 'json' }

export function V2ExportPageView({ exactVersion }: { exactVersion: string }) {
  const { t } = useTranslation()
  const backend = useBackend()
  const converters = useV2Converters()
  const previewRequest = useV2PreviewExport()
  const [converter, setConverter] = useState<ConverterNameV2 | ''>('')
  const [optionsText, setOptionsText] = useState('{}')
  const [targetSource, setTargetSource] = useState<EvalScopeTargetSource>('selected-candidate')
  const [plan, setPlan] = useState<ExportPlanV2 | null>(null)
  const [preview, setPreview] = useState<ExportPreviewV2 | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [drifted, setDrifted] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [download, setDownload] = useState<DownloadState>({ kind: 'idle' })
  const controller = useRef<AbortController | null>(null)
  const previewController = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      controller.current?.abort()
      previewController.current?.abort()
    },
    [],
  )

  useEffect(() => {
    const first = converters.data?.items[0]?.name
    if (converter === '' && first !== undefined) setConverter(first)
  }, [converter, converters.data])

  useEffect(() => {
    void converter
    void exactVersion
    void optionsText
    void targetSource
    const activeDownload = controller.current
    const activePreview = previewController.current
    controller.current = null
    previewController.current = null
    activeDownload?.abort()
    activePreview?.abort()
    setPlan(null)
    setPreview(null)
    setConfirmed(false)
    setDrifted(false)
    setDownload({ kind: 'idle' })
  }, [converter, exactVersion, optionsText, targetSource])

  const selectedDescriptor = converters.data?.items.find((item) => item.name === converter)
  const optionsMode = converterOptionsMode(selectedDescriptor)

  function generatePreview(event: FormEvent) {
    event.preventDefault()
    if (converter === '') {
      setFormError(t('v2.export.converterRequired'))
      return
    }
    const options = exportOptions(optionsMode, targetSource, optionsText)
    if (!options.ok) {
      setFormError(
        options.reason === 'not_object'
          ? t('v2.export.optionsObject')
          : t('v2.export.optionsInvalid', { message: options.message }),
      )
      return
    }
    setFormError(null)
    previewController.current?.abort()
    const nextController = new AbortController()
    previewController.current = nextController
    previewRequest.mutate(
      {
        refOrVersion: exactVersion,
        request: { converter, options: options.value },
        signal: nextController.signal,
      },
      {
        onSuccess: (nextPreview) => {
          if (nextController.signal.aborted || previewController.current !== nextController) {
            return
          }
          setPlan(nextPreview.plan)
          setPreview(nextPreview)
          setConfirmed(false)
          setDrifted(false)
        },
        onSettled: () => {
          if (previewController.current === nextController) {
            previewController.current = null
            if (nextController.signal.aborted) previewRequest.reset()
          }
        },
      },
    )
  }

  async function startDownload() {
    if (plan === null || (hasSemanticChanges(plan) && !confirmed)) return
    const nextController = new AbortController()
    controller.current = nextController
    setDownload({ bytes: 0, kind: 'running' })
    try {
      const target = await chooseExportTarget(plan.suggested_filename)
      const result = await downloadExportV2({
        base: backend.base,
        onBytes: (bytes) => {
          if (controller.current === nextController) setDownload({ bytes, kind: 'running' })
        },
        plan,
        signal: nextController.signal,
        target,
        token: backend.token,
      })
      if (controller.current === nextController) {
        setDownload({ bytes: result.bytes, kind: 'complete' })
      }
    } catch (error) {
      if (controller.current !== nextController) return
      if (nextController.signal.aborted || isAbortError(error)) {
        setDownload({ kind: 'cancelled' })
      } else {
        const replacement = fidelityPlanFromError(error)
        if (replacement !== null && replacement.dataset_version === exactVersion) {
          setPlan(replacement)
          setPreview(null)
          setConfirmed(false)
          setDrifted(true)
        }
        setDownload({
          error,
          kind: 'failed',
          ...(error instanceof ExportDownloadError && error.cliCommand !== undefined
            ? { cliCommand: error.cliCommand }
            : {}),
        })
      }
    } finally {
      if (controller.current === nextController) controller.current = null
    }
  }

  const options = (converters.data?.items ?? []).map((item) => ({
    label: `${item.name} · v${item.version}`,
    value: item.name,
  }))

  return (
    <PageShell className="space-y-4">
      <header className="space-y-3">
        <Link
          className="inline-flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          params={{ ref: exactVersion }}
          to="/datasets/$ref"
        >
          <ArrowLeft aria-hidden="true" size={15} />
          {t('v2.export.back')}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-semibold text-[1.75rem] leading-tight tracking-tight">
              {t('v2.export.title')}
            </h1>
            <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-dim-foreground text-xs">
              <span>{t('v2.export.exactVersion')}</span>
              <code className="max-w-[34rem] truncate">{exactVersion}</code>
              <CopyTextButton label={t('v2.record.copy')} text={exactVersion} />
            </div>
          </div>
        </div>
      </header>
      <Surface>
        <SurfaceBody className="py-4">
          {converters.isLoading ? <Spinner /> : null}
          {converters.isError ? <ErrorState error={converters.error} /> : null}
          {!converters.isLoading && !converters.isError ? (
            <form
              className="grid items-start gap-4 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(20rem,1.2fr)_auto]"
              onSubmit={generatePreview}
            >
              <Field className="min-w-0" label={t('v2.export.converter')}>
                <SelectInput
                  aria-label={t('v2.export.converter')}
                  className="w-full"
                  onValueChange={(value) => {
                    setConverter(value)
                    setOptionsText('{}')
                    setTargetSource('selected-candidate')
                    setFormError(null)
                  }}
                  options={options}
                  value={converter}
                />
              </Field>
              <ConverterOptionsField
                mode={optionsMode}
                onOptionsTextChange={setOptionsText}
                onTargetSourceChange={setTargetSource}
                optionsText={optionsText}
                targetSource={targetSource}
              />
              <Button
                className="w-full lg:mt-7 lg:w-auto"
                disabled={previewRequest.isPending || converter === ''}
                type="submit"
              >
                <Eye aria-hidden="true" size={16} />
                {previewRequest.isPending ? t('v2.export.inspecting') : t('v2.export.inspect')}
              </Button>
              {formError ? (
                <div className="lg:col-span-3">
                  <FormError>{formError}</FormError>
                </div>
              ) : null}
            </form>
          ) : null}
        </SurfaceBody>
      </Surface>
      {previewRequest.isError ? <V2MutationError error={previewRequest.error} /> : null}
      {drifted ? (
        <Alert className="border-warning/40 bg-warning/8" role="alert">
          {t('v2.export.planDrifted')}
        </Alert>
      ) : null}
      {plan ? (
        <>
          {preview ? <ExportPreviewComparison preview={preview} /> : null}
          <FidelityReview plan={plan} />
          <Surface>
            <SurfaceBody className="space-y-4">
              {hasSemanticChanges(plan) ? (
                <label className="flex items-start gap-3 text-sm">
                  <input
                    checked={confirmed}
                    className="mt-1"
                    onChange={(event) => setConfirmed(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span>{t('v2.export.confirmSemantic')}</span>
                </label>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={download.kind === 'running' || (hasSemanticChanges(plan) && !confirmed)}
                  onClick={() => void startDownload()}
                  type="button"
                >
                  <Download aria-hidden="true" size={16} />
                  {t('v2.export.download')}
                </Button>
                {download.kind === 'running' ? (
                  <Button
                    onClick={() => controller.current?.abort()}
                    type="button"
                    variant="outline"
                  >
                    {t('v2.export.cancel')}
                  </Button>
                ) : null}
              </div>
              <DownloadStatus state={download} />
            </SurfaceBody>
          </Surface>
        </>
      ) : null}
    </PageShell>
  )
}

function ConverterOptionsField({
  mode,
  onOptionsTextChange,
  onTargetSourceChange,
  optionsText,
  targetSource,
}: {
  mode: ConverterOptionsMode
  onOptionsTextChange(value: string): void
  onTargetSourceChange(value: EvalScopeTargetSource): void
  optionsText: string
  targetSource: EvalScopeTargetSource
}) {
  const { t } = useTranslation()
  if (mode.kind === 'none') {
    return (
      <Field label={t('v2.export.options')}>
        <div className="flex min-h-10 items-center rounded-[4px] border border-border bg-background/35 px-3 text-dim-foreground text-sm">
          {t('v2.export.noOptions')}
        </div>
      </Field>
    )
  }
  if (mode.kind === 'evalscope-target-source') {
    const targetOptions = (
      ['selected-candidate', 'verification-ground-truth', 'none'] as const
    ).map((value) => ({
      label: t(`v2.export.targetSources.${value}`),
      value,
    }))
    return (
      <Field
        hint={t(`v2.export.targetSourceHints.${targetSource}`)}
        label={t('v2.export.targetSource')}
      >
        <SelectInput
          aria-label={t('v2.export.targetSource')}
          className="w-full"
          onValueChange={onTargetSourceChange}
          options={targetOptions}
          value={targetSource}
        />
      </Field>
    )
  }
  return (
    <Field hint={t('v2.export.optionsHint')} label={t('v2.export.options')}>
      <CodeEditor
        aria-label={t('v2.export.options')}
        language="JSON"
        minRows={3}
        onChange={(event) => onOptionsTextChange(event.currentTarget.value)}
        value={optionsText}
      />
    </Field>
  )
}

function ExportPreviewComparison({ preview }: { preview: ExportPreviewV2 }) {
  const { t } = useTranslation()
  const { plan, source_record: source, output_record: output } = preview
  return (
    <section aria-live="polite" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3 px-0.5">
        <div>
          <h2 className="font-semibold text-lg">{t('v2.export.previewTitle')}</h2>
          <p className="mt-1 text-muted-foreground text-sm leading-6">
            {t('v2.export.previewRelationship')}
          </p>
        </div>
        <Badge tone={plan.output_count === 0 ? 'orange' : 'green'}>
          {t('v2.export.outputRecords', { count: formatInteger(plan.output_count) })}
        </Badge>
      </div>
      <div className="grid items-stretch gap-4 xl:grid-cols-2">
        <PreviewPanel
          details={
            source === null
              ? []
              : [
                  { label: t('v2.export.recordId'), value: source.record_id },
                  { label: t('v2.export.recordDigest'), value: source.record_digest },
                ]
          }
          emptyMessage={t('v2.export.emptySource')}
          subtitle={t('v2.export.sourceSubtitle')}
          text={source?.text ?? null}
          title={t('v2.export.sourceStructure')}
          truncated={source?.truncated ?? false}
        />
        <PreviewPanel
          details={[
            {
              label: t('v2.export.converter'),
              value: `${plan.converter} v${plan.converter_version}`,
            },
            { label: t('v2.export.mediaType'), value: plan.media_type },
          ]}
          emptyMessage={
            plan.output_count === 0 ? t('v2.export.zeroOutput') : t('v2.export.emptyOutputPreview')
          }
          subtitle={t('v2.export.outputSubtitle')}
          text={output?.text ?? null}
          title={t('v2.export.outputStructure')}
          truncated={output?.truncated ?? false}
        />
      </div>
    </section>
  )
}

function PreviewPanel({
  details,
  emptyMessage,
  subtitle,
  text,
  title,
  truncated,
}: {
  details: readonly { label: string; value: string }[]
  emptyMessage: string
  subtitle: string
  text: string | null
  title: string
  truncated: boolean
}) {
  const { t } = useTranslation()
  return (
    <Surface className="flex min-h-[25rem] flex-col overflow-hidden shadow-none">
      <SurfaceHeader className="flex min-h-[5.25rem] flex-wrap items-start justify-between gap-3 py-3.5">
        <div className="min-w-0">
          <SurfaceTitle>{title}</SurfaceTitle>
          <p className="mt-1 text-dim-foreground text-xs">{subtitle}</p>
        </div>
        <Badge tone="accent">{t('v2.export.realPreview')}</Badge>
      </SurfaceHeader>
      <div className="grid min-h-[3.25rem] grid-cols-1 gap-x-4 gap-y-1 border-border border-b bg-surface-soft/45 px-4 py-2 text-xs sm:grid-cols-2">
        {details.map((detail) => (
          <div className="flex min-w-0 items-center gap-2" key={detail.label}>
            <span className="shrink-0 text-dim-foreground">{detail.label}</span>
            <code className="truncate" title={detail.value}>
              {detail.value}
            </code>
          </div>
        ))}
      </div>
      {text === null ? (
        <div className="flex flex-1 items-center justify-center bg-code px-8 py-12 text-center text-muted-foreground text-sm leading-6">
          {emptyMessage}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 bg-code">
          <CopyTextButton
            className="absolute top-2 right-2 z-10 border border-border bg-surface/90"
            label={t('v2.export.copyPreview')}
            text={text}
          />
          <pre className="h-full max-h-[30rem] min-h-[19rem] overflow-auto p-4 pr-12 font-mono text-foreground text-xs leading-5">
            {formatPreviewText(text, truncated)}
          </pre>
          {truncated ? (
            <div className="border-border border-t bg-surface-soft px-4 py-2 text-warning text-xs">
              {t('v2.export.previewTruncated')}
            </div>
          ) : null}
        </div>
      )}
    </Surface>
  )
}

export function converterOptionsMode(
  descriptor: ConverterDescriptorV2 | undefined,
): ConverterOptionsMode {
  if (descriptor === undefined) return { kind: 'none' }
  const schema = descriptor.options_schema
  const properties = isRecord(schema.properties) ? schema.properties : null
  if (
    properties !== null &&
    Object.keys(properties).length === 0 &&
    schema.additionalProperties === false
  ) {
    return { kind: 'none' }
  }
  const targetSource = properties?.target_source
  if (descriptor.name === 'evalscope-general-qa' && isRecord(targetSource)) {
    const values = targetSource.enum
    if (
      Array.isArray(values) &&
      ['selected-candidate', 'verification-ground-truth', 'none'].every((value) =>
        values.includes(value),
      )
    ) {
      return { kind: 'evalscope-target-source' }
    }
  }
  return { kind: 'json' }
}

function exportOptions(
  mode: ConverterOptionsMode,
  targetSource: EvalScopeTargetSource,
  optionsText: string,
) {
  if (mode.kind === 'none') return { ok: true as const, value: {} }
  if (mode.kind === 'evalscope-target-source') {
    return { ok: true as const, value: { target_source: targetSource } }
  }
  return parseJsonObject(optionsText)
}

export function formatPreviewText(text: string, truncated: boolean): string {
  if (truncated) return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function DownloadStatus({ state }: { state: DownloadState }) {
  const { t } = useTranslation()
  if (state.kind === 'idle') return null
  if (state.kind === 'running') {
    return (
      <div aria-live="polite" className="text-muted-foreground text-sm">
        {t('v2.export.downloading', { bytes: formatInteger(state.bytes) })}
      </div>
    )
  }
  if (state.kind === 'complete') {
    return (
      <Alert aria-live="polite">
        {t('v2.export.complete', { bytes: formatInteger(state.bytes) })}
      </Alert>
    )
  }
  if (state.kind === 'cancelled') return <Alert>{t('v2.export.cancelled')}</Alert>
  const message =
    state.error instanceof ExportDownloadError
      ? t(`v2.export.downloadError.${state.error.code}`)
      : state.error instanceof Error
        ? state.error.message
        : t('v2.common.unknownError')
  return (
    <Alert className="space-y-3 border-danger/35 bg-danger/10 text-danger" role="alert">
      <div>{message}</div>
      {state.cliCommand ? (
        <div>
          <div>{t('v2.export.useCli')}</div>
          <code className="mt-2 block break-all text-xs">{state.cliCommand}</code>
        </div>
      ) : null}
    </Alert>
  )
}

export function fidelityPlanFromError(error: unknown): ExportPlanV2 | null {
  if (!(error instanceof ApiError) || error.code !== 'fidelity_error' || !isRecord(error.detail)) {
    return null
  }
  const plan = error.detail.plan
  if (
    !isRecord(plan) ||
    !isRecord(plan.config_hints) ||
    typeof plan.dataset_version !== 'string' ||
    typeof plan.fidelity_digest !== 'string' ||
    typeof plan.converter !== 'string' ||
    typeof plan.converter_version !== 'string' ||
    plan.export_fidelity_profile !== 'databench-export-fidelity-1' ||
    typeof plan.media_type !== 'string' ||
    !isRecord(plan.normalized_options) ||
    typeof plan.output_count !== 'number' ||
    typeof plan.suggested_filename !== 'string' ||
    !isRecord(plan.fidelity) ||
    !Array.isArray(plan.fidelity.changes) ||
    !plan.fidelity.changes.every(isFidelityChange) ||
    !Array.isArray(plan.fidelity.preserved) ||
    !plan.fidelity.preserved.every((value) => typeof value === 'string')
  ) {
    return null
  }
  return plan as ExportPlanV2
}

function isFidelityChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.action === 'transformed' || value.action === 'dropped') &&
    (value.impact === 'none' || value.impact === 'informational' || value.impact === 'semantic') &&
    typeof value.path === 'string' &&
    typeof value.reason === 'string'
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
