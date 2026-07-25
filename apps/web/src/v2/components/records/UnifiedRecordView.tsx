import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import {
  KeyValueGrid,
  KeyValueRow,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import type { PostTrainingRecordV2, RecordViewV2 } from '@/v2/api/types.js'
import { CandidatesView } from './CandidateView.js'
import { Field, RecordContents } from './ContentView.js'
import { JsonValueView, WorkerJsonDocument } from './JsonValueView.js'
import { LazySection } from './LazySection.js'
import { PreferenceRelations } from './PreferenceRelations.js'

export function UnifiedRecordView({ view }: { view: RecordViewV2 }) {
  const { t } = useTranslation()
  const { record } = view

  return (
    <div className="space-y-5">
      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('v2.record.title')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          <KeyValueGrid>
            <KeyValueRow label={t('v2.record.schemaVersion')} value={record.schema_version} />
            <KeyValueRow label={t('v2.record.recordId')} value={record.id} />
            <KeyValueRow label={t('v2.record.recordDigest')} value={view.record_digest} />
            <KeyValueRow label={t('v2.record.datasetVersion')} value={view.dataset_version} />
            <KeyValueRow
              label={t('v2.record.language')}
              value={record.lang ?? t('v2.record.none')}
            />
            <KeyValueRow label={t('v2.record.tags')}>
              <div className="flex flex-wrap gap-2">
                {record.tags.length === 0 ? (
                  <span className="text-dim-foreground">{t('v2.record.none')}</span>
                ) : (
                  record.tags.map((tag, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: duplicate canonical tags retain their stable order
                    <Badge key={`${tag}:${index}`} tone="muted">
                      {tag}
                    </Badge>
                  ))
                )}
              </div>
            </KeyValueRow>
          </KeyValueGrid>
        </SurfaceBody>
      </Surface>

      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('v2.record.contents')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          <RecordContents contents={record.contents} />
        </SurfaceBody>
      </Surface>

      <CandidatesView candidates={record.candidates} />
      <PreferenceRelations relations={record.preference_relations} />
      <ToolsAndVerification record={record} />
      <Provenance record={record} />

      <LazySection title={t('v2.record.rawJson')}>
        {() => <WorkerJsonDocument downloadName={`record-${record.id}.json`} value={record} />}
      </LazySection>
    </div>
  )
}

export function ToolsAndVerification({ record }: { record: PostTrainingRecordV2 }) {
  const { t } = useTranslation()

  return (
    <LazySection title={t('v2.record.toolsAndVerification')}>
      {() => {
        const coverage = collectCallCoverage(record)
        return (
          <div className="space-y-5">
            <section className="space-y-3">
              <h3 className="font-medium text-sm">{t('v2.record.tools')}</h3>
              {record.tools.length === 0 ? (
                <p className="text-dim-foreground text-sm">{t('v2.record.noTools')}</p>
              ) : (
                <ol className="space-y-3">
                  {record.tools.map((tool) => {
                    const stats = coverage.get(tool.name) ?? { calls: 0, responses: 0 }
                    return (
                      <li className="rounded-[4px] border border-border p-3" key={tool.name}>
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <Badge tone="blue">{tool.name}</Badge>
                          <span className="text-dim-foreground text-xs">
                            {t('v2.record.callCoverage', stats)}
                          </span>
                        </div>
                        <Field
                          label={t('v2.record.description')}
                          value={tool.description ?? t('v2.record.none')}
                        />
                        <div className="mt-3">
                          <JsonValueView
                            label={t('v2.record.inputSchema')}
                            value={tool.input_schema}
                          />
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </section>

            <section className="space-y-3 border-border border-t pt-4">
              <h3 className="font-medium text-sm">{t('v2.record.verification')}</h3>
              {record.verification === null ? (
                <p className="text-dim-foreground text-sm">{t('v2.record.none')}</p>
              ) : (
                <div className="space-y-2 text-sm">
                  <Field label={t('v2.record.verifier')} value={record.verification.verifier} />
                  <Field
                    label={t('v2.record.verifierVersion')}
                    value={record.verification.verifier_version}
                  />
                  <JsonValueView
                    label={t('v2.record.groundTruth')}
                    value={record.verification.ground_truth}
                  />
                  <JsonValueView
                    label={t('v2.record.constraint')}
                    value={record.verification.constraint}
                  />
                  <JsonValueView label={t('v2.record.config')} value={record.verification.config} />
                </div>
              )}
            </section>
          </div>
        )
      }}
    </LazySection>
  )
}

export function Provenance({ record }: { record: PostTrainingRecordV2 }) {
  const { t } = useTranslation()

  return (
    <Surface>
      <SurfaceHeader>
        <SurfaceTitle>{t('v2.record.provenance')}</SurfaceTitle>
      </SurfaceHeader>
      <SurfaceBody className="space-y-4">
        {record.source === null ? (
          <Field label={t('v2.record.source')} value={t('v2.record.none')} />
        ) : (
          <div className="space-y-2 text-sm">
            <Field label={t('v2.record.sourceName')} value={record.source.name} />
            <Field label={t('v2.record.sourceKind')} value={record.source.kind} />
            <Field
              label={t('v2.record.originalId')}
              value={record.source.original_id ?? t('v2.record.none')}
            />
            <Field
              label={t('v2.record.license')}
              value={record.source.license ?? t('v2.record.none')}
            />
            <Field
              label={t('v2.record.sourceUrl')}
              value={record.source.url ?? t('v2.record.none')}
            />
          </div>
        )}

        <LazySection title={t('v2.record.lineage')}>
          {() =>
            record.lineage === null ? (
              <p className="text-dim-foreground text-sm">{t('v2.record.none')}</p>
            ) : (
              <div className="space-y-3 text-sm">
                <Field
                  label={t('v2.record.recipe')}
                  value={record.lineage.recipe ?? t('v2.record.none')}
                />
                <Field
                  label={t('v2.record.recipeRevision')}
                  value={record.lineage.recipe_revision ?? t('v2.record.none')}
                />
                <Field
                  label={t('v2.record.runId')}
                  value={record.lineage.run_id ?? t('v2.record.none')}
                />
                <JsonValueView
                  label={t('v2.record.parentRefs')}
                  value={record.lineage.parent_refs}
                />
                <JsonValueView label={t('v2.record.steps')} value={record.lineage.steps} />
              </div>
            )
          }
        </LazySection>

        <JsonValueView label={t('v2.record.extra')} value={record.extra} />
      </SurfaceBody>
    </Surface>
  )
}

export function collectCallCoverage(
  record: PostTrainingRecordV2,
): ReadonlyMap<string, { calls: number; responses: number }> {
  const counts = new Map<string, { calls: number; responses: number }>()
  const sharedCallNames = countTrajectoryParts(record.contents, new Map(), counts)

  for (const candidate of record.candidates) {
    countTrajectoryParts(candidate.contents, new Map(sharedCallNames), counts)
  }

  return counts
}

function countTrajectoryParts(
  sequence: PostTrainingRecordV2['contents'],
  callNames: Map<string, string>,
  counts: Map<string, { calls: number; responses: number }>,
): Map<string, string> {
  for (const content of sequence) {
    for (const part of content.parts) {
      if (part.type === 'function_call') {
        callNames.set(part.function_call.id, part.function_call.name)
        incrementCoverage(counts, part.function_call.name, 'calls')
      } else if (part.type === 'function_response') {
        const name = callNames.get(part.function_response.call_id)
        if (name !== undefined) incrementCoverage(counts, name, 'responses')
      }
    }
  }

  return callNames
}

function incrementCoverage(
  counts: Map<string, { calls: number; responses: number }>,
  name: string,
  field: 'calls' | 'responses',
): void {
  const current = counts.get(name) ?? { calls: 0, responses: 0 }
  counts.set(name, { ...current, [field]: current[field] + 1 })
}
