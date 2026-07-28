import { describe, expect, it } from 'vitest'
import type { AgentTrace, ChatMessage } from '../api/schemas.js'
import { buildTraceStepGroups, linkToolCalls, traceStopReason } from './agent-trace.js'

const messages: ChatMessage[] = [
  { content: 'rules', id: 'sys', role: 'system' },
  {
    content: 'calling',
    id: 'assistant-1',
    role: 'assistant',
    tool_calls: [{ arguments: { q: 'hello' }, function: 'search', id: 'call-1' }],
  },
  {
    content: 'result',
    id: 'tool-1',
    role: 'tool',
    tool_call_id: 'call-1',
  },
  { content: 'unlinked observation', id: 'tool-orphan', role: 'tool' },
]

const trace: AgentTrace = {
  events: [
    {
      message_id: 'assistant-1',
      payload: { stop_reason: 'tool_use' },
      step: 0,
      timestamp: 1,
      type: 'model_generate',
    },
    {
      latency_ms: 25,
      message_id: 'tool-1',
      payload: { id: 'call-1' },
      step: 1,
      timestamp: 2,
      type: 'tool_result',
    },
  ],
  max_steps: 3,
}

describe('EvalScope agent trace domain', () => {
  it('preserves ordered steps and pre-agent messages', () => {
    const groups = buildTraceStepGroups(messages, trace)
    expect(groups.map((group) => group.step)).toEqual([-1, 0, 1])
    expect(groups[0]?.preAgentMessages[0]?.id).toBe('sys')
    expect(groups[1]?.assistant?.id).toBe('assistant-1')
    expect(groups[2]?.messages.map((message) => message.id)).toContain('tool-orphan')
  })

  it('links a tool result emitted on a later step', () => {
    const calls = messages[1]?.tool_calls ?? []
    expect(linkToolCalls(calls, messages, trace)).toMatchObject([
      { latencyMs: 25, result: { id: 'tool-1' } },
    ])
    expect(traceStopReason(trace.events)).toBe('tool_use')
  })
})
