import type { Kind } from '@databench/schema'

export type JsonRecord = Record<string, unknown>

export function detectKind(record: JsonRecord): Kind {
  if ('chosen' in record && 'rejected' in record) {
    return 'preference'
  }

  if ('rollouts' in record) {
    return 'rl'
  }

  if ('messages' in record) {
    const messages = Array.isArray(record.messages) ? record.messages : []
    const isTrajectory = messages.some(
      (message) =>
        isRecord(message) &&
        (Boolean(message.tool_calls) || message.role === 'tool' || Boolean(message.tool_call_id)),
    )

    return isTrajectory ? 'trajectory' : 'sft'
  }

  throw new Error(
    "could not detect sample kind; expected one of 'messages', 'chosen'/'rejected', or 'rollouts' in the record",
  )
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
