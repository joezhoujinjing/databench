import type { AgentTrace, AgentTraceEvent, ChatMessage, ToolCall } from '../api/schemas.js'

export type TraceStepGroup = {
  readonly assistant: ChatMessage | null
  readonly events: AgentTraceEvent[]
  readonly messages: ChatMessage[]
  readonly preAgentMessages: ChatMessage[]
  readonly step: number
  readonly totalLatencyMs: number | null
}

export type LinkedToolCall = {
  readonly call: ToolCall
  readonly latencyMs: number | null
  readonly result: ChatMessage | null
}

export function buildTraceStepGroups(
  messages: readonly ChatMessage[],
  trace: AgentTrace,
): TraceStepGroup[] {
  const messageById = new Map(
    messages.flatMap((message) =>
      message.id === undefined ? [] : [[message.id, message] as const],
    ),
  )
  const eventsByStep = new Map<number, AgentTraceEvent[]>()
  for (const event of trace.events) {
    const events = eventsByStep.get(event.step) ?? []
    events.push(event)
    eventsByStep.set(event.step, events)
  }

  const referenced = new Set(trace.events.flatMap((event) => event.message_id ?? []))
  const firstReferenced = messages.findIndex(
    (message) => message.id !== undefined && referenced.has(message.id),
  )
  const preAgentMessages = firstReferenced < 0 ? [...messages] : messages.slice(0, firstReferenced)
  const groups: TraceStepGroup[] = []
  if (preAgentMessages.length > 0) {
    groups.push({
      assistant: null,
      events: [],
      messages: [],
      preAgentMessages,
      step: -1,
      totalLatencyMs: null,
    })
  }

  for (const step of [...eventsByStep.keys()].sort((left, right) => left - right)) {
    const events = eventsByStep.get(step) ?? []
    const stepMessages: ChatMessage[] = []
    const seen = new Set<string>()
    let assistant: ChatMessage | null = null
    for (const event of events) {
      if (event.message_id === null || event.message_id === undefined) continue
      const message = messageById.get(event.message_id)
      if (message === undefined) continue
      if (message.role === 'assistant') assistant ??= message
      else if (!seen.has(event.message_id)) {
        seen.add(event.message_id)
        stepMessages.push(message)
      }
    }
    const latencies = events
      .map((event) => event.latency_ms)
      .filter((latency): latency is number => latency !== null && latency !== undefined)
    groups.push({
      assistant,
      events,
      messages: stepMessages,
      preAgentMessages: [],
      step,
      totalLatencyMs:
        latencies.length === 0 ? null : latencies.reduce((sum, latency) => sum + latency, 0),
    })
  }

  const groupByReferencedMessage = new Map<string, TraceStepGroup>()
  for (const group of groups) {
    for (const event of group.events) {
      if (event.message_id) groupByReferencedMessage.set(event.message_id, group)
    }
  }
  let activeGroup: TraceStepGroup | undefined
  const tracedMessages = firstReferenced < 0 ? [] : messages.slice(firstReferenced)
  for (const message of tracedMessages) {
    const referencedGroup = message.id ? groupByReferencedMessage.get(message.id) : undefined
    if (referencedGroup !== undefined) {
      activeGroup = referencedGroup
      continue
    }
    activeGroup?.messages.push(message)
  }
  return groups
}

export function linkToolCalls(
  calls: readonly ToolCall[],
  messages: readonly ChatMessage[],
  trace: AgentTrace | null | undefined,
): LinkedToolCall[] {
  const resultByCallId = new Map<string, ChatMessage>()
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) {
      resultByCallId.set(message.tool_call_id, message)
    }
  }
  const latencyByCallId = new Map<string, number>()
  for (const event of trace?.events ?? []) {
    const id = typeof event.payload.id === 'string' ? event.payload.id : null
    if (event.type === 'tool_result' && id !== null && event.latency_ms != null) {
      latencyByCallId.set(id, event.latency_ms)
    }
  }
  return calls.map((call) => ({
    call,
    latencyMs: latencyByCallId.get(call.id) ?? null,
    result: resultByCallId.get(call.id) ?? null,
  }))
}

export function traceStopReason(events: readonly AgentTraceEvent[]): string | null {
  const modelEvent = events.find((event) => event.type === 'model_generate')
  const stopReason = modelEvent?.payload.stop_reason
  if (typeof stopReason === 'string' && stopReason.trim() !== '') return stopReason
  const runEnd = events.findLast((event) => event.type === 'run_end')
  const reason = runEnd?.payload.stop_reason ?? runEnd?.payload.reason
  return typeof reason === 'string' && reason.trim() !== '' ? reason : null
}
