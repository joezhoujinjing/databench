import { Download, Search } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { ApiError } from '@/api/errors.js'
import { ErrorState, Spinner } from '@/components/common/State.js'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { CodeEditor } from '@/components/ui/code-editor.js'
import { Field, FormError } from '@/components/ui/field.js'
import { SelectInput } from '@/components/ui/input.js'
import { PageHeader, PageShell, Surface, SurfaceBody } from '@/components/ui/surface.js'
import { formatInteger } from '@/lib/format.js'
import { chooseExportTarget, downloadExportV2, ExportDownloadError } from '../../api/export.js'
import { useV2Converters, useV2InspectExport } from '../../api/hooks.js'
import type { ConverterNameV2, ExportPlanV2 } from '../../api/types.js'
import { FidelityReview, hasSemanticChanges } from '../../components/export/FidelityReview.js'
import { V2MutationError } from '../../components/V2MutationError.js'
import { parseJsonObject } from '../transforms/TransformsPageView.js'

type DownloadState =
  | { kind: 'idle' }
  | { bytes: number; kind: 'running' }
  | { bytes: number; kind: 'complete' }
  | { cliCommand?: string; error: unknown; kind: 'failed' }
  | { kind: 'cancelled' }

export function V2ExportPageView({ exactVersion }: { exactVersion: string }) {
  const { t } = useTranslation()
  const backend = useBackend()
  const converters = useV2Converters()
  const inspect = useV2InspectExport()
  const [converter, setConverter] = useState<ConverterNameV2 | ''>('')
  const [optionsText, setOptionsText] = useState('{}')
  const [plan, setPlan] = useState<ExportPlanV2 | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [drifted, setDrifted] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [download, setDownload] = useState<DownloadState>({ kind: 'idle' })
  const controller = useRef<AbortController | null>(null)
  const inspectController = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      controller.current?.abort()
      inspectController.current?.abort()
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
    const activeDownload = controller.current
    const activeInspect = inspectController.current
    controller.current = null
    inspectController.current = null
    activeDownload?.abort()
    activeInspect?.abort()
    setPlan(null)
    setConfirmed(false)
    setDrifted(false)
    setDownload({ kind: 'idle' })
  }, [converter, exactVersion, optionsText])

  function inspectPlan(event: FormEvent) {
    event.preventDefault()
    const options = parseJsonObject(optionsText)
    if (converter === '') {
      setFormError(t('v2.export.converterRequired'))
      return
    }
    if (!options.ok) {
      setFormError(
        options.reason === 'not_object'
          ? t('v2.export.optionsObject')
          : t('v2.export.optionsInvalid', { message: options.message }),
      )
      return
    }
    setFormError(null)
    inspectController.current?.abort()
    const nextController = new AbortController()
    inspectController.current = nextController
    inspect.mutate(
      {
        refOrVersion: exactVersion,
        request: { converter, options: options.value },
        signal: nextController.signal,
      },
      {
        onSuccess: (nextPlan) => {
          if (nextController.signal.aborted || inspectController.current !== nextController) {
            return
          }
          setPlan(nextPlan)
          setConfirmed(false)
          setDrifted(false)
        },
        onSettled: () => {
          if (inspectController.current === nextController) {
            inspectController.current = null
            if (nextController.signal.aborted) inspect.reset()
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
    <PageShell>
      <PageHeader description={t('v2.export.description')} title={t('v2.export.title')} />
      <Surface>
        <SurfaceBody>
          {converters.isLoading ? <Spinner /> : null}
          {converters.isError ? <ErrorState error={converters.error} /> : null}
          {!converters.isLoading && !converters.isError ? (
            <form className="space-y-5" onSubmit={inspectPlan}>
              <Field label={t('v2.export.converter')}>
                <SelectInput
                  aria-label={t('v2.export.converter')}
                  onValueChange={setConverter}
                  options={options}
                  value={converter}
                />
              </Field>
              <Field hint={t('v2.export.optionsHint')} label={t('v2.export.options')}>
                <CodeEditor
                  aria-label={t('v2.export.options')}
                  language="JSON"
                  minRows={7}
                  onChange={(event) => setOptionsText(event.currentTarget.value)}
                  value={optionsText}
                />
              </Field>
              {formError ? <FormError>{formError}</FormError> : null}
              <Button disabled={inspect.isPending || converter === ''} type="submit">
                <Search aria-hidden="true" size={16} />
                {inspect.isPending ? t('v2.export.inspecting') : t('v2.export.inspect')}
              </Button>
            </form>
          ) : null}
        </SurfaceBody>
      </Surface>
      {inspect.isError ? <V2MutationError error={inspect.error} /> : null}
      {drifted ? (
        <Alert className="border-warning/40 bg-warning/8" role="alert">
          {t('v2.export.planDrifted')}
        </Alert>
      ) : null}
      {plan ? (
        <>
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
