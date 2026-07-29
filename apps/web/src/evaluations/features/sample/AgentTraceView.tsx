import { AlertTriangle, Check, Clock, Cpu, Play, Sparkles, Square, Wrench } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentTrace, AgentTraceEvent, ChatMessage } from '../../api/schemas.js'
import {
  buildTraceStepGroups,
  linkToolCalls,
  type TraceStepGroup,
  traceStopReason,
} from '../../domain/agent-trace.js'
import { messageText } from '../../domain/reports.js'
import { RichContent } from '../content/RichContent.js'
import { VirtualList } from '../content/VirtualList.js'
import { MessageCard, MessageTimeline } from './MessageTimeline.js'

function eventDisplay(event: AgentTraceEvent) {
  if (event.type === 'model_generate') return { Icon: Sparkles, tone: 'text-emerald-300' }
  if (event.type === 'tool_call' || event.type === 'tool_result')
    return { Icon: Wrench, tone: 'text-amber-300' }
  if (event.type === 'env_exec') return { Icon: Cpu, tone: 'text-sky-300' }
  if (event.type === 'error' || event.type === 'nudge')
    return { Icon: AlertTriangle, tone: 'text-warning' }
  if (event.type === 'submit') return { Icon: Check, tone: 'text-success' }
  if (event.type === 'run_start') return { Icon: Play, tone: 'text-muted-foreground' }
  return { Icon: Square, tone: 'text-muted-foreground' }
}

function EventChip({ event }: { readonly event: AgentTraceEvent }) {
  const { Icon, tone } = eventDisplay(event)
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[4px] border border-current px-1.5 py-0.5 font-mono text-[0.62rem] ${tone}`}
    >
      <Icon aria-hidden="true" size={9} />
      {event.type}
    </span>
  )
}

function TraceStep({
  allMessages,
  group,
  highlightId,
  highlighted,
  onToggle,
  trace,
}: {
  readonly allMessages: readonly ChatMessage[]
  readonly group: TraceStepGroup
  readonly highlightId?: string | undefined
  readonly highlighted: boolean
  readonly onToggle: () => void
  readonly trace: AgentTrace
}) {
  const { t } = useTranslation()
  if (group.step === -1) {
    return <MessageTimeline highlightId={highlightId} messages={group.preAgentMessages} />
  }
  const stopReason = traceStopReason(group.events) ?? undefined
  const linked = linkToolCalls(group.assistant?.tool_calls ?? [], allMessages, trace)
  const linkedResultIds = new Set(linked.flatMap((item) => item.result?.id ?? []))
  const residual = group.messages.filter(
    (message) => !message.id || !linkedResultIds.has(message.id),
  )
  const envEvents = group.events.filter((event) => event.type === 'env_exec')
  const errorEvents = group.events.filter(
    (event) => event.type === 'error' || event.type === 'nudge',
  )
  return (
    <section
      className={`rounded-[6px] border-l-2 py-2 transition ${highlighted ? 'border-primary bg-primary/5 pl-3' : 'border-border'}`}
    >
      <button
        className="mb-3 flex min-h-10 w-full flex-wrap items-center gap-2 border-border border-b border-dashed px-2 text-left"
        onClick={onToggle}
        type="button"
      >
        <strong className="font-mono text-xs">
          {t('evaluations.trace.step')} {group.step}
        </strong>
        {group.totalLatencyMs != null ? (
          <span className="inline-flex items-center gap-1 font-mono text-muted-foreground text-xs">
            <Clock aria-hidden="true" size={10} />
            {group.totalLatencyMs.toFixed(0)} ms
          </span>
        ) : null}
        {group.events.map((event) => (
          <EventChip
            event={event}
            key={`${event.step}:${event.timestamp}:${event.type}:${event.message_id ?? ''}`}
          />
        ))}
      </button>
      <div className="space-y-3 px-2">
        {group.assistant ? (
          <MessageCard
            highlightId={highlightId}
            message={group.assistant}
            stopReason={stopReason}
          />
        ) : null}
        {linked.map(({ call, latencyMs, result }) => (
          <div
            className="rounded-[5px] border border-amber-400/20 bg-amber-400/5 p-3"
            key={call.id}
          >
            <div className="flex flex-wrap items-center gap-2 font-mono text-amber-300 text-xs">
              <Wrench aria-hidden="true" size={12} />
              <strong>{call.function}</strong>
              {latencyMs != null ? (
                <span className="text-muted-foreground">{latencyMs.toFixed(0)} ms</span>
              ) : null}
            </div>
            <pre className="mt-2 max-h-48 overflow-auto rounded bg-background/65 p-2 font-mono text-xs">
              {JSON.stringify(call.arguments, null, 2)}
            </pre>
            {result ? (
              <div className="mt-3 border-amber-400/15 border-t pt-3">
                <RichContent content={messageText(result)} />
                {result.error ? (
                  <p className="mt-2 text-danger text-xs">{result.error.message}</p>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-muted-foreground text-xs">
                {t('evaluations.single.toolResultMissing')}
              </p>
            )}
          </div>
        ))}
        {envEvents.map((event) => (
          <pre
            className="rounded-[5px] border border-sky-400/20 bg-sky-400/5 p-3 font-mono text-sky-200 text-xs"
            key={`env:${event.step}:${event.timestamp}:${event.message_id ?? ''}`}
          >
            $ {String(event.payload.command ?? JSON.stringify(event.payload))}
          </pre>
        ))}
        {errorEvents.map((event) => (
          <div
            className="rounded-[5px] border border-warning/30 bg-warning/5 p-3 text-warning text-xs"
            key={`error:${event.step}:${event.timestamp}:${event.message_id ?? ''}`}
          >
            <AlertTriangle aria-hidden="true" className="mr-2 inline" size={13} />
            {String(event.payload.message ?? event.payload.reason ?? JSON.stringify(event.payload))}
          </div>
        ))}
        {residual.map((message, index) => (
          <MessageCard
            highlightId={highlightId}
            key={message.id ?? `residual-${index}`}
            message={message}
          />
        ))}
        {stopReason ? (
          <p className="font-mono text-muted-foreground text-xs">stop: {stopReason}</p>
        ) : null}
      </div>
    </section>
  )
}

export function AgentTraceView({
  highlightId,
  messages,
  trace,
}: {
  readonly highlightId?: string | undefined
  readonly messages: readonly ChatMessage[]
  readonly trace: AgentTrace
}) {
  const [highlightedStep, setHighlightedStep] = useState<number | null>(null)
  const groups = buildTraceStepGroups(messages, trace)
  return (
    <div className="space-y-3">
      {trace.strategy || trace.environment ? (
        <div className="flex flex-wrap gap-2 font-mono text-muted-foreground text-xs">
          {trace.strategy ? <span>strategy: {trace.strategy}</span> : null}
          {trace.environment ? <span>environment: {trace.environment}</span> : null}
          <span>max steps: {trace.max_steps}</span>
        </div>
      ) : null}
      <VirtualList
        estimateSize={260}
        getKey={(group) => group.step}
        items={groups}
        renderItem={(group) => (
          <TraceStep
            allMessages={messages}
            group={group}
            highlightId={highlightId}
            highlighted={highlightedStep === group.step}
            onToggle={() => setHighlightedStep((step) => (step === group.step ? null : group.step))}
            trace={trace}
          />
        )}
      />
    </div>
  )
}
