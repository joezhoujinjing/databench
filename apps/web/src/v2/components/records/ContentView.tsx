import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import type { RecordContentV2, RecordPartV2 } from '@/v2/api/types.js'
import { JsonValueView } from './JsonValueView.js'
import { SafeText } from './SafeText.js'

const CONTENT_BATCH_SIZE = 20
const PART_BATCH_SIZE = 40
const orderedObjectKeys = new WeakMap<object, number>()
let nextOrderedObjectKey = 0

export function RecordContents({ contents }: { contents: readonly RecordContentV2[] }) {
  const { t } = useTranslation()
  const [visibleCount, setVisibleCount] = useState(CONTENT_BATCH_SIZE)

  if (contents.length === 0) {
    return <p className="text-dim-foreground text-sm">{t('v2.record.noContents')}</p>
  }

  return (
    <ol className="space-y-3">
      {contents.slice(0, visibleCount).map((content) => (
        <li
          className={
            content.role === 'system'
              ? 'rounded-[5px] border border-warning/45 bg-warning/5 px-4 py-4'
              : 'rounded-[5px] border border-border bg-background/45 px-4 py-4'
          }
          key={`content:${orderedObjectKey(content)}`}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge
              tone={
                content.role === 'system' ? 'orange' : content.role === 'ai' ? 'violet' : 'blue'
              }
            >
              {content.role}
            </Badge>
            {content.role === 'system' ? (
              <span className="font-medium text-sm">{t('v2.record.systemInstruction')}</span>
            ) : null}
            <span className="text-dim-foreground text-xs">
              {t('v2.record.lossWeight')}:{' '}
              {content.role === 'system'
                ? 0
                : content.loss_weight === null
                  ? t('v2.record.none')
                  : content.loss_weight}
            </span>
          </div>
          {content.role === 'system' ? (
            <SystemMessage content={content} />
          ) : (
            <RecordParts parts={content.parts} />
          )}
        </li>
      ))}
      {visibleCount < contents.length ? (
        <li>
          <Button
            onClick={() => setVisibleCount((count) => count + CONTENT_BATCH_SIZE)}
            type="button"
            variant="outline"
          >
            {t('v2.record.showMore', { count: contents.length - visibleCount })}
          </Button>
        </li>
      ) : null}
    </ol>
  )
}

function SystemMessage({ content }: { content: RecordContentV2 }) {
  const part = content.parts[0]

  if (part?.type !== 'text') {
    return <RecordParts parts={content.parts} />
  }

  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-6">
      <SafeText downloadName="system-message.txt" text={part.text} />
    </p>
  )
}

function RecordParts({ parts }: { parts: readonly RecordPartV2[] }) {
  const { t } = useTranslation()
  const [visibleCount, setVisibleCount] = useState(PART_BATCH_SIZE)

  return (
    <ol className="space-y-3">
      {parts.slice(0, visibleCount).map((part) => (
        <li key={`part:${orderedObjectKey(part)}`}>
          <RecordPart part={part} />
        </li>
      ))}
      {visibleCount < parts.length ? (
        <li>
          <Button
            onClick={() => setVisibleCount((count) => count + PART_BATCH_SIZE)}
            size="sm"
            type="button"
            variant="outline"
          >
            {t('v2.record.showMore', { count: parts.length - visibleCount })}
          </Button>
        </li>
      ) : null}
    </ol>
  )
}

export function RecordPart({ part }: { part: RecordPartV2 }) {
  const { t } = useTranslation()

  return (
    <article className="rounded-[4px] border border-border/75 bg-surface-soft/35 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone="muted">{part.type}</Badge>
        <span className="text-dim-foreground text-xs">
          {t('v2.record.thought')}: {String(part.thought)}
        </span>
      </div>

      {part.type === 'text' ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-6">
          <SafeText downloadName="record-part.txt" text={part.text} />
        </p>
      ) : null}
      {part.type === 'function_call' ? (
        <div className="space-y-2 text-sm">
          <Field label={t('v2.record.callId')} value={part.function_call.id} />
          <Field label={t('v2.record.functionName')} value={part.function_call.name} />
          <JsonValueView label={t('v2.record.arguments')} value={part.function_call.args} />
        </div>
      ) : null}
      {part.type === 'function_response' ? (
        <div className="space-y-2 text-sm">
          <Field label={t('v2.record.callId')} value={part.function_response.call_id} />
          <JsonValueView label={t('v2.record.response')} value={part.function_response.response} />
        </div>
      ) : null}
      {part.type === 'file_data' ? (
        <div className="space-y-2 text-sm">
          <Field label={t('v2.record.uri')} value={part.file_data.uri} />
          <Field label={t('v2.record.mediaType')} value={part.file_data.media_type} />
          <Field
            label={t('v2.record.digest')}
            value={`${part.file_data.digest.algorithm}:${part.file_data.digest.value}`}
          />
          <Field label={t('v2.record.sizeBytes')} value={String(part.file_data.size_bytes)} />
        </div>
      ) : null}

      <div className="mt-3 space-y-2 border-border border-t pt-3 text-sm">
        <Field
          label={t('v2.record.thoughtSignature')}
          value={part.thought_signature ?? t('v2.record.none')}
        />
        <JsonValueView label={t('v2.record.partMetadata')} value={part.part_metadata} />
      </div>
    </article>
  )
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[9rem_1fr]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{value}</span>
    </div>
  )
}

function orderedObjectKey(value: object): number {
  const existing = orderedObjectKeys.get(value)
  if (existing !== undefined) return existing
  nextOrderedObjectKey += 1
  orderedObjectKeys.set(value, nextOrderedObjectKey)
  return nextOrderedObjectKey
}
