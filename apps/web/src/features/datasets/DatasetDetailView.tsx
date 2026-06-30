import { Link } from '@tanstack/react-router'
import { Download, GitBranch } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { downloadExport } from '@/api/datasets.js'
import type { DatasetManifest } from '@/api/types.js'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { ErrorState, InlineError, Spinner } from '@/components/common/State.js'
import { VirtualizedSamples } from '@/components/samples/VirtualizedSamples.js'
import { KindBadge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { SelectInput } from '@/components/ui/input.js'
import {
  KeyValueGrid,
  KeyValueRow,
  PageHeader,
  PageShell,
  SectionLabel,
  Surface,
  SurfaceBody,
  SurfaceDescription,
  SurfaceHeader,
  SurfaceTitle,
  Toolbar,
} from '@/components/ui/surface.js'
import {
  displayDatasetName,
  ellipsizeMiddle,
  formatInteger,
  kindEntries,
  shortRef,
} from '@/lib/format.js'

export const PAGE_SIZES = [20, 50, 100, 200, 500] as const
const PAGE_SIZE_OPTIONS = PAGE_SIZES.map((value) => ({ label: String(value), value }))
const DETAIL_MANIFEST_SUMMARY_KEYS = new Set([
  'name',
  'version',
  'num_rows',
  'kinds',
  'created_at',
  'schema_version',
  'hash_algo',
  'columns',
])

export function DatasetDetailView({
  dataset,
  error,
  exportEnabled,
  isError,
  isLoading,
  lineageEnabled,
  pageSize,
  refName,
  setPageSize,
}: {
  dataset: DatasetManifest | undefined
  error: unknown
  exportEnabled: boolean
  isError: boolean
  isLoading: boolean
  lineageEnabled: boolean
  pageSize: (typeof PAGE_SIZES)[number]
  refName: string
  setPageSize: (value: (typeof PAGE_SIZES)[number]) => void
}) {
  const { t } = useTranslation()
  const title = dataset ? detailTitle(refName, dataset) : shortRef(refName)
  const datasetName = dataset ? displayDatasetName(dataset) : null
  const version = dataset?.version ?? refName
  const kinds = dataset ? kindEntries(dataset) : []
  const [sampleKind, setSampleKind] = useState<string | null>(null)

  useEffect(() => {
    if (sampleKind !== null && !kinds.some(([kind]) => kind === sampleKind)) {
      setSampleKind(null)
    }
  }, [kinds, sampleKind])

  return (
    <PageShell className="space-y-6">
      <PageHeader
        actions={
          <Toolbar>
            {dataset && exportEnabled ? <ExportButton refName={refName} /> : null}
            {lineageEnabled ? (
              <Button asChild variant="quiet">
                <Link params={{ ref: refName }} to="/lineage/$ref">
                  <GitBranch aria-hidden="true" size={16} />
                  {t('detail.viewLineage')}
                </Link>
              </Button>
            ) : null}
          </Toolbar>
        }
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <Link className="hover:text-foreground" to="/datasets">
              {t('datasets.title')}
            </Link>
            <span>/</span>
            <span>{title}</span>
          </span>
        }
        description={
          datasetName && datasetName !== title ? (
            <span>
              {t('detail.refLabel')} <code>{refName}</code> {t('detail.resolvesToDataset')}{' '}
              <code>{datasetName}</code>.
            </span>
          ) : (
            <span>{t('detail.description')}</span>
          )
        }
        title={
          <span className="inline-flex min-w-0 items-center gap-3">
            <span className="truncate">{title}</span>
            {dataset ? <KindBadge kind="Active" /> : null}
          </span>
        }
      />

      {isLoading ? <Spinner /> : null}
      {isError ? <ErrorState error={error} /> : null}

      {dataset ? (
        <>
          <Surface className="overflow-hidden bg-border">
            <div className="grid gap-px md:grid-cols-2 xl:grid-cols-[minmax(0,1.7fr)_0.55fr_1fr_1.05fr]">
              <SummaryCell label={t('detail.version')}>
                <div className="mt-3 flex min-w-0 items-center gap-2">
                  <code className="truncate text-[1.03rem] text-muted-foreground" title={version}>
                    {ellipsizeMiddle(version, 18)}
                  </code>
                  <CopyTextButton label="Copy version" text={version} />
                </div>
              </SummaryCell>
              <SummaryCell label={t('detail.rows')}>
                <div className="mt-3 font-medium text-[1.35rem] leading-none">
                  {formatInteger(dataset.num_rows)}
                </div>
              </SummaryCell>
              <SummaryCell label={t('detail.kinds')}>
                <div className="mt-3 flex flex-wrap gap-2">
                  {kinds.length > 0 ? (
                    kinds.map(([kind]) => <KindBadge kind={kind} key={kind} />)
                  ) : (
                    <span className="text-muted-foreground">{t('common.none')}</span>
                  )}
                </div>
              </SummaryCell>
              <SummaryCell label={t('detail.created')}>
                <div className="mt-3 text-[1.03rem] leading-6">
                  {formatTimestamp(dataset.created_at)}
                </div>
              </SummaryCell>
            </div>
          </Surface>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
            <Surface className="overflow-hidden">
              <SurfaceHeader className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <SurfaceTitle>{t('detail.samples')}</SurfaceTitle>
                  <div className="mt-4 flex flex-wrap items-center gap-5 text-sm">
                    <button
                      className="border-b-2 border-primary pb-2.5 text-foreground transition data-[active=false]:border-transparent data-[active=false]:text-muted-foreground data-[active=false]:hover:text-foreground"
                      data-active={sampleKind === null}
                      onClick={() => setSampleKind(null)}
                      type="button"
                    >
                      All ({formatInteger(dataset.num_rows)})
                    </button>
                    {kinds.map(([kind, count]) => (
                      <button
                        className="border-b-2 border-primary pb-2.5 text-foreground transition data-[active=false]:border-transparent data-[active=false]:text-muted-foreground data-[active=false]:hover:text-foreground"
                        data-active={sampleKind === kind}
                        key={kind}
                        onClick={() => setSampleKind(kind)}
                        type="button"
                      >
                        {kind} ({formatInteger(count)})
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{t('detail.pageSize')}</span>
                  <SelectInput
                    aria-label={t('detail.pageSize')}
                    className="h-10 w-24"
                    onValueChange={setPageSize}
                    options={PAGE_SIZE_OPTIONS}
                    value={pageSize}
                  />
                </div>
              </SurfaceHeader>
              <SurfaceBody className="p-0">
                <VirtualizedSamples
                  key={`${refName}:${pageSize}:${sampleKind ?? 'all'}`}
                  kindFilter={sampleKind}
                  kindTotal={sampleKind === null ? dataset.num_rows : kindTotal(kinds, sampleKind)}
                  pageSize={pageSize}
                  refName={refName}
                />
              </SurfaceBody>
            </Surface>

            <div className="space-y-5">
              <Surface>
                <SurfaceHeader>
                  <SurfaceTitle>{t('detail.manifest')}</SurfaceTitle>
                  <SurfaceDescription>{t('detail.manifestDescription')}</SurfaceDescription>
                </SurfaceHeader>
                <SurfaceBody className="text-[0.93rem]">
                  <DetailManifestInspector manifest={dataset} />
                </SurfaceBody>
              </Surface>
            </div>
          </div>
        </>
      ) : null}
    </PageShell>
  )
}

function SummaryCell({ children, label }: { children: ReactNode; label: ReactNode }) {
  return (
    <div className="min-w-0 bg-surface px-5 py-4">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  )
}

function DetailManifestInspector({ manifest }: { manifest: DatasetManifest }) {
  const { t } = useTranslation()
  const extra = detailManifestExtraFields(manifest)
  const hasExtra = Object.keys(extra).length > 0

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <SectionLabel>{t('detail.technicalFields')}</SectionLabel>
        <KeyValueGrid>
          <KeyValueRow label={t('detail.schema')}>v{manifest.schema_version}</KeyValueRow>
          <KeyValueRow label={t('detail.hash')}>{manifest.hash_algo}</KeyValueRow>
          <KeyValueRow label={t('detail.columns')}>
            <div className="space-y-2">
              <span>{formatInteger(manifest.columns.length)}</span>
              <details>
                <summary className="cursor-pointer text-dim-foreground text-xs">
                  {t('detail.viewColumns')}
                </summary>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {manifest.columns.map((column) => (
                    <code
                      className="rounded-[3px] bg-surface-soft px-1.5 py-1 text-dim-foreground text-xs"
                      key={column}
                    >
                      {column}
                    </code>
                  ))}
                </div>
              </details>
            </div>
          </KeyValueRow>
        </KeyValueGrid>
      </div>

      {hasExtra ? (
        <details className="border-border border-t pt-4">
          <summary className="cursor-pointer text-sm">{t('manifest.otherFields')}</summary>
          <div className="mt-3">
            <JsonBlock value={extra} />
          </div>
        </details>
      ) : null}

      <details className="border-border border-t pt-4">
        <summary className="cursor-pointer text-sm">{t('detail.rawManifest')}</summary>
        <div className="mt-3">
          <JsonBlock value={manifest} />
        </div>
      </details>
    </div>
  )
}

function detailManifestExtraFields(manifest: DatasetManifest): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !DETAIL_MANIFEST_SUMMARY_KEYS.has(key)),
  )
}

function detailTitle(refName: string, dataset: DatasetManifest): string {
  return isVersionRef(refName) ? displayDatasetName(dataset) : refName
}

function isVersionRef(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

function kindTotal(kinds: readonly [string, number][], kind: string): number {
  return kinds.find(([name]) => name === kind)?.[1] ?? 0
}

function formatTimestamp(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function ExportButton({ refName }: { refName: string }) {
  const { t } = useTranslation()
  const { base, token } = useBackend()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  return (
    <span className="relative inline-flex">
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await downloadExport({ base, ref: refName, token })
          } catch (caught) {
            setError(caught)
          } finally {
            setBusy(false)
          }
        }}
        type="button"
        variant="quiet"
      >
        <Download aria-hidden="true" size={16} />
        {busy ? t('detail.exporting') : t('detail.exportJsonl')}
      </Button>
      {error ? (
        <span className="absolute top-full right-0 mt-2 w-72 rounded-[5px] border border-border bg-surface-raised p-3 shadow-2xl">
          <InlineError error={error} />
        </span>
      ) : null}
    </span>
  )
}
