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
  PageShell,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { Tabs } from '@/components/ui/tabs.js'
import { formatBytes } from '@/lib/format.js'
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
  const upload = useV2Ingest()
  const create = useV2Ingest()
  const [mode, setMode] = useState<'upload' | 'paste'>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [uploadRef, setUploadRef] = useState('')
  const [uploadExpectedVersion, setUploadExpectedVersion] = useState('')
  const [uploadMessage, setUploadMessage] = useState('')
  const [uploadFormError, setUploadFormError] = useState<string | null>(null)
  const [pasteRef, setPasteRef] = useState('')
  const [pasteMessage, setPasteMessage] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [pasteFormError, setPasteFormError] = useState<string | null>(null)
  const uploadControllerRef = useRef<AbortController | null>(null)
  const pasteControllerRef = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      uploadControllerRef.current?.abort()
      pasteControllerRef.current?.abort()
    },
    [],
  )

  function submitUpload(event: FormEvent) {
    event.preventDefault()
    if (file === null) {
      setUploadFormError(t('v2.ingest.fileRequired'))
      return
    }
    if (uploadExpectedVersion.trim() !== '' && uploadRef.trim() === '') {
      setUploadFormError(t('v2.ingest.expectedNeedsRef'))
      return
    }
    if (uploadMessage.trim() !== '' && uploadRef.trim() === '') {
      setUploadFormError(t('v2.ingest.messageNeedsRef'))
      return
    }
    setUploadFormError(null)
    uploadControllerRef.current?.abort()
    const controller = new AbortController()
    uploadControllerRef.current = controller
    upload.mutate(
      {
        expectedRefVersion: blankToNull(uploadExpectedVersion),
        file,
        message: blankToNull(uploadMessage),
        ref: blankToNull(uploadRef),
        signal: controller.signal,
      },
      {
        onSettled: () => {
          if (uploadControllerRef.current === controller) uploadControllerRef.current = null
          if (controller.signal.aborted) upload.reset()
        },
      },
    )
  }

  function submitPaste(event: FormEvent) {
    event.preventDefault()
    if (pasteMessage.trim() !== '' && pasteRef.trim() === '') {
      setPasteFormError(t('v2.ingest.messageNeedsRef'))
      return
    }
    const converted = canonicalJsonArrayToJsonl(pasteText)
    if (!converted.ok) {
      setPasteFormError(
        converted.reason === 'not_array'
          ? t('v2.ingest.jsonArrayRequired')
          : t('v2.ingest.jsonInvalid', { message: converted.message }),
      )
      return
    }

    setPasteFormError(null)
    pasteControllerRef.current?.abort()
    const controller = new AbortController()
    pasteControllerRef.current = controller
    create.mutate(
      {
        expectedRefVersion: null,
        file: new File([converted.jsonl], 'pasted-records.jsonl', {
          type: 'application/x-ndjson',
        }),
        message: blankToNull(pasteMessage),
        ref: blankToNull(pasteRef),
        signal: controller.signal,
      },
      {
        onSettled: () => {
          if (pasteControllerRef.current === controller) pasteControllerRef.current = null
          if (controller.signal.aborted) create.reset()
        },
      },
    )
  }

  const openDataset = (version: string) => {
    void navigate({ params: { ref: version }, to: '/datasets/$ref' })
  }

  return (
    <PageShell className="space-y-4">
      <header className="pb-1">
        <h1 className="font-semibold text-[1.75rem] leading-tight tracking-tight">
          {t('v2.ingest.title')}
        </h1>
      </header>
      <Surface className="shadow-[0_18px_48px_rgba(75,56,30,0.08)]">
        <SurfaceBody className="py-5">
          <Tabs
            ariaLabel={t('v2.ingest.title')}
            items={[
              {
                label: t('v2.ingest.upload'),
                panel: (
                  <form
                    className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(22rem,0.75fr)]"
                    onSubmit={submitUpload}
                  >
                    <section className="min-w-0 space-y-3">
                      <div>
                        <h2 className="font-medium text-sm">{t('v2.ingest.content')}</h2>
                        <p className="mt-1 text-dim-foreground text-xs leading-5">
                          {t('v2.ingest.fileHint')}
                        </p>
                      </div>
                      <label className="flex min-h-[15.5rem] cursor-pointer flex-col items-center justify-center rounded-[6px] border border-dashed border-border-strong bg-background/55 px-6 py-7 text-center transition hover:border-primary hover:bg-background/75 focus-within:border-primary focus-within:bg-background/75">
                        <span className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                          <Upload aria-hidden="true" size={22} />
                        </span>
                        <span className="mt-4 font-medium text-sm">
                          {file?.name ?? t('v2.ingest.chooseFile')}
                        </span>
                        <span className="mt-1.5 text-dim-foreground text-xs">
                          {file === null ? t('v2.ingest.fileHint') : formatBytes(file.size)}
                        </span>
                        <input
                          accept=".jsonl,application/x-ndjson"
                          className="sr-only"
                          onChange={(event) => {
                            setFile(event.currentTarget.files?.[0] ?? null)
                            setUploadFormError(null)
                          }}
                          type="file"
                        />
                      </label>
                    </section>
                    <section className="flex min-w-0 flex-col border-border xl:border-l xl:pl-5">
                      <DatasetInformationFields
                        expectedVersion={uploadExpectedVersion}
                        message={uploadMessage}
                        onExpectedVersionChange={setUploadExpectedVersion}
                        onMessageChange={setUploadMessage}
                        onRefChange={setUploadRef}
                        refValue={uploadRef}
                      />
                      {uploadFormError ? (
                        <div className="mt-4">
                          <FormError>{uploadFormError}</FormError>
                        </div>
                      ) : null}
                      <div className="mt-auto flex flex-wrap justify-end gap-2 pt-5">
                        {upload.isPending ? (
                          <Button
                            onClick={() => uploadControllerRef.current?.abort()}
                            type="button"
                            variant="outline"
                          >
                            {t('v2.ingest.cancel')}
                          </Button>
                        ) : null}
                        <Button disabled={file === null || upload.isPending} type="submit">
                          {upload.isPending ? t('v2.ingest.uploading') : t('v2.ingest.action')}
                        </Button>
                      </div>
                    </section>
                  </form>
                ),
                value: 'upload' as const,
              },
              {
                label: t('v2.ingest.createTitle'),
                panel: (
                  <form
                    className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(22rem,0.75fr)]"
                    onSubmit={submitPaste}
                  >
                    <section className="min-w-0 space-y-3">
                      <div>
                        <h2 className="font-medium text-sm">{t('v2.ingest.content')}</h2>
                        <p className="mt-1 text-dim-foreground text-xs leading-5">
                          {t('v2.ingest.createDescription')}
                        </p>
                      </div>
                      <CodeEditor
                        aria-label={t('v2.ingest.recordsJson')}
                        language="JSON"
                        maxRows={18}
                        minRows={12}
                        onChange={(event) => {
                          setPasteText(event.currentTarget.value)
                          setPasteFormError(null)
                        }}
                        placeholder={RECORDS_PLACEHOLDER}
                        value={pasteText}
                      />
                    </section>
                    <section className="flex min-w-0 flex-col border-border xl:border-l xl:pl-5">
                      <DatasetInformationFields
                        message={pasteMessage}
                        onMessageChange={setPasteMessage}
                        onRefChange={setPasteRef}
                        refValue={pasteRef}
                      />
                      {pasteFormError ? (
                        <div className="mt-4">
                          <FormError>{pasteFormError}</FormError>
                        </div>
                      ) : null}
                      <div className="mt-auto flex flex-wrap justify-end gap-2 pt-5">
                        {create.isPending ? (
                          <Button
                            onClick={() => pasteControllerRef.current?.abort()}
                            type="button"
                            variant="outline"
                          >
                            {t('v2.ingest.cancelCreate')}
                          </Button>
                        ) : null}
                        <Button
                          disabled={pasteText.trim() === '' || create.isPending}
                          type="submit"
                        >
                          {create.isPending ? t('v2.ingest.creating') : t('v2.ingest.createAction')}
                        </Button>
                      </div>
                    </section>
                  </form>
                ),
                value: 'paste' as const,
              },
            ]}
            onChange={setMode}
            value={mode}
          />
        </SurfaceBody>
      </Surface>
      {mode === 'upload' ? (
        <IngestOutcome
          error={upload.error}
          isError={upload.isError}
          onResolved={openDataset}
          result={upload.data}
        />
      ) : (
        <IngestOutcome
          error={create.error}
          isError={create.isError}
          onResolved={openDataset}
          result={create.data}
        />
      )}
    </PageShell>
  )
}

