import { Link, useNavigate } from '@tanstack/react-router'
import { Upload } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { Field, FormError } from '@/components/ui/field.js'
import { TextInput } from '@/components/ui/input.js'
import {
  KeyValueGrid,
  KeyValueRow,
  PageHeader,
  PageShell,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { useV2Ingest } from '../../api/hooks.js'
import { RefConflictRecovery, readRefConflictDetail } from '../../components/RefConflictRecovery.js'
import { V2MutationError } from '../../components/V2MutationError.js'

export function V2IngestPageView() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const ingest = useV2Ingest()
  const [file, setFile] = useState<File | null>(null)
  const [ref, setRef] = useState('')
  const [expectedVersion, setExpectedVersion] = useState('')
  const [message, setMessage] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (file === null) {
      setFormError(t('v2.ingest.fileRequired'))
      return
    }
    if (expectedVersion.trim() !== '' && ref.trim() === '') {
      setFormError(t('v2.ingest.expectedNeedsRef'))
      return
    }
    if (message.trim() !== '' && ref.trim() === '') {
      setFormError(t('v2.ingest.messageNeedsRef'))
      return
    }
    setFormError(null)
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    ingest.mutate(
      {
        expectedRefVersion: blankToNull(expectedVersion),
        file,
        message: blankToNull(message),
        ref: blankToNull(ref),
        signal: controller.signal,
      },
      {
        onSettled: () => {
          if (controllerRef.current === controller) controllerRef.current = null
          if (controller.signal.aborted) ingest.reset()
        },
      },
    )
  }

  const conflict = readRefConflictDetail(ingest.error)

  return (
    <PageShell>
      <PageHeader
        description={t('v2.ingest.description')}
        eyebrow={t('v2.ingest.eyebrow')}
        title={t('v2.ingest.title')}
      />
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('v2.ingest.upload')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          <form className="space-y-5" onSubmit={submit}>
            <label className="flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-[6px] border border-dashed border-border-strong bg-background/65 px-6 py-8 text-center transition hover:border-primary focus-within:border-primary">
              <Upload aria-hidden="true" className="text-primary" size={24} />
              <span className="mt-4 text-sm">{t('v2.ingest.chooseFile')}</span>
              <span className="mt-2 text-dim-foreground text-xs">
                {file?.name ?? t('v2.ingest.fileHint')}
              </span>
              <input
                accept=".jsonl,application/x-ndjson"
                className="sr-only"
                onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <Field hint={t('v2.ingest.refHint')} label={t('v2.ingest.ref')}>
                <TextInput
                  aria-label={t('v2.ingest.ref')}
                  onChange={(event) => setRef(event.currentTarget.value)}
                  value={ref}
                />
              </Field>
              <Field hint={t('v2.ingest.expectedHint')} label={t('v2.ingest.expected')}>
                <TextInput
                  aria-label={t('v2.ingest.expected')}
                  disabled={ref.trim() === ''}
                  onChange={(event) => setExpectedVersion(event.currentTarget.value)}
                  value={expectedVersion}
                />
              </Field>
            </div>
            <Field label={t('v2.ingest.message')}>
              <TextInput
                aria-label={t('v2.ingest.message')}
                disabled={ref.trim() === ''}
                onChange={(event) => setMessage(event.currentTarget.value)}
                value={message}
              />
            </Field>
            {formError ? <FormError>{formError}</FormError> : null}
            <div className="flex flex-wrap gap-2">
              <Button disabled={ingest.isPending} type="submit">
                {ingest.isPending ? t('v2.ingest.uploading') : t('v2.ingest.action')}
              </Button>
              {ingest.isPending ? (
                <Button
                  onClick={() => controllerRef.current?.abort()}
                  type="button"
                  variant="outline"
                >
                  {t('v2.ingest.cancel')}
                </Button>
              ) : null}
            </div>
          </form>
        </SurfaceBody>
      </Surface>

      {ingest.isError && conflict === null ? <V2MutationError error={ingest.error} /> : null}
      {conflict ? (
        <RefConflictRecovery
          error={ingest.error}
          onResolved={(version) => {
            void navigate({ params: { ref: version }, to: '/v2/datasets/$ref' })
          }}
        />
      ) : null}
      {ingest.data ? (
        <Surface>
          <SurfaceHeader>
            <SurfaceTitle>{t('v2.ingest.complete')}</SurfaceTitle>
          </SurfaceHeader>
          <SurfaceBody className="space-y-4">
            <KeyValueGrid>
              <KeyValueRow label={t('v2.datasets.version')}>
                <code className="break-all text-xs">{ingest.data.dataset_version}</code>
              </KeyValueRow>
              <KeyValueRow
                label={t('v2.detail.records')}
                value={ingest.data.manifest.num_records}
              />
            </KeyValueGrid>
            <Button asChild variant="outline">
              <Link params={{ ref: ingest.data.dataset_version }} to="/v2/datasets/$ref">
                {t('v2.ingest.openDataset')}
              </Link>
            </Button>
          </SurfaceBody>
        </Surface>
      ) : null}
    </PageShell>
  )
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
