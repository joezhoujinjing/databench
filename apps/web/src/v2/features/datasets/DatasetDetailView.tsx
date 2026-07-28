import { Link } from '@tanstack/react-router'
import { FlaskConical, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { Alert } from '@/components/ui/alert.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import {
  KeyValueGrid,
  KeyValueRow,
  MetricItem,
  MetricStrip,
  PageHeader,
  PageShell,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { formatInteger } from '@/lib/format.js'
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
  const { manifest } = view
  const moved = latestVersion !== null && latestVersion !== pinnedVersion

  return (
    <PageShell>
      <PageHeader
        actions={
          <>
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
                {t('v2.detail.lineage')}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link params={{ ref: pinnedVersion }} to="/export/$ref">
                {t('v2.detail.export')}
              </Link>
            </Button>
            {canDelete ? (
              <Button
                className="border-danger/45 text-danger hover:bg-danger/10"
                disabled={isDeleting}
                onClick={() => setConfirmingDelete(true)}
                type="button"
                variant="outline"
              >
                <Trash2 aria-hidden="true" size={15} />
                {t('v2.detail.delete')}
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link to="/datasets">{t('v2.detail.back')}</Link>
            </Button>
          </>
        }
        title={requestedRef}
      />

      {confirmingDelete ? (
        <Alert className="border-danger/35 bg-danger/10" role="alertdialog">
          <div className="font-medium text-foreground">{t('v2.detail.deleteTitle')}</div>
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

      <MetricStrip>
        <MetricItem label={t('v2.detail.records')} value={formatInteger(manifest.num_records)} />
        <MetricItem label={t('v2.detail.layout')} value={manifest.layout_version} />
        <MetricItem label={t('v2.detail.schema')} value={manifest.record_schema_version} />
        <MetricItem
          label={t('v2.detail.size')}
          value={formatInteger(manifest.artifact_size_bytes)}
        />
        <MetricItem label={t('v2.detail.hash')} value={manifest.hash_algorithm} />
      </MetricStrip>

      <Surface>
        <SurfaceHeader>
          <SurfaceTitle>{t('v2.detail.snapshot')}</SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody>
          <KeyValueGrid>
            <KeyValueRow label={t('v2.datasets.ref')} value={requestedRef} />
            <KeyValueRow label={t('v2.datasets.version')}>
              <span className="break-all font-mono text-xs">{pinnedVersion}</span>
              <CopyTextButton label={t('v2.record.copy')} text={pinnedVersion} />
            </KeyValueRow>
            <KeyValueRow label={t('v2.detail.identity')} value={manifest.identity_profile} />
            <KeyValueRow label={t('v2.detail.columns')}>
              <div className="flex flex-wrap gap-1.5">
                {manifest.columns.map((column) => (
                  <Badge key={column}>{column}</Badge>
                ))}
              </div>
            </KeyValueRow>
          </KeyValueGrid>
          <details className="mt-5 border-border border-t pt-4">
            <summary className="cursor-pointer text-muted-foreground text-sm">
              {t('v2.detail.manifest')}
            </summary>
            <div className="mt-3">
              <JsonBlock value={manifest} />
            </div>
          </details>
        </SurfaceBody>
      </Surface>

      <Surface className="overflow-hidden">
        <SurfaceHeader>
          <SurfaceTitle>{t('v2.detail.records')}</SurfaceTitle>
        </SurfaceHeader>
        <VirtualizedRecords datasetVersion={pinnedVersion} />
      </Surface>
    </PageShell>
  )
}
