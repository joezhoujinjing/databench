import type { Message, Sample } from '@databench/schema'

export function messageText(messages: readonly Message[]): string {
  return messages
    .filter((message) => Boolean(message.content))
    .map((message) => message.content)
    .join(' ')
}

export function sampleText(sample: Sample): string {
  switch (sample.kind) {
    case 'sft':
    case 'trajectory':
      return messageText(sample.messages)
    case 'preference': {
      const chosen = Array.isArray(sample.chosen) ? sample.chosen : [sample.chosen]
      return messageText([...sample.prompt, ...chosen])
    }
    case 'rl':
      return messageText(sample.prompt)
  }
}

export function pythonWordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0
}
