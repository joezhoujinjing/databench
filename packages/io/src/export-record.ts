import {
  isJsonNumberLexeme,
  jsonNumberValue,
  type Message,
  parseSample,
  type Sample,
  type ToolCall,
} from '@databench/schema'

export function exportRecord(sampleLike: Sample | unknown, _format = 'messages-jsonl'): unknown {
  const sample = parseSample(sampleLike)

  switch (sample.kind) {
    case 'sft':
    case 'trajectory':
      return { messages: sample.messages.map(compactMessage) }
    case 'preference':
      return compactObject({
        prompt: sample.prompt.map(compactMessage),
        chosen: compactMessageOrMessages(sample.chosen),
        rejected: compactMessageOrMessages(sample.rejected),
      })
    case 'rl':
      return compactObject({
        prompt: sample.prompt.map(compactMessage),
        answer: sample.answer,
        verifier: sample.verifier,
        rollouts: sample.rollouts.map((rollout) =>
          compactObject({
            text: rollout.text,
            reward: rollout.reward,
            meta: rollout.meta,
          }),
        ),
      })
  }
}

function compactMessageOrMessages(value: Message | readonly Message[]): unknown {
  return isMessageArray(value) ? value.map(compactMessage) : compactMessage(value)
}

function compactMessage(message: Message): unknown {
  return compactObject({
    role: message.role,
    content: message.content,
    name: message.name,
    tool_calls: message.tool_calls?.map(compactToolCall) ?? null,
    tool_call_id: message.tool_call_id,
  })
}

function compactToolCall(toolCall: ToolCall): unknown {
  return compactObject({
    id: toolCall.id,
    name: toolCall.name,
    arguments: compactValue(toolCall.arguments),
  })
}

function compactValue(value: unknown): unknown {
  if (value == null) {
    return value
  }

  if (isJsonNumberLexeme(value)) {
    return jsonNumberValue(value)
  }

  if (Array.isArray(value)) {
    return value.map(compactValue)
  }

  if (isPlainRecord(value)) {
    return compactObject(value)
  }

  return value
}

function compactObject(record: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(record)) {
    if (value == null) {
      continue
    }

    compacted[key] = compactValue(value)
  }

  return compacted
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMessageArray(value: Message | readonly Message[]): value is readonly Message[] {
  return Array.isArray(value)
}
