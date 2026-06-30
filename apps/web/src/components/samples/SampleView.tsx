import { Circle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Sample } from '@/api/types.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { KindBadge } from '@/components/ui/badge.js'
import { ellipsizeMiddle } from '@/lib/format.js'
import {
  asRecord,
  formatValue,
  sampleCharEstimate,
  sampleId,
  sampleKind,
  sampleMessages,
  sampleSource,
  sampleTokenEstimate,
} from '@/lib/sample-display.js'

export function SampleView({ index, sample }: { index?: number; sample: Sample }) {
  const { t } = useTranslation()
  const record = asRecord(sample)
  const kind = sampleKind(sample)
  const id = sampleId(sample)
  const source = sampleSource(sample)

  return (
    <article className="border-border border-b px-5 py-5 last:border-b-0">
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-[1.05rem]">{index == null ? null : `#${index}`}</span>
          <KindBadge kind={kind} />
        </div>
        {source ? <span className="text-muted-foreground text-sm">source: {source}</span> : null}
        {id != null ? (
          <code className="ml-auto text-muted-foreground text-sm">{ellipsizeMiddle(id, 10)}</code>
        ) : null}
      </div>

      <KindBody kind={kind} sample={record} />

      <div className="mt-5 flex flex-wrap items-center justify-end gap-3 text-dim-foreground text-xs">
        <span>tokens {sampleTokenEstimate(sample)}</span>
        <span aria-hidden="true">|</span>
        <span>chars {sampleCharEstimate(sample)}</span>
        <span aria-hidden="true">|</span>
        <span>lang zh</span>
      </div>

      <details className="mt-5">
        <summary className="cursor-pointer text-muted-foreground text-sm transition hover:text-foreground">
          {t('common.rawJson')}
        </summary>
        <div className="mt-3">
          <JsonBlock value={sample} />
        </div>
      </details>
    </article>
  )
}

function KindBody({ kind, sample }: { kind: string; sample: Record<string, unknown> }) {
  switch (kind) {
    case 'sft':
      return <Messages messages={sample.messages} />
    case 'preference':
      return (
        <div className="space-y-4">
          <Messages messages={sample.messages ?? sample.prompt} />
          <ValueLine label="Assistant (Chosen)" value={sample.chosen} />
          <ValueLine label="Assistant (Rejected)" value={sample.rejected} />
        </div>
      )
    case 'rl':
      return (
        <div className="space-y-4">
          <Messages messages={sample.messages ?? sample.prompt} />
          <ValueLine label="reward" value={sample.reward} />
        </div>
      )
    case 'trajectory':
      return (
        <div className="space-y-4">
          <TrajectorySteps steps={sample.steps} />
          <Messages messages={sample.messages} />
        </div>
      )
    default:
      return null
  }
}

function Messages({ messages }: { messages: unknown }) {
  const rows = sampleMessages(messages)

  if (rows.length === 0) {
    return null
  }

  return (
    <div className="grid gap-4">
      {rows.map((message, index) => (
        <div className="grid gap-3 sm:grid-cols-[2rem_7.5rem_1fr]" key={message.key}>
          <div className="relative hidden justify-center pt-1.5 sm:flex">
            {index < rows.length - 1 ? (
              <span className="absolute top-5 bottom-[-1rem] left-1/2 w-px -translate-x-1/2 bg-border" />
            ) : null}
            <Circle aria-hidden="true" className="relative z-10 text-dim-foreground" size={9} />
          </div>
          <div className="text-muted-foreground text-sm leading-6">
            {titleCaseRole(message.role)}
          </div>
          <div className="whitespace-pre-wrap text-sm leading-6 text-foreground/92">
            {message.content}
          </div>
        </div>
      ))}
    </div>
  )
}

function titleCaseRole(role: string): string {
  return role.length === 0 ? 'Msg' : `${role[0]?.toUpperCase() ?? ''}${role.slice(1)}`
}

function TrajectorySteps({ steps }: { steps: unknown }) {
  const { t } = useTranslation()
  const value = Array.isArray(steps)
    ? t('sample.stepCount', { count: steps.length })
    : t('common.dash')

  return <ValueLine label="steps" value={value} />
}

function ValueLine({ label, value }: { label: string; value: unknown }) {
  if (value == null) {
    return null
  }

  return (
    <div className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
      <span className="text-muted-foreground">{label}</span>
      <span className="whitespace-pre-wrap leading-6">{formatValue(value)}</span>
    </div>
  )
}
