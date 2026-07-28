import { Database, RefreshCw, Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Badge, StatusDot } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js'
import { Field } from '@/components/ui/field.js'
import { SelectInput } from '@/components/ui/input.js'
import { formatInteger } from '@/lib/format.js'
import { useV2InspectExport, useV2Refs } from '@/v2/api/hooks.js'
import type { ExportPlanV2, RefMetadataV2 } from '@/v2/api/types.js'
import { FidelityReview, hasSemanticChanges } from '@/v2/components/export/FidelityReview.js'
import { V2MutationError } from '@/v2/components/V2MutationError.js'
import {
  useCloseSwiftStudioSession,
  useCreateSwiftStudioSession,
  useSwiftStudioSessions,
} from '../api/hooks.js'
import type { SwiftStudioSessionV2 } from '../api/sessions.js'

interface ExactDatasetSelection {
  readonly ref: string
  readonly version: string
}

export function StudioSessionControl({
  closeDisabled = false,
  onReadySessionChange,
}: {
  readonly closeDisabled?: boolean
  readonly onReadySessionChange: (session: SwiftStudioSessionV2 | null) => void
}) {
  const { t } = useTranslation()
  const refsQuery = useV2Refs(100)
  const sessions = useSwiftStudioSessions()
  const inspect = useV2InspectExport()
  const create = useCreateSwiftStudioSession()
  const close = useCloseSwiftStudioSession()
  const [selection, setSelection] = useState<ExactDatasetSelection | null>(null)
  const [plan, setPlan] = useState<ExportPlanV2 | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const refs = useMemo(
    () => refsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [refsQuery.data],
  )
  const active =
    sessions.data?.items.find(
      (session) =>
        session.status === 'preparing' ||
        session.status === 'ready' ||
        session.status === 'closing',
    ) ?? null
  const recentFailure = sessions.data?.items.find((session) => session.status === 'failed') ?? null
  const ready = active?.status === 'ready' ? active : null

  useEffect(() => onReadySessionChange(ready), [onReadySessionChange, ready])

  const chooseRef = (name: string) => {
    const ref = refs.find((item) => item.name === name)
    setSelection(ref === undefined ? null : { ref: ref.name, version: ref.version })
    setPlan(null)
    setConfirmed(false)
    inspect.reset()
    create.reset()
  }
  const inspectSelection = () => {
    if (selection === null) return
    inspect.mutate(
      {
        refOrVersion: selection.version,
        request: { converter: 'ms-swift', options: {} },
      },
      {
        onSuccess: (nextPlan) => {
          setPlan(nextPlan)
          setConfirmed(false)
        },
      },
    )
  }
  const createSession = () => {
    if (selection === null || plan === null || plan.output_count === 0) return
    if (hasSemanticChanges(plan) && !confirmed) return
    create.mutate({
      dataset_version: plan.dataset_version,
      display_ref: selection.ref,
      converter: 'ms-swift',
      options: {},
      accepted_fidelity_digest: plan.fidelity_digest,
    })
  }

  return (
    <Card className="bg-surface-soft/70">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>{t('training.sessionTitle')}</CardTitle>
          <p className="mt-2 text-muted-foreground text-sm leading-6">
            {t('training.sessionDescription')}
          </p>
        </div>
        <Button onClick={() => void sessions.refetch()} size="sm" type="button" variant="ghost">
          <RefreshCw aria-hidden="true" size={15} />
          {t('training.refreshSession')}
        </Button>
      </CardHeader>
      <CardContent>
        {sessions.isError ? <V2MutationError error={sessions.error} /> : null}
        {active !== null ? (
          <ActiveSession
            closeDisabled={closeDisabled}
            closePending={close.isPending}
            onClose={() => close.mutate(active.id)}
            session={active}
          />
        ) : (
          <>
            {recentFailure !== null ? (
              <Alert className="border-danger/35 bg-danger/10 text-danger">
                <strong className="block">{t('training.lastSessionFailed')}</strong>
                <span className="mt-1 block">
                  {recentFailure.failure?.message ?? t('training.sessionUnavailable')}
                </span>
              </Alert>
            ) : null}
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <Field
                hint={
                  selection === null
                    ? t('training.datasetHint')
                    : `${t('training.exactVersion')}: ${selection.version}`
                }
                label={t('training.dataset')}
              >
                <SelectInput
                  disabled={refsQuery.isLoading || create.isPending}
                  onValueChange={chooseRef}
                  options={[
                    { label: t('training.chooseDataset'), value: '' },
                    ...refs.map((ref) => refOption(ref)),
                  ]}
                  value={selection?.ref ?? ''}
                />
              </Field>
              <Button
                disabled={selection === null || inspect.isPending || create.isPending}
                onClick={inspectSelection}
                type="button"
                variant="outline"
              >
                <Database aria-hidden="true" size={16} />
                {inspect.isPending ? t('training.inspecting') : t('training.inspectDataset')}
              </Button>
            </div>
            {refsQuery.isError ? <V2MutationError error={refsQuery.error} /> : null}
            {inspect.isError ? <V2MutationError error={inspect.error} /> : null}
            {create.isError ? <V2MutationError error={create.error} /> : null}
            {plan !== null ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={plan.output_count > 0 ? 'green' : 'orange'}>
                    {t('training.outputRows', { count: formatInteger(plan.output_count) })}
                  </Badge>
                  <span className="text-muted-foreground">ms-swift 1.0.0</span>
                </div>
                <FidelityReview plan={plan} />
                {hasSemanticChanges(plan) ? (
                  <label className="flex items-start gap-3 text-sm leading-6">
                    <input
                      checked={confirmed}
                      className="mt-1 size-4 accent-primary"
                      onChange={(event) => setConfirmed(event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>{t('training.confirmFidelity')}</span>
                  </label>
                ) : null}
                {plan.output_count === 0 ? (
                  <Alert className="border-warning/35 bg-warning/10">
                    {t('training.emptyDataset')}
                  </Alert>
                ) : null}
                <Button
                  disabled={
                    create.isPending ||
                    plan.output_count === 0 ||
                    (hasSemanticChanges(plan) && !confirmed)
                  }
                  onClick={createSession}
                  type="button"
                >
                  {create.isPending ? t('training.preparingSession') : t('training.openSession')}
                </Button>
              </div>
            ) : null}
          </>
        )}
        {close.isError ? <V2MutationError error={close.error} /> : null}
      </CardContent>
    </Card>
  )
}

function ActiveSession({
  closeDisabled,
  closePending,
  onClose,
  session,
}: {
  readonly closeDisabled: boolean
  readonly closePending: boolean
  readonly onClose: () => void
  readonly session: SwiftStudioSessionV2
}) {
  const { t } = useTranslation()
  const ready = session.status === 'ready'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-[5px] border border-border bg-background/60 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium text-sm">
            <StatusDot tone={ready ? 'green' : 'amber'} />
            {t(`training.sessionStatus.${session.status}`)}
          </div>
          <p className="mt-2 text-muted-foreground text-xs">{session.display_ref ?? 'Dataset'}</p>
          <code className="mt-1 block break-all text-xs">{session.dataset_version}</code>
          <p className="mt-2 text-muted-foreground text-xs">
            {t('training.outputRows', { count: formatInteger(session.output_count) })}
          </p>
        </div>
        <Button
          disabled={closeDisabled || closePending || session.status === 'preparing'}
          onClick={onClose}
          size="sm"
          type="button"
          variant="outline"
        >
          <Square aria-hidden="true" size={14} />
          {closePending ? t('training.closingSession') : t('training.closeSession')}
        </Button>
      </div>
      {!ready ? (
        <Alert className="border-warning/35 bg-warning/10">
          {session.status === 'preparing'
            ? t('training.preparingNotice')
            : t('training.closingNotice')}
        </Alert>
      ) : null}
      {closeDisabled ? (
        <Alert className="border-warning/35 bg-warning/10">
          {t('training.artifacts.closeBlocked')}
        </Alert>
      ) : null}
    </div>
  )
}

function refOption(ref: RefMetadataV2) {
  return {
    label: `${ref.name} · ${ref.num_records}`,
    value: ref.name,
  }
}
