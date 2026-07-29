import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import type { PreferenceRelationV2 } from '@/v2/api/types.js'
import { Field } from './ContentView.js'
import { LazySection } from './LazySection.js'
import { SafeText } from './SafeText.js'

export function PreferenceRelations({ relations }: { relations: readonly PreferenceRelationV2[] }) {
  const { t } = useTranslation()

  return (
    <LazySection count={relations.length} title={t('v2.record.preferenceRelations')}>
      {() => <MountedRelations relations={relations} />}
    </LazySection>
  )
}

export function MountedRelations({ relations }: { relations: readonly PreferenceRelationV2[] }) {
  const { t } = useTranslation()
  const [showHistory, setShowHistory] = useState(false)
  const [visibleCount, setVisibleCount] = useState(20)
  const supersededIds = useMemo(
    () =>
      new Set(
        relations.flatMap((relation) =>
          relation.supersedes === null ? [] : [relation.supersedes],
        ),
      ),
    [relations],
  )
  const currentRelations = relations.filter((relation) => !supersededIds.has(relation.id))
  const visible = showHistory || currentRelations.length === 0 ? relations : currentRelations
  const rendered = visible.slice(0, visibleCount)

  if (relations.length === 0) {
    return <p className="text-dim-foreground text-sm">{t('v2.record.noRelations')}</p>
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
        {rendered.map((relation) => (
          <li
            className="rounded-[4px] border border-border bg-surface-soft/30 p-3"
            key={relation.id}
          >
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone={supersededIds.has(relation.id) ? 'muted' : 'green'}>
                {supersededIds.has(relation.id)
                  ? t('v2.record.superseded')
                  : t('v2.record.current')}
              </Badge>
              <Badge tone="accent">{relation.outcome}</Badge>
              <Badge tone="blue">{relation.status}</Badge>
            </div>
            <div className="space-y-2 text-sm">
              <Field label={t('v2.record.relationId')} value={relation.id} />
              <Field label={t('v2.record.leftCandidate')} value={relation.left_candidate_id} />
              <Field label={t('v2.record.rightCandidate')} value={relation.right_candidate_id} />
              <Field
                label={t('v2.record.criterion')}
                value={relation.criterion ?? t('v2.record.none')}
              />
              <Field
                label={t('v2.record.source')}
                value={`${relation.source.type} · ${relation.source.id}${relation.source.version === null ? '' : ` · ${relation.source.version}`}`}
              />
              <Field
                label={t('v2.record.createdAt')}
                value={relation.created_at ?? t('v2.record.none')}
              />
              <Field
                label={t('v2.record.supersedes')}
                value={relation.supersedes ?? t('v2.record.none')}
              />
              <Field
                label={t('v2.record.rationale')}
                value={
                  relation.rationale === null ? (
                    t('v2.record.none')
                  ) : (
                    <SafeText
                      downloadName={`relation-${relation.id}.txt`}
                      text={relation.rationale}
                    />
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
