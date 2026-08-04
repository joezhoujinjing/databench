import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { ErrorState, Spinner } from '@/components/common/State.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { formatDateTime } from '@/lib/format.js'
import { getModelV2, getModelVersionV2 } from '@/models/api/registry.js'

export function ModelVersionDetailRoute() {
  const { t } = useTranslation()
  const { modelId, versionId } = useParams({
    from: '/models/$modelId/versions/$versionId',
  })
  const { base, connectionScope, token } = useBackend()
  const modelQuery = useQuery({
    queryKey: [connectionScope, base, 'model', modelId],
    queryFn: ({ signal }) => getModelV2({ base, modelId, signal, token }),
    retry: false,
  })
  const versionQuery = useQuery({
    queryKey: [connectionScope, base, 'model-version', versionId],
    queryFn: ({ signal }) => getModelVersionV2({ base, signal, token, versionId }),
    retry: false,
  })
  if (modelQuery.isLoading || versionQuery.isLoading) {
    return <Spinner label={t('models.loadingVersion')} />
  }
  if (modelQuery.isError) return <ErrorState error={modelQuery.error} />
  if (versionQuery.isError) return <ErrorState error={versionQuery.error} />
  if (modelQuery.data === undefined || versionQuery.data === undefined) {
    return <Spinner label={t('models.loadingVersion')} />
  }
  const version = versionQuery.data
  if (version.model_id !== modelId) {
    return <ErrorState error={new Error(t('models.versionModelMismatch'))} />
  }
  return (
    <section className="space-y-6">
      <header className="border-border border-b pb-5">
        <Button asChild size="sm" variant="ghost">
          <Link params={{ modelId }} to="/models/$modelId">
            <ArrowLeft aria-hidden="true" size={15} />
            {modelQuery.data.display_name}
          </Link>
        </Button>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <h1 className="font-semibold text-3xl tracking-tight">{version.version_label}</h1>
          <Badge tone="accent">{t(`models.sources.${version.source_kind}`)}</Badge>
          <Badge
            tone={
              version.classification.verification_level === 'content_verified' ? 'green' : 'orange'
            }
          >
            {t(`models.verification.${version.classification.verification_level}`)}
          </Badge>
        </div>
        <p className="mt-2 text-dim-foreground text-xs">{version.id}</p>
      </header>

      <dl className="divide-y divide-border border-border border-y">
        <Fact label={t('models.created')} value={formatDateTime(version.created_at)} />
        <Fact label={t('models.sourceFingerprint')} value={version.source_fingerprint} mono />
        <Fact label={t('models.baseModel')} value={version.base_model?.reference ?? '—'} />
        <Fact label={t('models.baseRevision')} value={version.base_model?.revision ?? '—'} mono />
        <Fact label={t('models.bindingStatus')} value={version.base_model_binding_status ?? '—'} />
        {version.source.kind === 'databench_artifact' ? (
          <>
            <Fact label={t('models.artifactId')} value={version.source.artifact_id} mono />
            <Fact label={t('models.archiveDigest')} value={version.source.archive_digest} mono />
            <Fact label={t('models.manifestDigest')} value={version.source.manifest_digest} mono />
          </>
        ) : null}
      </dl>
    </section>
  )
}

function Fact({
  label,
  mono = false,
  value,
}: {
  readonly label: string
  readonly mono?: boolean
  readonly value: string
}) {
  return (
    <div className="grid grid-cols-[13rem_minmax(0,1fr)] gap-5 py-3 text-sm max-sm:grid-cols-1 max-sm:gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}
