import { Link, useNavigate } from '@tanstack/react-router'
import { Upload } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { CodeEditor } from '@/components/ui/code-editor.js'
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
import type { IngestResultV2 } from '../../api/types.js'
import { RefConflictRecovery, readRefConflictDetail } from '../../components/RefConflictRecovery.js'
import { V2MutationError } from '../../components/V2MutationError.js'

const RECORDS_PLACEHOLDER = `[
  {
    "schema_version": "2.0.0",
    "id": "rec_1111111111111111111111111111111111111111111111111111111111111111",
    "contents": [
      {
        "role": "user",
        "parts": [
          {
            "type": "text",
            "text": "如何重置我的密码？",
            "thought": false,
            "thought_signature": null,
            "part_metadata": {}
          }
        ],
        "loss_weight": null
      }
    ],
    "candidates": [
      {
        "id": "cand_1111111111111111111111111111111111111111111111111111111111111111",
        "contents": [
          {
            "role": "ai",
            "parts": [
              {
                "type": "text",
                "text": "请在登录页点击“忘记密码”，然后按提示验证身份。",
                "thought": false,
                "thought_signature": null,
                "part_metadata": {}
              }
            ],
            "loss_weight": null
          }
        ],
        "finish_reason": null,
        "rank": null,
        "selected": true,
        "signals": [],
        "generator": null,
        "token_count": null,
        "avg_logprobs": null
      }
    ],
    "preference_relations": [],
    "tools": [],
    "verification": null,
    "source": null,
    "lang": "zh-CN",
    "lineage": null,
    "tags": [],
    "extra": {}
  }
]`

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

  return (
    <PageShell>
      <PageHeader description={t('v2.ingest.description')} title={t('v2.ingest.title')} />
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
      <IngestOutcome
        error={ingest.error}
        isError={ingest.isError}
        onResolved={(version) => {
          void navigate({ params: { ref: version }, to: '/datasets/$ref' })
        }}
        result={ingest.data}
      />

      <JsonArrayCreatePanel />
    </PageShell>
  )
}

function JsonArrayCreatePanel() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const create = useV2Ingest()
  const [ref, setRef] = useState('')
  const [message, setMessage] = useState('')
  const [text, setText] = useState(RECORDS_PLACEHOLDER)
  const [formError, setFormError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (message.trim() !== '' && ref.trim() === '') {
      setFormError(t('v2.ingest.messageNeedsRef'))
      return
    }
    const converted = canonicalJsonArrayToJsonl(text)
    if (!converted.ok) {
      setFormError(
        converted.reason === 'not_array'
          ? t('v2.ingest.jsonArrayRequired')
          : t('v2.ingest.jsonInvalid', { message: converted.message }),
      )
      return
    }

    setFormError(null)
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    create.mutate(
      {
        expectedRefVersion: null,
        file: new File([converted.jsonl], 'pasted-records.jsonl', {
          type: 'application/x-ndjson',
        }),
        message: blankToNull(message),
        ref: blankToNull(ref),
        signal: controller.signal,
      },
      {
        onSettled: () => {
          if (controllerRef.current === controller) controllerRef.current = null
          if (controller.signal.aborted) create.reset()
        },
      },
    )
  }

  return (
    <>
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('v2.ingest.createTitle')}</SurfaceTitle>
          <p className="mt-2 text-muted-foreground text-sm leading-6">
            {t('v2.ingest.createDescription')}
          </p>
        </SurfaceHeader>
        <SurfaceBody>
          <form className="space-y-5" onSubmit={submit}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field hint={t('v2.ingest.refHint')} label={t('v2.ingest.ref')}>
                <TextInput
                  aria-label={t('v2.ingest.ref')}
                  onChange={(event) => setRef(event.currentTarget.value)}
                  value={ref}
                />
              </Field>
              <Field label={t('v2.ingest.message')}>
                <TextInput
                  aria-label={t('v2.ingest.message')}
                  disabled={ref.trim() === ''}
                  onChange={(event) => setMessage(event.currentTarget.value)}
                  value={message}
                />
              </Field>
            </div>
            <Field label={t('v2.ingest.recordsJson')}>
              <CodeEditor
                aria-label={t('v2.ingest.recordsJson')}
                language="JSON array"
                maxRows={16}
                minRows={16}
                onChange={(event) => setText(event.currentTarget.value)}
                value={text}
              />
            </Field>
            {formError ? <FormError>{formError}</FormError> : null}
            <div className="flex justify-end gap-2">
              {create.isPending ? (
                <Button
                  onClick={() => controllerRef.current?.abort()}
                  type="button"
                  variant="outline"
                >
                  {t('v2.ingest.cancelCreate')}
                </Button>
              ) : null}
              <Button disabled={text.trim() === '' || create.isPending} type="submit">
                {create.isPending ? t('v2.ingest.creating') : t('v2.ingest.createAction')}
              </Button>
            </div>
          </form>
        </SurfaceBody>
      </Surface>
      <IngestOutcome
        error={create.error}
        isError={create.isError}
        onResolved={(version) => {
          void navigate({ params: { ref: version }, to: '/datasets/$ref' })
        }}
        result={create.data}
      />
    </>
  )
}

