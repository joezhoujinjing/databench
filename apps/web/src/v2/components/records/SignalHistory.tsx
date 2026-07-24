import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import type { SignalV2 } from '@/v2/api/types.js'
import { Field } from './ContentView.js'
import { JsonValueView } from './JsonValueView.js'
import { LazySection } from './LazySection.js'
import { SafeText } from './SafeText.js'

export function SignalHistory({ signals }: { signals: readonly SignalV2[] }) {
  const { t } = useTranslation()

  return (
    <LazySection count={signals.length} title={t('v2.record.signals')}>
      {() => <MountedSignalHistory signals={signals} />}
    </LazySection>
  )
}

export function MountedSignalHistory({ signals }: { signals: readonly SignalV2[] }) {
  const { t } = useTranslation()
  const [showHistory, setShowHistory] = useState(false)
  const [visibleCount, setVisibleCount] = useState(20)
  const supersededIds = useMemo(
    () =>
      new Set(signals.flatMap((signal) => (signal.supersedes === null ? [] : [signal.supersedes]))),
    [signals],
  )
  const currentSignals = signals.filter((signal) => !supersededIds.has(signal.id))
  const visible = showHistory || currentSignals.length === 0 ? signals : currentSignals
  const rendered = visible.slice(0, visibleCount)

  if (signals.length === 0) {
    return <p className="text-dim-foreground text-sm">{t('v2.record.noSignals')}</p>
  }

  return (
    <div className="space-y-3">
      {supersededIds.size > 0 ? (
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setShowHistory((current) => !current)
              setVisibleCount(20)
            }}
            size="sm"
            variant="ghost"
          >
            {showHistory ? t('v2.record.currentOnly') : t('v2.record.showSuperseded')}
          </Button>
        </div>
      ) : null}
      <ol className="space-y-3">
        {rendered.map((signal) => (
          <li className="rounded-[4px] border border-border bg-surface-soft/30 p-3" key={signal.id}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone={supersededIds.has(signal.id) ? 'muted' : 'green'}>
                {supersededIds.has(signal.id) ? t('v2.record.superseded') : t('v2.record.current')}
              </Badge>
              <Badge tone="blue">{signal.kind}</Badge>
              <span className="text-sm">{signal.name}</span>
            </div>
            <div className="space-y-2 text-sm">
              <Field label={t('v2.record.signalId')} value={signal.id} />
              <Field
                label={t('v2.record.source')}
                value={`${signal.source.type} · ${signal.source.id}${signal.source.version === null ? '' : ` · ${signal.source.version}`}`}
              />
              <Field
                label={t('v2.record.createdAt')}
                value={signal.created_at ?? t('v2.record.none')}
              />
              <Field
                label={t('v2.record.supersedes')}
                value={signal.supersedes ?? t('v2.record.none')}
              />
              <SignalValue signal={signal} />
              <Field
                label={t('v2.record.rationale')}
                value={
                  signal.rationale === null ? (
                    t('v2.record.none')
                  ) : (
                    <SafeText downloadName={`signal-${signal.id}.txt`} text={signal.rationale} />
                  )
                }
              />
            </div>
          </li>
        ))}
      </ol>
      {visibleCount < visible.length ? (
        <Button
          onClick={() => setVisibleCount((count) => count + 20)}
          type="button"
          variant="outline"
        >
          {t('v2.record.showMore', { count: visible.length - visibleCount })}
        </Button>
      ) : null}
    </div>
  )
}

export function SignalValue({ signal }: { signal: SignalV2 }) {
  const { t } = useTranslation()
  const value = signal.value

  if (value.type === 'json') {
    return (
      <div className="space-y-2">
        <Field label={t('v2.record.valueType')} value={value.type} />
        <JsonValueView label={t('v2.record.value')} value={value.value} />
      </div>
    )
  }
  if (value.type === 'number') {
    return (
      <div className="space-y-2">
        <Field label={t('v2.record.valueType')} value={value.type} />
        <Field label={t('v2.record.value')} value={value.value} />
        <Field
          label={t('v2.record.scale')}
          value={`${value.scale_min ?? '—'} … ${value.scale_max ?? '—'}`}
        />
        <Field
          label={t('v2.record.higherIsBetter')}
          value={
            value.higher_is_better === null ? t('v2.record.none') : String(value.higher_is_better)
          }
        />
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <Field label={t('v2.record.valueType')} value={value.type} />
      <Field label={t('v2.record.value')} value={String(value.value)} />
    </div>
  )
}
