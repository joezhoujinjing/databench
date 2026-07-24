import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import type { CandidateV2 } from '@/v2/api/types.js'
import { Field, RecordContents } from './ContentView.js'
import { JsonValueView } from './JsonValueView.js'
import { LazySection } from './LazySection.js'
import { SignalHistory } from './SignalHistory.js'

export function CandidatesView({ candidates }: { candidates: readonly CandidateV2[] }) {
  const { t } = useTranslation()

  return (
    <LazySection count={candidates.length} title={t('v2.record.candidates')}>
      {() => <MountedCandidates candidates={candidates} />}
    </LazySection>
  )
}

function MountedCandidates({ candidates }: { candidates: readonly CandidateV2[] }) {
  const { t } = useTranslation()
  const [visibleCount, setVisibleCount] = useState(20)

  return (
    <ol className="space-y-4">
      {candidates.length === 0 ? (
        <li className="text-dim-foreground text-sm">{t('v2.record.noCandidates')}</li>
      ) : (
        candidates.slice(0, visibleCount).map((candidate) => (
          <li key={candidate.id}>
            <CandidateView candidate={candidate} />
          </li>
        ))
      )}
      {visibleCount < candidates.length ? (
        <li>
          <Button
            onClick={() => setVisibleCount((count) => count + 20)}
            type="button"
            variant="outline"
          >
            {t('v2.record.showMore', { count: candidates.length - visibleCount })}
          </Button>
        </li>
      ) : null}
    </ol>
  )
}

export function CandidateView({ candidate }: { candidate: CandidateV2 }) {
  const { t } = useTranslation()
  const selectedLabel =
    candidate.selected === true
      ? t('v2.record.selectedYes')
      : candidate.selected === false
        ? t('v2.record.selectedNo')
        : t('v2.record.selectedUnknown')

  return (
    <article className="rounded-[5px] border border-border bg-background/45">
      <header className="flex flex-wrap items-center gap-2 border-border border-b px-4 py-3">
        <Badge
          tone={
            candidate.selected === true
              ? 'green'
              : candidate.selected === false
                ? 'orange'
                : 'muted'
          }
        >
          {selectedLabel}
        </Badge>
        <code className="break-all text-sm">{candidate.id}</code>
      </header>
      <div className="space-y-4 px-4 py-4">
        <div className="grid gap-2 text-sm lg:grid-cols-2">
          <Field label={t('v2.record.rank')} value={candidate.rank ?? t('v2.record.none')} />
          <Field
            label={t('v2.record.finishReason')}
            value={candidate.finish_reason ?? t('v2.record.none')}
          />
          <Field
            label={t('v2.record.tokenCount')}
            value={candidate.token_count ?? t('v2.record.none')}
          />
          <Field
            label={t('v2.record.avgLogprobs')}
            value={candidate.avg_logprobs ?? t('v2.record.none')}
          />
        </div>

        {candidate.generator === null ? (
          <Field label={t('v2.record.generator')} value={t('v2.record.none')} />
        ) : (
          <div className="space-y-2 rounded-[4px] border border-border p-3 text-sm">
            <Field label={t('v2.record.model')} value={candidate.generator.model} />
            <Field
              label={t('v2.record.provider')}
              value={candidate.generator.provider ?? t('v2.record.none')}
            />
            <Field
              label={t('v2.record.revision')}
              value={candidate.generator.revision ?? t('v2.record.none')}
            />
            <JsonValueView
              label={t('v2.record.parameters')}
              value={candidate.generator.parameters}
            />
          </div>
        )}

        <div className="space-y-2">
          <h3 className="font-medium text-sm">{t('v2.record.contents')}</h3>
          <RecordContents contents={candidate.contents} />
        </div>
        <SignalHistory signals={candidate.signals} />
      </div>
    </article>
  )
}