function DatasetInformationFields({
  expectedVersion,
  message,
  onExpectedVersionChange,
  onMessageChange,
  onRefChange,
  refValue,
}: {
  expectedVersion?: string
  message: string
  onExpectedVersionChange?(value: string): void
  onMessageChange(value: string): void
  onRefChange(value: string): void
  refValue: string
}) {
  const { t } = useTranslation()
  const hasRef = refValue.trim() !== ''
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-medium text-sm">{t('v2.ingest.details')}</h2>
        <p className="mt-1 text-dim-foreground text-xs leading-5">{t('v2.ingest.refHint')}</p>
      </div>
      <Field label={t('v2.ingest.ref')}>
        <TextInput
          aria-label={t('v2.ingest.ref')}
          onChange={(event) => onRefChange(event.currentTarget.value)}
          value={refValue}
        />
      </Field>
      {expectedVersion !== undefined && onExpectedVersionChange !== undefined ? (
        <Field hint={t('v2.ingest.expectedHint')} label={t('v2.ingest.expected')}>
          <TextInput
            aria-label={t('v2.ingest.expected')}
            disabled={!hasRef}
            onChange={(event) => onExpectedVersionChange(event.currentTarget.value)}
            value={expectedVersion}
          />
        </Field>
      ) : null}
      <Field label={t('v2.ingest.message')}>
        <TextInput
          aria-label={t('v2.ingest.message')}
          disabled={!hasRef}
          onChange={(event) => onMessageChange(event.currentTarget.value)}
          value={message}
        />
      </Field>
    </div>
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
