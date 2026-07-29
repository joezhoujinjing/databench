import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Shield,
  User,
  Wrench,
  Zap,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentTrace, ChatMessage, ToolCall } from '../../api/schemas.js'
import { linkToolCalls } from '../../domain/agent-trace.js'
import { messageText } from '../../domain/reports.js'
import { ContentBlocks, RichContent } from '../content/RichContent.js'
import { VirtualList } from '../content/VirtualList.js'

function CopyAction({ label, text }: { readonly label: string; readonly text: string }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'copied' | 'failed' | 'idle'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
    window.setTimeout(() => setStatus('idle'), 1_500)
  }
  const statusLabel =
    status === 'copied'
      ? t('evaluations.prediction.copied')
      : status === 'failed'
        ? t('evaluations.prediction.copyFailed')
        : label
  return (
    <button
      aria-label={statusLabel}
      className="inline-flex min-h-8 items-center gap-1 rounded-[4px] border border-border px-2 font-mono text-[0.65rem] text-muted-foreground hover:text-foreground"
      onClick={() => void copy()}
      type="button"
    >
      {status === 'copied' ? (
        <Check aria-hidden="true" size={11} />
      ) : (
        <Copy aria-hidden="true" size={11} />
      )}
      <span aria-live="polite">{statusLabel}</span>
    </button>
  )
}

function PerfChips({
  message,
  stopReason,
}: {
  readonly message: ChatMessage
  readonly stopReason?: string | undefined
}) {
  const perf = message.perf_metrics
  if (perf == null && stopReason === undefined) return null
  return (
    <span className="flex flex-wrap items-center gap-2 font-mono text-[0.65rem] text-muted-foreground">
      {perf ? (
        <>
          <span className="inline-flex items-center gap-1">
            <Clock aria-hidden="true" size={10} />
            {(perf.latency * 1_000).toFixed(0)} ms
          </span>
          {perf.ttft != null ? (
            <span className="inline-flex items-center gap-1">
              <Zap aria-hidden="true" size={10} />
              TTFT {(perf.ttft * 1_000).toFixed(0)} ms
            </span>
          ) : null}
          <span>in {perf.input_tokens}</span>
          <span>out {perf.output_tokens}</span>
        </>
      ) : null}
      {stopReason ? <span>stop: {stopReason}</span> : null}
    </span>
  )
}

const ROLE_CONFIG = {
  assistant: {
    Icon: Bot,
    label: 'Assistant',
    style: 'border-emerald-400/20 bg-emerald-400/5',
    tone: 'text-emerald-300',
  },
  system: {
    Icon: Shield,
    label: 'System',
    style: 'border-border bg-background/45',
    tone: 'text-muted-foreground',
  },
  tool: {
    Icon: Wrench,
    label: 'Tool',
    style: 'border-amber-400/25 bg-amber-400/5',
    tone: 'text-amber-300',
  },
  user: {
    Icon: User,
    label: 'User',
    style: 'border-primary/25 bg-primary/5',
    tone: 'text-primary',
  },
} as const

