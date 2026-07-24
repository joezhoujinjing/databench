import { Download } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { Button } from '@/components/ui/button.js'
import { JSON_PREVIEW_MAX_BYTES } from './json-serialization.js'
import { LazySection } from './LazySection.js'

type SerializationState =
  | { status: 'working' }
  | { status: 'preview'; text: string }
  | { status: 'download'; url: string }
  | { status: 'error' }

export function JsonValueView({ label, value }: { label: string; value: unknown }) {
  const { t } = useTranslation()

  if (value === null) {
    return <InlineJsonValue label={label}>{t('v2.record.none')}</InlineJsonValue>
  }
  if (typeof value === 'string') {
    return <InlineJsonValue label={label}>{value}</InlineJsonValue>
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <InlineJsonValue label={label}>{String(value)}</InlineJsonValue>
  }
  if (Array.isArray(value) && value.length === 0) {
    return <InlineJsonValue label={label}>[]</InlineJsonValue>
  }
  if (isRecord(value) && isEmptyRecord(value)) {
    return <InlineJsonValue label={label}>{'{}'}</InlineJsonValue>
  }

  return (
    <LazySection title={label}>
      {() => <WorkerJsonDocument downloadName="value.json" value={value} />}
    </LazySection>
  )
}

function InlineJsonValue({ children, label }: { children: string; label: string }) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[9rem_1fr]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs">{children}</span>
    </div>
  )
}

export function WorkerJsonDocument({
  downloadName,
  value,
}: {
  downloadName: string
  value: unknown
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<SerializationState>({ status: 'working' })
  const safeDownloadName = useMemo(() => sanitizeDownloadName(downloadName), [downloadName])

  useEffect(() => {
    let active = true
    let objectUrl: string | undefined
    setState({ status: 'working' })

    if (typeof Worker === 'undefined' || typeof URL.createObjectURL !== 'function') {
      setState({ status: 'error' })
      return
    }

    let worker: Worker
    try {
      worker = new Worker(new URL('./json.worker.ts', import.meta.url), {
        name: 'databench-v2-json',
        type: 'module',
      })
    } catch {
      setState({ status: 'error' })
      return
    }

    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!active || !isRecord(event.data) || typeof event.data.kind !== 'string') return
      if (event.data.kind === 'preview' && typeof event.data.text === 'string') {
        setState({ status: 'preview', text: event.data.text })
        worker.terminate()
        return
      }
      if (event.data.kind === 'download' && event.data.blob instanceof Blob) {
        objectUrl = URL.createObjectURL(event.data.blob)
        setState({ status: 'download', url: objectUrl })
        worker.terminate()
        return
      }
      setState({ status: 'error' })
      worker.terminate()
    }
    worker.onerror = (event) => {
      event.preventDefault()
      if (active) setState({ status: 'error' })
      worker.terminate()
    }
    try {
      worker.postMessage({ previewMaxBytes: JSON_PREVIEW_MAX_BYTES, value })
    } catch {
      worker.terminate()
      setState({ status: 'error' })
    }

    return () => {
      active = false
      worker.terminate()
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [value])

  if (state.status === 'working') {
    return (
      <div aria-live="polite" className="text-muted-foreground text-sm">
        {t('v2.record.jsonPreparing')}
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div role="alert" className="text-danger text-sm">
        {t('v2.record.jsonError')}
      </div>
    )
  }
  if (state.status === 'download') {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">{t('v2.record.jsonTooLarge')}</p>
        <Button asChild size="sm" variant="outline">
          <a download={safeDownloadName} href={state.url}>
            <Download aria-hidden="true" size={15} />
            {t('v2.record.downloadJson')}
          </a>
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <CopyTextButton label={t('v2.record.copyJson')} text={state.text} />
      </div>
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-[5px] border border-border bg-background p-4 font-mono text-dim-foreground text-xs leading-6">
        {state.text}
      </pre>
    </div>
  )
}

function sanitizeDownloadName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return sanitized === '' ? 'record.json' : sanitized.slice(0, 120)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isEmptyRecord(value: Record<string, unknown>): boolean {
  for (const key in value) {
    if (Object.hasOwn(value, key)) return false
  }
  return true
}
