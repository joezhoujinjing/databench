import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { DatasetManifest } from '@/api/types.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { KindBadge } from '@/components/ui/badge.js'
import { KeyValueGrid, KeyValueRow, SectionLabel } from '@/components/ui/surface.js'
import { ellipsizeMiddle, formatInteger, kindEntries } from '@/lib/format.js'

const KNOWN_KEYS = new Set(['version', 'name', 'num_rows', 'kinds'])

export function ManifestView({
  linkToDetail = false,
  manifest,
}: {
  linkToDetail?: boolean
  manifest: DatasetManifest
}) {
  const { t } = useTranslation()
  const extra = Object.fromEntries(Object.entries(manifest).filter(([key]) => !KNOWN_KEYS.has(key)))
  const hasExtra = Object.keys(extra).length > 0
  const kinds = kindEntries(manifest)

  return (
    <div className="space-y-5">
      <KeyValueGrid>
        <KeyValueRow label={t('manifest.name')}>
          {manifest.name ?? <span className="text-dim-foreground">{t('common.dash')}</span>}
        </KeyValueRow>
        <KeyValueRow label={t('manifest.version')}>
          <span className="inline-flex min-w-0 items-center gap-2">
            {linkToDetail ? (
              <Link
                className="min-w-0 break-all text-accent-foreground"
                params={{ ref: manifest.version }}
                title={manifest.version}
                to="/datasets/$ref"
              >
                <code>{ellipsizeMiddle(manifest.version, 12)}</code>
              </Link>
            ) : (
              <code className="break-all" title={manifest.version}>
                {ellipsizeMiddle(manifest.version, 12)}
              </code>
            )}
          </span>
        </KeyValueRow>
        <KeyValueRow label={t('manifest.numRows')}>{formatInteger(manifest.num_rows)}</KeyValueRow>
      </KeyValueGrid>

      <div className="space-y-1">
        <SectionLabel>{t('manifest.kinds')}</SectionLabel>
        {kinds.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {kinds.map(([kind, count]) => (
              <KindBadge kind={`${kind}: ${formatInteger(count)}`} key={kind} />
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">{t('common.none')}</span>
        )}
      </div>

      {hasExtra ? (
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm">{t('manifest.otherFields')}</summary>
          <JsonBlock value={extra} />
        </details>
      ) : null}
    </div>
  )
}
