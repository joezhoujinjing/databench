import { Link } from '@tanstack/react-router'
import { Bookmark, Plus, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DatasetManifest, RefInfo } from '@/api/types.js'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { EmptyState, ErrorState, Spinner } from '@/components/common/State.js'
import { KindBadge, StatusDot } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { TextInput } from '@/components/ui/input.js'
import { PageHeader, PageShell, Surface } from '@/components/ui/surface.js'
import { formatInteger, kindEntries, shortRef } from '@/lib/format.js'

export function DatasetsPageView({
  error,
  filter,
  isError,
  isLoading,
  manifestsByVersion,
  onFilterChange,
  rows,
  shouldShowCapped,
  total,
  unfilteredCount,
}: {
  error: unknown
  filter: string
  isError: boolean
  isLoading: boolean
  manifestsByVersion: ReadonlyMap<string, DatasetManifest>
  onFilterChange: (value: string) => void
  rows: RefInfo[]
  shouldShowCapped: boolean
  total: number
  unfilteredCount: number
}) {
  const { t } = useTranslation()

  return (
    <PageShell>
      <PageHeader
        actions={
          <Button asChild variant="outline">
            <Link to="/ingest">
              <Plus aria-hidden="true" size={16} />
              New dataset
            </Link>
          </Button>
        }
        description={t('datasets.description')}
        title={t('datasets.title')}
      />

      <div className="relative block max-w-[56rem]">
        <Search
          aria-hidden="true"
          className="absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground"
          size={18}
        />
        <TextInput
          aria-label={t('datasets.filterPlaceholder')}
          className="h-12 pl-11"
          onChange={(event) => onFilterChange(event.currentTarget.value)}
          placeholder={t('datasets.filterPlaceholder')}
          value={filter}
        />
        <span className="absolute top-1/2 right-4 -translate-y-1/2 text-dim-foreground text-xs">
          ⌘ K
        </span>
      </div>

      <Surface className="overflow-hidden">
        <div className="grid grid-cols-[minmax(12rem,2fr)_minmax(10rem,1.2fr)_minmax(9rem,1fr)_minmax(8rem,0.8fr)_minmax(12rem,1.1fr)] border-border border-b bg-background/35 px-5 py-3.5 text-muted-foreground text-sm max-lg:hidden">
          <div>{t('datasets.colName')}</div>
          <div>{t('datasets.colVersion')}</div>
          <div>Types</div>
          <div>{t('manifest.numRows')}</div>
          <div>Last activity</div>
        </div>

        {isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : null}
        {isError ? (
          <div className="p-6">
            <ErrorState error={error} />
          </div>
        ) : null}
        {!isLoading && !isError && unfilteredCount === 0 ? (
          <div className="p-6">
            <EmptyState>{t('datasets.emptyNoRefs')}</EmptyState>
          </div>
        ) : null}
        {!isLoading && !isError && unfilteredCount > 0 && rows.length === 0 ? (
          <div className="p-6">
            <EmptyState>{t('datasets.emptyNoMatch')}</EmptyState>
          </div>
        ) : null}
        {rows.map((row) => (
          <DatasetRow key={row.name} manifest={manifestsByVersion.get(row.version)} row={row} />
        ))}
      </Surface>

      <p className="text-muted-foreground text-sm">
        {shouldShowCapped
          ? t('datasets.cappedNote', { shown: unfilteredCount, total })
          : `Showing ${rows.length} of ${total} datasets`}
      </p>
    </PageShell>
  )
}

function DatasetRow({ manifest, row }: { manifest: DatasetManifest | undefined; row: RefInfo }) {
  const kinds = manifest ? kindEntries(manifest) : []

  return (
    <div className="border-border border-b last:border-b-0">
      <div className="grid w-full items-center gap-4 border-l-2 border-l-transparent px-5 py-4 text-left text-sm transition hover:bg-surface-hover/70 lg:grid-cols-[minmax(12rem,2fr)_minmax(10rem,1.2fr)_minmax(9rem,1fr)_minmax(8rem,0.8fr)_minmax(12rem,1.1fr)] data-[selected=true]:border-l-primary data-[selected=true]:bg-surface-soft">
        <Link
          className="group flex min-w-0 items-center gap-3 text-left transition hover:text-foreground"
          params={{ ref: row.name }}
          to="/datasets/$ref"
        >
          <span className="text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary">
            ›
          </span>
          <Bookmark aria-hidden="true" className="text-dim-foreground" size={17} />
          <span className="truncate font-semibold text-base">{row.name}</span>
        </Link>
        <div className="flex min-w-0 items-center gap-2">
          <code className="truncate text-muted-foreground" title={row.version}>
            {shortRef(row.version)}
          </code>
          <CopyTextButton label="Copy version" text={row.version} />
        </div>
        <div className="flex flex-wrap gap-2">
          {kinds.length > 0 ? (
            kinds.map(([kind]) => <KindBadge kind={kind} key={kind} />)
          ) : (
            <span className="text-dim-foreground">-</span>
          )}
        </div>
        <div className="text-muted-foreground">
          {manifest ? formatInteger(manifest.num_rows) : '-'}
        </div>
        <div className="flex items-center gap-3 text-muted-foreground">
          <StatusDot />
          <span>current</span>
        </div>
      </div>
    </div>
  )
}
