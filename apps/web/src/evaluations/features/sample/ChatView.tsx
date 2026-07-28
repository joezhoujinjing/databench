import {
  Braces,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Gauge,
  Scissors,
  Target,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatMessage, PredictionRow } from '../../api/schemas.js'
import { formatMetricValue } from '../../domain/metric.js'
import { RichContent } from '../content/RichContent.js'
import { AgentTraceView } from './AgentTraceView.js'
import { MessageCard, MessageTimeline } from './MessageTimeline.js'

const KNOWN_PREDICTION_FIELDS = new Set([
  'AgentTrace',
  'Generated',
  'Gold',
  'Index',
  'Input',
  'Messages',
  'Metadata',
  'NScore',
  'PerfMetrics',
  'Pred',
  'Score',
])

function hasSystemPrompt(input: string): boolean {
  const value = input.trim().toLowerCase()
  return (
    value.startsWith('<|system|>') || value.startsWith('[system]') || value.startsWith('system:')
  )
}

function legacyMessages(prediction: PredictionRow): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (hasSystemPrompt(prediction.Input)) {
    const system = /<\|system\|>([\s\S]*?)(?:<\|user\|>|$)/iu.exec(prediction.Input)?.[1]?.trim()
    const user = /<\|user\|>([\s\S]*?)(?:<\|assistant\|>|$)/iu.exec(prediction.Input)?.[1]?.trim()
    if (system) messages.push({ content: system, role: 'system' })
    if (user) messages.push({ content: user, role: 'user' })
  }
  if (messages.length === 0) messages.push({ content: prediction.Input, role: 'user' })
  if (prediction.Generated !== '') {
    messages.push({
      content: prediction.Generated,
      perf_metrics: prediction.PerfMetrics,
      role: 'assistant',
    })
  }
  return messages
}

function CollapsibleJson({ label, value }: { readonly label: string; readonly value: unknown }) {
  const [open, setOpen] = useState(false)
  if (value == null || (typeof value === 'object' && Object.keys(value).length === 0)) return null
  return (
    <div>
      <button
        aria-expanded={open}
        className="flex min-h-9 items-center gap-2 text-muted-foreground text-xs hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDown aria-hidden="true" size={12} />
        ) : (
          <ChevronRight aria-hidden="true" size={12} />
        )}
        <Braces aria-hidden="true" size={12} />
        {label}
      </button>
      {open ? (
        <pre className="max-h-72 overflow-auto rounded-[5px] border border-border bg-background/65 p-3 font-mono text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

function EvaluationResult({
  prediction,
  threshold,
}: {
  readonly prediction: PredictionRow
  readonly threshold: number
}) {
  const { t } = useTranslation()
  const showPred =
    prediction.Pred !== '' &&
    prediction.Pred !== '*Same as Generated*' &&
    prediction.Pred.trim() !== prediction.Generated.trim()
  const rawScore = formatMetricValue('score', prediction.NScore)
  const additionalFields = Object.fromEntries(
    Object.entries(prediction).filter(([key]) => !KNOWN_PREDICTION_FIELDS.has(key)),
  )
  return (
    <section className="overflow-hidden rounded-[6px] border border-border bg-surface/70">
      <header className="flex items-center gap-2 border-border border-b bg-surface-soft px-4 py-3">
        <ClipboardCheck aria-hidden="true" className="text-muted-foreground" size={15} />
        <strong className="text-xs uppercase tracking-[0.1em]">
          {t('evaluations.prediction.evalResult')}
        </strong>
      </header>
      <div
        className={`grid ${showPred ? 'lg:grid-cols-[1fr_1fr_12rem]' : 'lg:grid-cols-[1fr_12rem]'}`}
      >
        {showPred ? (
          <div className="border-border border-b p-4 lg:border-r lg:border-b-0">
            <p className="mb-2 flex items-center gap-2 font-medium text-muted-foreground text-xs">
              <Scissors aria-hidden="true" size={13} />
              {t('evaluations.prediction.extractedAnswer')}
            </p>
            <RichContent content={prediction.Pred} />
          </div>
        ) : null}
        <div className="border-border border-b p-4 lg:border-r lg:border-b-0">
          <p className="mb-2 flex items-center gap-2 font-medium text-muted-foreground text-xs">
            <Target aria-hidden="true" size={13} />
            {t('evaluations.prediction.expectedAnswer')}
          </p>
          <RichContent content={prediction.Gold} />
        </div>
        <div className="p-4">
          <p className="mb-2 flex items-center gap-2 font-medium text-muted-foreground text-xs">
            <Gauge aria-hidden="true" size={13} />
            {t('evaluations.prediction.score')}
          </p>
          <strong className="font-mono text-xl">{rawScore.primary}</strong>
          <p className="mt-1 font-mono text-muted-foreground text-xs">raw {rawScore.raw}</p>
          <p className="mt-2 text-muted-foreground text-xs">
            {prediction.NScore >= threshold
              ? t('evaluations.prediction.aboveFilter')
              : t('evaluations.prediction.belowFilter')}{' '}
            · {threshold}
          </p>
        </div>
      </div>
      <div className="space-y-1 border-border border-t px-4 py-3">
        <CollapsibleJson label={t('evaluations.prediction.scoreJson')} value={prediction.Score} />
        <CollapsibleJson label={t('evaluations.prediction.metadata')} value={prediction.Metadata} />
        <CollapsibleJson
          label={t('evaluations.prediction.additionalFields')}
          value={additionalFields}
        />
      </div>
    </section>
  )
}

export function ChatView({
  highlightMessageId,
  prediction,
  threshold,
}: {
  readonly highlightMessageId?: string | undefined
  readonly prediction: PredictionRow
  readonly threshold: number
}) {
  const messages = prediction.Messages?.length ? prediction.Messages : legacyMessages(prediction)
  return (
    <div className="space-y-5 py-2">
      {prediction.AgentTrace?.events.length && prediction.Messages?.length ? (
        <AgentTraceView
          highlightId={highlightMessageId}
          messages={prediction.Messages}
          trace={prediction.AgentTrace}
        />
      ) : prediction.Messages?.length ? (
        <MessageTimeline highlightId={highlightMessageId} messages={messages} />
      ) : (
        <div className="space-y-3">
          {messages.map((message) => (
            <MessageCard
              key={
                message.id ??
                `${message.role}:${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`
              }
              message={message}
            />
          ))}
        </div>
      )}
      <EvaluationResult prediction={prediction} threshold={threshold} />
    </div>
  )
}
