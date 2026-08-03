import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FlaskConical,
  GitBranch,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { Alert } from '@/components/ui/alert.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import {
  PageShell,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { formatBytes, formatInteger } from '@/lib/format.js'
import { cn } from '@/lib/utils.js'
import type { DatasetViewV2 } from '../../api/types.js'
import { VirtualizedRecords } from '../../components/records/VirtualizedRecords.js'
import { V2MutationError } from '../../components/V2MutationError.js'

export function V2DatasetDetailView({
  canDelete,
  deleteError,
  isDeleting,
  latestVersion,
  onAdoptLatest,
  onDelete,
  pinnedVersion,
  requestedRef,
  view,
}: {
  canDelete: boolean
  deleteError: unknown
  isDeleting: boolean
  latestVersion: string | null
  onAdoptLatest(): void
  onDelete(): void
  pinnedVersion: string
  requestedRef: string
  view: DatasetViewV2
}) {
  const { t } = useTranslation()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleteTitleId = useId()
  const { manifest } = view
  const moved = latestVersion !== null && latestVersion !== pinnedVersion

  return (
    <PageShell className="space-y-4">
      <header className="space-y-3">
        <Link
          className="inline-flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          to="/datasets"
        >
          <ArrowLeft aria-hidden="true" size={15} />
          {t('v2.detail.back')}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="min-w-0 break-words font-semibold text-[1.75rem] leading-tight tracking-tight">
            {requestedRef}
          </h1>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button asChild>
              <Link
                search={{
                  datasetVersion: pinnedVersion,
                  source: 'databench',
                  tab: 'eval',
                }}
                to="/evaluations/tasks"
              >
                <FlaskConical aria-hidden="true" size={15} />
                {t('v2.detail.createEvaluation')}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link params={{ ref: pinnedVersion }} to="/lineage/$ref">
                <GitBranch aria-hidden="true" size={15} />
                {t('v2.detail.lineage')}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link params={{ ref: pinnedVersion }} to="/export/$ref">
                <Download aria-hidden="true" size={15} />
                {t('v2.detail.export')}
              </Link>
            </Button>
            {canDelete ? (
              <Button
                className="text-danger hover:bg-danger/10 hover:text-danger"
                disabled={isDeleting}
                onClick={() => setConfirmingDelete(true)}
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" size={15} />
                {t('v2.detail.delete')}
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {confirmingDelete ? (
        <Alert
          aria-labelledby={deleteTitleId}
          className="border-danger/35 bg-danger/10"
          role="alertdialog"
        >
          <div className="font-medium text-foreground" id={deleteTitleId}>
            {t('v2.detail.deleteTitle', { name: requestedRef })}
          </div>
          <p className="mt-1 text-muted-foreground">
            {t('v2.detail.deleteDescription', { name: requestedRef })}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={isDeleting} onClick={onDelete} type="button" variant="destructive">
              {isDeleting ? t('v2.detail.deleting') : t('v2.detail.confirmDelete')}
            </Button>
            <Button
              disabled={isDeleting}
              onClick={() => setConfirmingDelete(false)}
              type="button"
              variant="outline"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </Alert>
      ) : null}

      {deleteError === null ? null : <V2MutationError error={deleteError} />}

      {moved ? (
        <div className="flex flex-wrap items-center justify-between gap-4 border-warning/35 border-y bg-warning/5 px-4 py-3 text-sm">
          <span>{t('v2.detail.newVersion', { version: latestVersion })}</span>
          <Button onClick={onAdoptLatest} size="sm" type="button" variant="outline">
            <RefreshCw aria-hidden="true" size={14} />
            {t('v2.detail.openNewVersion')}
          </Button>
        </div>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <Surface className="overflow-hidden shadow-none">
          <SurfaceHeader className="py-3.5">
            <SurfaceTitle>{t('v2.detail.records')}</SurfaceTitle>
          </SurfaceHeader>
          <VirtualizedRecords datasetVersion={pinnedVersion} />
        </Surface>

        <aside className="space-y-4 xl:sticky xl:top-20">
          <Surface className="shadow-none">
            <SurfaceHeader className="py-3.5">
              <SurfaceTitle>{t('v2.detail.overview')}</SurfaceTitle>
            </SurfaceHeader>
            <dl className="divide-y divide-border px-4">
              <OverviewRow
                label={t('v2.detail.records')}
                value={formatInteger(manifest.num_records)}
              />
              <OverviewRow label={t('v2.detail.layout')} value={manifest.layout_version} />
              <OverviewRow label={t('v2.detail.schema')} value={manifest.record_schema_version} />
              <OverviewRow
                label={t('v2.detail.size')}
                value={
                  <span title={`${formatInteger(manifest.artifact_size_bytes)} B`}>
                    {formatBytes(manifest.artifact_size_bytes)}
                  </span>
                }
              />
              <OverviewRow label={t('v2.detail.hash')} value={manifest.hash_algorithm} />
            </dl>
          </Surface>

          <Surface className="shadow-none">
            <SurfaceHeader className="py-3.5">
              <SurfaceTitle>{t('v2.detail.snapshot')}</SurfaceTitle>
            </SurfaceHeader>
            <SurfaceBody className="space-y-4 py-4">
              <DetailField label={t('v2.datasets.version')}>
                <span className="min-w-0 break-all font-mono text-xs leading-5">
                  {pinnedVersion}
                </span>
                <CopyTextButton label={t('v2.record.copy')} text={pinnedVersion} />
              </DetailField>
              <DetailField label={t('v2.detail.identity')}>
                <span className="break-all font-mono text-xs leading-5">
                  {manifest.identity_profile}
                </span>
              </DetailField>
              <DetailField label={t('v2.detail.columns')}>
                <div className="flex flex-wrap gap-1.5">
                  {manifest.columns.map((column) => (
                    <Badge key={column}>{column}</Badge>
                  ))}
                </div>
              </DetailField>
              <details className="group border-border border-t pt-3">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary">
                  <ChevronRight
                    aria-hidden="true"
                    className="transition-transform group-open:rotate-90"
                    size={15}
                  />
                  <span>{t('v2.detail.manifest')}</span>
                </summary>
                <div className="mt-3">
                  <JsonBlock value={manifest} />
                </div>
              </details>
            </SurfaceBody>
          </Surface>
        </aside>
      </div>
    </PageShell>
  )
}

function DetailField({
  children,
  className,
  label,
}: {
  children: ReactNode
  className?: string
  label: ReactNode
}) {
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="flex min-h-7 min-w-0 items-center gap-2 text-sm">{children}</div>
    </div>
  )
}

function OverviewRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 py-3 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium">{value}</dd>
    </div>
  )
}