function IngestOutcome({
  error,
  isError,
  onResolved,
  result,
}: {
  error: unknown
  isError: boolean
  onResolved(version: string): void
  result: IngestResultV2 | undefined
}) {
  const { t } = useTranslation()
  const conflict = readRefConflictDetail(error)

  return (
    <>
      {isError && conflict === null ? <V2MutationError error={error} /> : null}
      {conflict ? <RefConflictRecovery error={error} onResolved={onResolved} /> : null}
      {result ? (
        <Surface>
          <SurfaceHeader>
            <SurfaceTitle>{t('v2.ingest.complete')}</SurfaceTitle>
          </SurfaceHeader>
          <SurfaceBody className="space-y-4">
            <KeyValueGrid>
              <KeyValueRow label={t('v2.datasets.version')}>
                <code className="break-all text-xs">{result.dataset_version}</code>
              </KeyValueRow>
              <KeyValueRow label={t('v2.detail.records')} value={result.manifest.num_records} />
            </KeyValueGrid>
            <Button asChild variant="outline">
              <Link params={{ ref: result.dataset_version }} to="/datasets/$ref">
                {t('v2.ingest.openDataset')}
              </Link>
            </Button>
          </SurfaceBody>
        </Surface>
      ) : null}
    </>
  )
}

export type CanonicalJsonArrayConversion =
  | { ok: true; jsonl: string }
  | { ok: false; message: string; reason: 'invalid_json' }
  | { ok: false; reason: 'not_array' }

export function canonicalJsonArrayToJsonl(text: string): CanonicalJsonArrayConversion {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      reason: 'invalid_json',
    }
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'not_array' }

  const elements = splitTopLevelJsonArray(text)
  if (elements.length !== parsed.length) {
    return { ok: false, message: 'Could not frame every array item.', reason: 'invalid_json' }
  }
  return { ok: true, jsonl: elements.length === 0 ? '' : `${elements.join('\n')}\n` }
}

function splitTopLevelJsonArray(text: string): string[] {
  const first = text.search(/\S/u)
  const last = text.search(/\s*$/u)
  if (first < 0 || text[first] !== '[' || last <= first || text[last - 1] !== ']') return []

  const elements: string[] = []
  let elementStart = first + 1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = first + 1; index < last - 1; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
    else if (character === ',' && depth === 0) {
      elements.push(text.slice(elementStart, index).trim())
      elementStart = index + 1
    }
  }
  const finalElement = text.slice(elementStart, last - 1).trim()
  if (finalElement !== '') elements.push(finalElement)
  return elements
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
