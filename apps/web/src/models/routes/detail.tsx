import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft, Box, GitBranch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { ErrorState, Spinner } from '@/components/common/State.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.js'
import { formatDateTime } from '@/lib/format.js'
import { getModelV2, listModelAliasesV2, listModelVersionsV2 } from '@/models/api/registry.js'

export function ModelDetailRoute() {
  const { t } = useTranslation()
  const { modelId } = useParams({ from: '/models/$modelId' })
  const { base, connectionScope, token } = useBackend()
  const modelQuery = useQuery({
    queryKey: [connectionScope, base, 'model', modelId],
    queryFn: ({ signal }) => getModelV2({ base, modelId, signal, token }),
    retry: false,
  })
  const versionsQuery = useQuery({
    queryKey: [connectionScope, base, 'model-versions', modelId],
    queryFn: ({ signal }) =>
      listModelVersionsV2({ base, cursor: null, limit: 100, modelId, signal, token }),
    retry: false,
  })
  const aliasesQuery = useQuery({
    queryKey: [connectionScope, base, 'model-aliases', modelId],
    queryFn: ({ signal }) => listModelAliasesV2({ base, modelId, signal, token }),
    retry: false,
  })
  if (modelQuery.isLoading) return <Spinner label={t('models.loadingModel')} />
  if (modelQuery.isError) return <ErrorState error={modelQuery.error} />
  if (modelQuery.data === undefined) return <Spinner label={t('models.loadingModel')} />
  const model = modelQuery.data
  return (
    <section className="space-y-6">
      <header className="border-border border-b pb-5">
        <Button asChild size="sm" variant="ghost">
          <Link to="/models">
            <ArrowLeft aria-hidden="true" size={15} />
            {t('models.back')}
          </Link>
        </Button>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-semibold text-3xl tracking-tight">{model.display_name}</h1>
              {model.archived_at === null ? null : (
                <Badge tone="muted">{t('models.archiveArchived')}</Badge>
              )}
            </div>
            <p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
              {model.description || t('models.noDescription')}
            </p>
          </div>
          <div className="text-right text-dim-foreground text-xs">
            <p>{model.key}</p>
            <p className="mt-1">{formatDateTime(model.updated_at)}</p>
          </div>
        </div>
      </header>

      <dl className="grid grid-cols-4 gap-x-8 gap-y-4 border-border border-b pb-5 max-lg:grid-cols-2 max-sm:grid-cols-1">
        <Fact label={t('models.taskFamily')} value={model.task_family ?? '—'} />
        <Fact label={t('models.metadataRevision')} value={String(model.metadata_revision)} />
        <Fact label={t('models.tags')} value={model.tags.join(', ') || '—'} />
        <Fact
          label={t('models.aliases')}
          value={
            aliasesQuery.data?.items
              .map((item) => `${item.alias}: ${item.version_id}`)
              .join(', ') ?? '—'
          }
        />
      </dl>

      <section aria-labelledby="versions-title" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold" id="versions-title">
            <GitBranch aria-hidden="true" className="text-primary" size={18} />
            {t('models.versions')}
          </h2>
        </div>
        {versionsQuery.isLoading ? <Spinner label={t('models.loadingVersions')} /> : null}
        {versionsQuery.isError ? <ErrorState error={versionsQuery.error} /> : null}
        {versionsQuery.data?.items.length === 0 ? (
          <p className="border-border border-y py-10 text-center text-muted-foreground text-sm">
            {t('models.noVersions')}
          </p>
        ) : null}
        {versionsQuery.data !== undefined && versionsQuery.data.items.length > 0 ? (
          <TableContainer aria-label={t('models.versions')}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('models.version')}</TableHead>
                  <TableHead>{t('models.source')}</TableHead>
                  <TableHead>{t('models.verificationLabel')}</TableHead>
                  <TableHead>{t('models.baseModel')}</TableHead>
                  <TableHead>{t('models.created')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versionsQuery.data.items.map((version) => (
                  <TableRow key={version.id}>
                    <TableCell>
                      <Link
                        className="inline-flex items-center gap-2 font-medium hover:text-primary focus-visible:text-primary focus-visible:outline-none"
                        params={{ modelId, versionId: version.id }}
                        to="/models/$modelId/versions/$versionId"
                      >
                        <Box aria-hidden="true" size={15} />
                        {version.version_label}
                      </Link>
                    </TableCell>
                    <TableCell>{t(`models.sources.${version.source_kind}`)}</TableCell>
                    <TableCell>
                      <Badge
                        tone={
                          version.classification.verification_level === 'content_verified'
                            ? 'green'
                            : 'orange'
                        }
                      >
                        {t(`models.verification.${version.classification.verification_level}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>{version.base_model?.reference ?? '—'}</TableCell>
                    <TableCell>{formatDateTime(version.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : null}
      </section>
    </section>
  )
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-dim-foreground text-xs">{label}</dt>
      <dd className="mt-1 break-all text-sm">{value}</dd>
    </div>
  )
}