export function MessageCard({
  children,
  highlightId,
  message,
  stopReason,
}: {
  readonly children?: ReactNode
  readonly highlightId?: string | undefined
  readonly message: ChatMessage
  readonly stopReason?: string | undefined
}) {
  const { t } = useTranslation()
  const config = ROLE_CONFIG[message.role]
  const highlighted = Boolean(message.id && highlightId && message.id.startsWith(highlightId))
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [highlighted])
  return (
    <article
      aria-current={highlighted ? 'true' : undefined}
      className={`rounded-[6px] border px-4 py-3 ${config.style} ${highlighted ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}
      ref={ref}
    >
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <config.Icon aria-hidden="true" className={config.tone} size={14} />
        <strong className={`text-xs ${config.tone}`}>{config.label}</strong>
        {message.function ? (
          <span className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-[0.65rem]">
            {message.function}
          </span>
        ) : null}
        {message.model ? (
          <span className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground">
            {message.model}
          </span>
        ) : null}
        <PerfChips message={message} stopReason={stopReason} />
        <span className="flex-1" />
        {message.id ? (
          <CopyAction label={t('evaluations.prediction.copyMsgId')} text={message.id} />
        ) : null}
        <CopyAction label={t('evaluations.prediction.copyContent')} text={messageText(message)} />
      </header>
      {message.error ? (
        <div
          className="mb-3 rounded-[4px] border border-danger/35 bg-danger/8 px-3 py-2 font-mono text-danger text-xs"
          role="alert"
        >
          {message.error.type ? `[${message.error.type}] ` : ''}
          {message.error.message}
        </div>
      ) : null}
      {Array.isArray(message.content) ? (
        <ContentBlocks blocks={message.content} includeReasoning={message.role === 'assistant'} />
      ) : (
        <RichContent content={message.content} />
      )}
      {children}
    </article>
  )
}

function ToolCallGroup({
  calls,
  messages,
  trace,
}: {
  readonly calls: readonly ToolCall[]
  readonly messages: readonly ChatMessage[]
  readonly trace?: AgentTrace | null | undefined
}) {
  const { t } = useTranslation()
  const linked = linkToolCalls(calls, messages, trace)
  if (linked.length === 0) return null
  return (
    <div className="mt-3 space-y-2 border-border border-t pt-3">
      <p className="font-medium text-muted-foreground text-xs">
        {t('evaluations.trace.toolCallsCount', { n: linked.length })}
      </p>
      {linked.map(({ call, latencyMs, result }) => (
        <details
          className="rounded-[5px] border border-amber-400/20 bg-background/35"
          key={call.id}
          open
        >
          <summary className="flex min-h-10 cursor-pointer items-center gap-2 px-3 font-mono text-amber-300 text-xs">
            <Wrench aria-hidden="true" size={12} />
            <strong>{call.function}</strong>
            <span className="truncate text-muted-foreground">{JSON.stringify(call.arguments)}</span>
            {latencyMs != null ? (
              <span className="ml-auto text-muted-foreground">{latencyMs.toFixed(0)} ms</span>
            ) : null}
          </summary>
          <div className="space-y-3 border-amber-400/15 border-t p-3">
            <pre className="max-h-52 overflow-auto rounded-[4px] bg-background/70 p-3 font-mono text-xs">
              {JSON.stringify(call.arguments, null, 2)}
            </pre>
            {result ? (
              <div>
                <p className="mb-2 font-medium text-muted-foreground text-xs">
                  {t('evaluations.prediction.toolResult')}
                </p>
                <RichContent content={messageText(result)} />
                {result.error ? (
                  <p className="mt-2 text-danger text-xs">{result.error.message}</p>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                {t('evaluations.single.toolResultMissing')}
              </p>
            )}
          </div>
        </details>
      ))}
    </div>
  )
}

function SystemMessage({
  highlightId,
  message,
}: {
  readonly highlightId?: string | undefined
  readonly message: ChatMessage
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const preview = messageText(message).replace(/\s+/gu, ' ').slice(0, 140)
  return (
    <div className="rounded-[5px] border border-border bg-background/40">
      <button
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-muted-foreground text-xs"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDown aria-hidden="true" size={13} />
        ) : (
          <ChevronRight aria-hidden="true" size={13} />
        )}
        <Shield aria-hidden="true" size={13} />
        <strong>{t('evaluations.prediction.systemPrompt')}</strong>
        {!open ? <span className="truncate font-mono opacity-65">{preview}</span> : null}
      </button>
      {open ? (
        <div className="border-border border-t p-3">
          <MessageCard highlightId={highlightId} message={message} />
        </div>
      ) : null}
    </div>
  )
}

export function MessageTimeline({
  highlightId,
  messages,
  trace,
}: {
  readonly highlightId?: string | undefined
  readonly messages: readonly ChatMessage[]
  readonly trace?: AgentTrace | null | undefined
}) {
  const calledIds = new Set(
    messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []),
  )
  const toolResultIds = new Set(
    messages
      .filter(
        (message) =>
          message.role === 'tool' &&
          message.tool_call_id !== null &&
          message.tool_call_id !== undefined &&
          calledIds.has(message.tool_call_id),
      )
      .map((message) => message.id)
      .filter((id): id is string => id !== undefined),
  )
  const visible = messages.filter((message) => !message.id || !toolResultIds.has(message.id))
  return (
    <VirtualList
      estimateSize={190}
      getKey={(message, index) => message.id ?? `${message.role}-${index}`}
      items={visible}
      renderItem={(message) =>
        message.role === 'system' ? (
          <SystemMessage highlightId={highlightId} message={message} />
        ) : (
          <MessageCard highlightId={highlightId} message={message}>
            {message.role === 'assistant' && message.tool_calls?.length ? (
              <ToolCallGroup calls={message.tool_calls} messages={messages} trace={trace} />
            ) : null}
          </MessageCard>
        )
      }
    />
  )
}
