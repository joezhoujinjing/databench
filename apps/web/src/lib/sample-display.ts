import type { Sample } from '@/api/types.js'

export interface DisplayMessage {
  content: string
  key: string
  role: string
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function sampleKind(sample: Sample): string {
  const record = asRecord(sample)
  return typeof record.kind === 'string' ? record.kind : 'unknown'
}

export function sampleId(sample: Sample): string | null {
  const record = asRecord(sample)
  return record.id == null ? null : String(record.id)
}

export function sampleSource(sample: Sample): string | null {
  const record = asRecord(sample)
  return typeof record.source === 'string' && record.source.trim() !== '' ? record.source : null
}

export function sampleMessages(value: unknown): DisplayMessage[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((message, index) => {
    const record = asRecord(message)
    const role = typeof record.role === 'string' ? record.role : 'msg'
    const content = formatValue(record.content)
    const explicit = record.id ?? record.tool_call_id

    return {
      content,
      key: explicit == null ? `${index}:${role}:${content}` : String(explicit),
      role,
    }
  })
}

export function formatValue(value: unknown): string {
  if (value == null) {
    return ''
  }

  if (Array.isArray(value)) {
    const messages = sampleMessages(value)
    if (messages.length > 0) {
      return messages.map((message) => message.content).join('\n')
    }
  }

  const record = asRecord(value)
  if (typeof record.content === 'string') {
    return record.content
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return JSON.stringify(value)
}

export function sampleTokenEstimate(sample: Sample): number {
  const record = asRecord(sample)
  const values = [record.messages, record.prompt, record.chosen, record.rejected, record.reward]
  const text = values.map(formatValue).join(' ')
  return Math.max(1, Math.round(text.length / 4))
}

export function sampleCharEstimate(sample: Sample): number {
  const record = asRecord(sample)
  const values = [record.messages, record.prompt, record.chosen, record.rejected, record.reward]
  return values.map(formatValue).join('').length
}
