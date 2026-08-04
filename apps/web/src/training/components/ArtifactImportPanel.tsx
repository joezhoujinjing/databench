import { Link } from '@tanstack/react-router'
import { Download, PackageCheck, PackagePlus, RefreshCw, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { Alert } from '@/components/ui/alert.js'
import { Badge, StatusDot } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js'
import { Field } from '@/components/ui/field.js'
import { SelectInput, TextInput } from '@/components/ui/input.js'
import { ellipsizeMiddle, formatInteger } from '@/lib/format.js'
import { ModelDeploymentPanel } from '@/models/components/ModelDeploymentPanel.js'
import { V2MutationError } from '@/v2/components/V2MutationError.js'
import {
  chooseModelArtifactDownloadTarget,
  downloadModelArtifactV2,
  type ModelArtifactImportV2,
  type ModelArtifactV2,
  type SwiftStudioOutputCandidateV2,
} from '../api/artifacts.js'
import {
  isArtifactImportActive,
  useCreateModelArtifactImport,
  useModelArtifact,
  useModelArtifactImport,
  useModelArtifacts,
  useSwiftStudioOutputs,
} from '../api/hooks.js'
import type { SwiftStudioSessionV2 } from '../api/sessions.js'

export function ArtifactImportPanel({
  onImportActiveChange,
  session,
}: {
  readonly onImportActiveChange: (active: boolean) => void
  readonly session: SwiftStudioSessionV2
}) {
  const { t } = useTranslation()
  const { base } = useBackend()
  const importStorageKey = useMemo(
    () => activeImportStorageKey(base, session.id),
    [base, session.id],
  )
  const outputs = useSwiftStudioOutputs(session.id)
  const create = useCreateModelArtifactImport()
  const artifacts = useModelArtifacts()
  const [selectedHandle, setSelectedHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseModelReference, setBaseModelReference] = useState('')
  const [baseModelRevision, setBaseModelRevision] = useState('')
  const [importId, setImportId] = useState<string | null>(() =>
    readActiveImportId(importStorageKey),
  )
  const artifactImportQuery = useModelArtifactImport(importId)
  const artifactImport = artifactImportQuery.data
  const artifactId = artifactImport?.artifact_id ?? null
  const artifactQuery = useModelArtifact(artifactId)
  const importableOutputs = useMemo(
    () => outputs.data?.items.filter(isImportableOutput) ?? [],
    [outputs.data],
  )
  const blockedOutputs = useMemo(
    () => outputs.data?.items.filter((candidate) => !candidate.importable) ?? [],
    [outputs.data],
  )
  const selectedOutput = importableOutputs.find((candidate) => candidate.handle === selectedHandle)
  const importActive =
    create.isPending ||
    (importId !== null && (artifactImport === undefined || isArtifactImportActive(artifactImport)))

  useEffect(() => {
    const first = importableOutputs[0]
    if (selectedOutput !== undefined || first === undefined) return
    setSelectedHandle(first.handle)
    setDisplayName(first.display_name)
  }, [importableOutputs, selectedOutput])

  useEffect(() => {
    onImportActiveChange(importActive)
    return () => onImportActiveChange(false)
  }, [importActive, onImportActiveChange])

  useEffect(() => {
    if (artifactImport?.status === 'completed') void artifacts.refetch()
  }, [artifactImport?.status, artifacts.refetch])

  useEffect(() => {
    if (importId === null) {
      removeActiveImportId(importStorageKey)
      return
    }
    if (artifactImport?.status === 'completed' || artifactImport?.status === 'failed') {
      removeActiveImportId(importStorageKey)
      return
    }
    writeActiveImportId(importStorageKey, importId)
  }, [artifactImport?.status, importId, importStorageKey])

  const chooseOutput = (handle: string) => {
    setSelectedHandle(handle)
    const candidate = importableOutputs.find((item) => item.handle === handle)
    if (candidate !== undefined) setDisplayName(candidate.display_name)
    create.reset()
  }

  const startImport = () => {
    if (selectedOutput === undefined) return
    const reference = baseModelReference.trim()
    const name = displayName.trim()
    if (reference === '' || name === '') return
    create.mutate(
      {
        artifact_kind: 'lora_adapter',
        base_model: {
          reference,
          revision: baseModelRevision.trim() === '' ? null : baseModelRevision.trim(),
        },
        display_name: name,
        output_handle: selectedOutput.handle,
        studio_session_id: session.id,
      },
      {
        onSuccess: (created) => {
          writeActiveImportId(importStorageKey, created.id)
          setImportId(created.id)
        },
      },
    )
  }

  const resetImport = () => {
    removeActiveImportId(importStorageKey)
    setImportId(null)
    create.reset()
  }

  return (
    <Card className="bg-surface-soft/70">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>{t('training.artifacts.title')}</CardTitle>
          <p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
            {t('training.artifacts.description')}
          </p>
        </div>
        <Button
          disabled={outputs.isFetching || importActive}
          onClick={() => void outputs.refetch()}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={15} />
          {t('training.artifacts.refreshOutputs')}
        </Button>
      </CardHeader>
      <CardContent>
        {outputs.isError ? <V2MutationError error={outputs.error} /> : null}
        {outputs.isLoading ? (
          <p className="text-muted-foreground text-sm">{t('training.artifacts.loadingOutputs')}</p>
        ) : null}
        {outputs.isSuccess && outputs.data.items.length === 0 ? (
          <Alert className="border-border bg-background/45 text-sm">
            {t('training.artifacts.noOutputs')}
          </Alert>
        ) : null}

        {importId === null ? (
          <div className="space-y-4">
            {importableOutputs.length > 0 ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <Field
                  hint={
                    selectedOutput === undefined
                      ? t('training.artifacts.outputHint')
                      : t('training.artifacts.outputSize', {
                          size: formatBytes(selectedOutput.size_bytes),
                        })
                  }
                  label={t('training.artifacts.output')}
                >
                  <SelectInput
                    disabled={create.isPending}
                    onValueChange={chooseOutput}
                    options={importableOutputs.map((candidate) => ({
                      label: `${candidate.display_name} · ${formatBytes(candidate.size_bytes)}`,
                      value: candidate.handle,
                    }))}
                    value={selectedHandle}
                  />
                </Field>
                <Field
                  hint={t('training.artifacts.displayNameHint')}
                  label={t('training.artifacts.displayName')}
                >
                  <TextInput
                    disabled={create.isPending}
                    maxLength={256}
                    onChange={(event) => setDisplayName(event.currentTarget.value)}
                    value={displayName}
                  />
                </Field>
                <Field
                  hint={t('training.artifacts.baseModelHint')}
                  label={t('training.artifacts.baseModel')}
                >
                  <TextInput
                    autoComplete="off"
                    disabled={create.isPending}
                    maxLength={512}
                    onChange={(event) => setBaseModelReference(event.currentTarget.value)}
                    placeholder="Qwen/Qwen3-0.6B"
                    value={baseModelReference}
                  />
                </Field>
                <Field
                  hint={t('training.artifacts.baseRevisionHint')}
                  label={t('training.artifacts.baseRevision')}
                >
                  <TextInput
                    autoComplete="off"
                    disabled={create.isPending}
                    maxLength={256}
                    onChange={(event) => setBaseModelRevision(event.currentTarget.value)}
                    placeholder={t('training.artifacts.baseRevisionPlaceholder')}
                    value={baseModelRevision}
                  />
                </Field>
              </div>
            ) : null}

            {blockedOutputs.length > 0 ? (
              <div className="rounded-[5px] border border-border bg-background/45 p-4">
                <p className="font-medium text-sm">{t('training.artifacts.blockedTitle')}</p>
                <ul className="mt-2 space-y-2 text-muted-foreground text-xs">
                  {blockedOutputs.map((candidate, index) => (
                    <li
                      className="flex items-start justify-between gap-4"
                      key={blockedKey(candidate, index)}
                    >
                      <span>{candidate.display_name}</span>
                      <span className="text-right">
                        {candidate.reason ?? t('training.artifacts.notImportable')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {create.isError ? <V2MutationError error={create.error} /> : null}
            {importableOutputs.length > 0 ? (
              <Button
                disabled={
                  create.isPending ||
                  selectedOutput === undefined ||
                  displayName.trim() === '' ||
                  baseModelReference.trim() === ''
                }
                onClick={startImport}
                type="button"
              >
                <Upload aria-hidden="true" size={16} />
                {create.isPending
                  ? t('training.artifacts.startingImport')
                  : t('training.artifacts.startImport')}
              </Button>
            ) : null}
          </div>
        ) : (
          <ImportStatus
            artifact={artifactQuery.data}
            artifactError={artifactQuery.error}
            artifactImport={artifactImport}
            importError={artifactImportQuery.error}
            importFetching={artifactImportQuery.isFetching}
            onRefresh={() => void artifactImportQuery.refetch()}
            onReset={resetImport}
          />
        )}
      </CardContent>
    </Card>
  )
}

export function ModelArtifactLibrary() {
  const artifacts = useModelArtifacts()
  return (
    <Card className="bg-surface-soft/70">
      <CardContent>
        <RecentArtifacts
          artifacts={artifacts.data?.items ?? []}
          error={artifacts.error}
          loading={artifacts.isLoading}
          onRefresh={() => void artifacts.refetch()}
        />
      </CardContent>
    </Card>
  )
}

function ImportStatus({
  artifact,
  artifactError,
  artifactImport,
  importError,
  importFetching,
  onRefresh,
  onReset,
}: {
  readonly artifact: ModelArtifactV2 | undefined
  readonly artifactError: unknown
  readonly artifactImport: ModelArtifactImportV2 | undefined
  readonly importError: unknown
  readonly importFetching: boolean
  readonly onRefresh: () => void
  readonly onReset: () => void
}) {
  const { t } = useTranslation()

  if (importError !== null) {
    return (
      <div className="space-y-3">
        <V2MutationError error={importError} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={onRefresh} size="sm" type="button" variant="outline">
            <RefreshCw aria-hidden="true" size={15} />
            {t('training.artifacts.refreshImport')}
          </Button>
          <Button onClick={onReset} size="sm" type="button" variant="ghost">
            {t('training.artifacts.importAnother')}
          </Button>
        </div>
      </div>
    )
  }

  if (artifactImport === undefined) {
    return <p className="text-muted-foreground text-sm">{t('training.artifacts.loadingImport')}</p>
  }

  const terminal = artifactImport.status === 'completed' || artifactImport.status === 'failed'
  return (
    <div className="space-y-4 rounded-[5px] border border-border bg-background/55 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 font-medium text-sm">
            <StatusDot
              tone={artifactImport.status === 'failed' ? 'red' : terminal ? 'green' : 'amber'}
            />
            {t(`training.artifacts.importStatus.${artifactImport.status}`)}
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            {t('training.artifacts.importId')}: {artifactImport.id}
          </p>
        </div>
        <Button
          disabled={importFetching}
          onClick={onRefresh}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={15} />
          {t('training.artifacts.refreshImport')}
        </Button>
      </div>
      {artifactImport.failure !== null ? (
        <Alert className="border-danger/35 bg-danger/10 text-danger">
          <strong className="block">{artifactImport.failure.code}</strong>
          <span className="mt-1 block">{artifactImport.failure.message}</span>
        </Alert>
      ) : null}
      {artifactImport.status === 'completed' && artifact === undefined && artifactError === null ? (
        <p className="text-muted-foreground text-sm">{t('training.artifacts.loadingArtifact')}</p>
      ) : null}
      {artifactError !== null ? <V2MutationError error={artifactError} /> : null}
      {artifact !== undefined ? <ArtifactDetail artifact={artifact} /> : null}
      {terminal ? (
        <Button onClick={onReset} type="button" variant="outline">
          {t('training.artifacts.importAnother')}
        </Button>
      ) : (
        <Alert className="border-warning/35 bg-warning/10 text-sm">
          {t('training.artifacts.keepSessionOpen')}
        </Alert>
      )}
    </div>
  )
}

function ArtifactDetail({ artifact }: { readonly artifact: ModelArtifactV2 }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3 border-border border-t pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PackageCheck aria-hidden="true" className="text-success" size={18} />
            <strong>{artifact.display_name}</strong>
            <Badge tone="accent">LoRA</Badge>
          </div>
          <p className="mt-2 text-muted-foreground text-xs">{artifact.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link search={{ artifact: artifact.id }} to="/models">
              <PackagePlus aria-hidden="true" size={15} />
              {t('training.artifacts.registerModel')}
            </Link>
          </Button>
          <ArtifactDownloadButton artifact={artifact} variant="outline" />
        </div>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <ArtifactFact
          label={t('training.artifacts.lineage')}
          value={t(`training.artifacts.lineageStatus.${artifact.dataset_lineage.status}`)}
        />
        <ArtifactFact
          label={t('training.artifacts.baseModel')}
          value={artifact.base_model.reference}
        />
        <ArtifactFact
          label={t('training.artifacts.archiveSize')}
          value={formatBytes(artifact.archive_size_bytes)}
        />
        <ArtifactFact
          label={t('training.artifacts.files')}
          value={formatInteger(artifact.manifest.files.length)}
        />
      </dl>
      <p className="break-all text-dim-foreground text-xs">
        BLAKE3 {ellipsizeMiddle(artifact.archive_digest, 14)}
      </p>
      <ModelDeploymentPanel artifact={artifact} />
    </div>
  )
}

function RecentArtifacts({
  artifacts,
  error,
  loading,
  onRefresh,
}: {
  readonly artifacts: readonly ModelArtifactV2[]
  readonly error: unknown
  readonly loading: boolean
  readonly onRefresh: () => void
}) {
  const { t } = useTranslation()
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId)
  return (
    <div className="space-y-3 border-border border-t pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium text-sm">{t('training.artifacts.recent')}</h3>
        <Button onClick={onRefresh} size="sm" type="button" variant="ghost">
          <RefreshCw aria-hidden="true" size={14} />
          {t('training.artifacts.refreshArtifacts')}
        </Button>
      </div>
      {error !== null ? <V2MutationError error={error} /> : null}
      {loading ? (
        <p className="text-muted-foreground text-sm">{t('training.artifacts.loadingArtifacts')}</p>
      ) : null}
      {!loading && error === null && artifacts.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('training.artifacts.noArtifacts')}</p>
      ) : null}
      {artifacts.length > 0 ? (
        <ul className="divide-y divide-border rounded-[5px] border border-border bg-background/45">
          {artifacts.map((artifact) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              key={artifact.id}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <button
                    aria-expanded={selectedArtifactId === artifact.id}
                    className="truncate font-semibold hover:text-primary"
                    onClick={() =>
                      setSelectedArtifactId((current) =>
                        current === artifact.id ? null : artifact.id,
                      )
                    }
                    type="button"
                  >
                    {artifact.display_name}
                  </button>
                  <Badge tone={artifact.dataset_lineage.status === 'verified' ? 'green' : 'orange'}>
                    {t(`training.artifacts.lineageStatus.${artifact.dataset_lineage.status}`)}
                  </Badge>
                </div>
                <p className="mt-1 text-dim-foreground text-xs">
                  {formatBytes(artifact.archive_size_bytes)} · {formatDate(artifact.created_at)}
                </p>
              </div>
              <ArtifactDownloadButton artifact={artifact} variant="ghost" />
            </li>
          ))}
        </ul>
      ) : null}
      {selectedArtifact === undefined ? null : <ArtifactDetail artifact={selectedArtifact} />}
    </div>
  )
}

function ArtifactDownloadButton({
  artifact,
  variant,
}: {
  readonly artifact: ModelArtifactV2
  readonly variant: 'ghost' | 'outline'
}) {
  const { t } = useTranslation()
  const { base, token } = useBackend()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const start = async () => {
    setError(null)
    try {
      const target = await chooseModelArtifactDownloadTarget(artifact)
      setPending(true)
      await downloadModelArtifactV2({ artifact, base, target, token })
    } catch (nextError) {
      if (!(nextError instanceof DOMException && nextError.name === 'AbortError')) {
        setError(nextError)
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-2">
      <Button
        disabled={pending}
        onClick={() => void start()}
        size="sm"
        type="button"
        variant={variant}
      >
        <Download aria-hidden="true" size={15} />
        {pending ? `${t('training.artifacts.download')}…` : t('training.artifacts.download')}
      </Button>
      {error === null ? null : <V2MutationError error={error} />}
    </div>
  )
}

function ArtifactFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-dim-foreground text-xs">{label}</dt>
      <dd className="mt-1 break-words text-foreground">{value}</dd>
    </div>
  )
}

function isImportableOutput(
  candidate: SwiftStudioOutputCandidateV2,
): candidate is SwiftStudioOutputCandidateV2 & { handle: string } {
  return candidate.importable && candidate.handle !== null
}

function blockedKey(candidate: SwiftStudioOutputCandidateV2, index: number): string {
  return `${candidate.display_name}:${candidate.modified_at}:${index}`
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1_024) return `${formatInteger(value)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const
  let amount = value / 1_024
  let unit: (typeof units)[number] = units[0]
  for (let index = 1; index < units.length && amount >= 1_024; index += 1) {
    amount /= 1_024
    unit = units[index] ?? unit
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

const MODEL_ARTIFACT_IMPORT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function activeImportStorageKey(base: string, sessionId: string): string {
  return `databench.swift-studio.active-artifact-import.v1:${base}:${sessionId}`
}

function readActiveImportId(key: string): string | null {
  try {
    const value = globalThis.sessionStorage?.getItem(key) ?? null
    if (value === null || MODEL_ARTIFACT_IMPORT_ID.test(value)) return value
    globalThis.sessionStorage?.removeItem(key)
  } catch {
    return null
  }
  return null
}

function writeActiveImportId(key: string, importId: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, importId)
  } catch {
    // Import reconciliation still continues in the current page when storage is unavailable.
  }
}

function removeActiveImportId(key: string): void {
  try {
    globalThis.sessionStorage?.removeItem(key)
  } catch {
    // A disabled storage backend must not block the import lifecycle.
  }
}
