import { useTranslation } from 'react-i18next'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { Badge } from '@/components/ui/badge.js'
import {
  KeyValueGrid,
  KeyValueRow,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { formatInteger } from '@/lib/format.js'
import type { ExportPlanV2 } from '../../api/types.js'

export function FidelityReview({ plan }: { plan: ExportPlanV2 }) {
  const { t } = useTranslation()
  const semantic = plan.fidelity.changes.filter((change) => change.impact === 'semantic')

  return (
    <Surface aria-live="polite" role="status">
      <SurfaceHeader className="flex flex-wrap items-center justify-between gap-3">
        <SurfaceTitle>{t('v2.export.review')}</SurfaceTitle>
        <Badge>
          {semantic.length > 0 ? t('v2.export.semanticLoss') : t('v2.export.noSemanticLoss')}
        </Badge>
      </SurfaceHeader>
      <SurfaceBody className="space-y-5">
        <KeyValueGrid>
          <KeyValueRow label={t('v2.export.exactVersion')}>
            <code className="break-all text-xs">{plan.dataset_version}</code>
          </KeyValueRow>
          <KeyValueRow
            label={t('v2.export.converter')}
            value={`${plan.converter} v${plan.converter_version}`}
          />
          <KeyValueRow label={t('v2.export.mediaType')} value={plan.media_type} />
          <KeyValueRow
            label={t('v2.export.outputCount')}
            value={formatInteger(plan.output_count)}
          />
          <KeyValueRow label={t('v2.export.digest')}>
            <code className="break-all text-xs">{plan.fidelity_digest}</code>
          </KeyValueRow>
        </KeyValueGrid>
        <section>
          <h3 className="font-medium text-sm">{t('v2.export.preserved')}</h3>
          {plan.fidelity.preserved.length === 0 ? (
            <p className="mt-2 text-muted-foreground text-sm">{t('v2.common.none')}</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {plan.fidelity.preserved.map((path) => (
                <li key={path}>
                  <Badge>{path}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className="font-medium text-sm">{t('v2.export.changes')}</h3>
          {plan.fidelity.changes.length === 0 ? (
            <p className="mt-2 text-muted-foreground text-sm">{t('v2.export.noChanges')}</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2">{t('v2.export.impact')}</th>
                    <th className="px-2 py-2">{t('v2.export.action')}</th>
                    <th className="px-2 py-2">{t('v2.export.path')}</th>
                    <th className="px-2 py-2">{t('v2.export.reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.fidelity.changes.map((change) => (
                    <tr
                      className="border-border border-t"
                      key={`${change.path}:${change.action}:${change.impact}:${change.reason}`}
                    >
                      <td className="px-2 py-2">
                        <span>
                          {change.impact === 'semantic' ? '⚠ ' : '• '}
                          {t(`v2.export.impacts.${change.impact}`)}
                        </span>
                      </td>
                      <td className="px-2 py-2">{t(`v2.export.actions.${change.action}`)}</td>
                      <td className="px-2 py-2 font-mono text-xs">{change.path}</td>
                      <td className="px-2 py-2">{change.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <details>
          <summary className="cursor-pointer text-muted-foreground text-sm">
            {t('v2.export.normalizedOptions')}
          </summary>
          <div className="mt-3">
            <JsonBlock value={plan.normalized_options} />
          </div>
        </details>
        <details>
          <summary className="cursor-pointer text-muted-foreground text-sm">
            {t('v2.export.configHints')}
          </summary>
          <div className="mt-3">
            <JsonBlock value={plan.config_hints} />
          </div>
        </details>
      </SurfaceBody>
    </Surface>
  )
}

export function hasSemanticChanges(plan: ExportPlanV2): boolean {
  return plan.fidelity.changes.some((change) => change.impact === 'semantic')
}
