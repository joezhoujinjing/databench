import { hashObj, jsonNumberLexeme } from '@databench/hashing'
import {
  type Candidate,
  type JsonNumber,
  jsonNumberValue,
  type Message,
  type PreferenceSample,
  parseSample,
  type RLSample,
  type Rollout,
  type Sample,
  type SFTSample,
  type ToolCall,
  type TrajectorySample,
} from './sample.js'

export type SampleContent = Record<string, unknown>

export function toContent(value: Sample | unknown): SampleContent {
  const sample = parseSample(value)

  switch (sample.kind) {
    case 'sft':
      return sftContent(sample)
    case 'preference':
      return preferenceContent(sample)
    case 'rl':
      return rlContent(sample)
    case 'trajectory':
      return trajectoryContent(sample)
  }
}

export function sampleId(value: Sample | unknown): string {
  return hashObj(toContent(value))
}

function sftContent(sample: SFTSample): SampleContent {
  return {
    kind: sample.kind,
    messages: sample.messages.map(messageContent),
  }
}

function preferenceContent(sample: PreferenceSample): SampleContent {
  return {
    kind: sample.kind,
    prompt: sample.prompt.map(messageContent),
    chosen: messageOrMessagesContent(sample.chosen),
    rejected: messageOrMessagesContent(sample.rejected),
    candidates: sample.candidates === null ? null : sample.candidates.map(candidateContent),
  }
}

function rlContent(sample: RLSample): SampleContent {
  return {
    kind: sample.kind,
    prompt: sample.prompt.map(messageContent),
    answer: sample.answer,
    verifier: sample.verifier,
    rollouts: sample.rollouts.map(rolloutContent),
  }
}

function trajectoryContent(sample: TrajectorySample): SampleContent {
  return {
    kind: sample.kind,
    messages: sample.messages.map(messageContent),
  }
}

function messageOrMessagesContent(value: Message | readonly Message[]): unknown {
  return isMessageArray(value) ? value.map(messageContent) : messageContent(value)
}

function isMessageArray(value: Message | readonly Message[]): value is readonly Message[] {
  return Array.isArray(value)
}

function messageContent(message: Message): SampleContent {
  return {
    role: message.role,
    content: message.content,
    name: message.name,
    tool_calls: message.tool_calls === null ? null : message.tool_calls.map(toolCallContent),
    tool_call_id: message.tool_call_id,
  }
}

function toolCallContent(toolCall: ToolCall): SampleContent {
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
  }
}

function rolloutContent(rollout: Rollout): SampleContent {
  return {
    text: rollout.text,
    reward: floatContent(rollout.reward),
    meta: rollout.meta,
  }
}

function candidateContent(candidate: Candidate): SampleContent {
  return {
    completion: messageOrMessagesContent(candidate.completion),
    rank: candidate.rank,
    score: floatContent(candidate.score),
  }
}

function floatContent(value: JsonNumber | null): JsonNumber | null {
  if (value === null) {
    return null
  }

  const number = jsonNumberValue(value)
  return jsonNumberLexeme(Number.isInteger(number) ? `${number}.0` : String(number))
}
