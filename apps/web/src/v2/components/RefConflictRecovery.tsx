import { Link } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/errors.js'
import { Alert } from '@/components/ui/alert.js'
import { Button } from '@/components/ui/button.js'
import { KeyValueGrid, KeyValueRow } from '@/components/ui/surface.js'
import { useV2PutRef } from '../api/hooks.js'
import type { RefConflictDetailV2 } from '../api/types.js'

export function RefConflictRecovery({
  error,
  onResolved,
}: {
  error: unknown
  onResolved?(version: string): void
}) {
  const { t } = useTranslation()
  const move = useV2PutRef()
  const latestMoveConflict = readRefConflictDetail(move.error)
  const detail = latestMoveConflict ?? readRefConflictDetail(error)
  const alertRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => alertRef.current?.focus(), [])
  useEffect(() => () => controllerRef.current?.abort(), [])

  if (detail === null) return null

  return (
    <Alert
      className="space-y-4 border-warning/40 bg-warning/8"
      ref={alertRef}
      role="alert"
      tabIndex={-1}
    >
      <div>
        <div className="font-medium">{t('v2.conflict.title')}</div>
        <p className="mt-1 text-muted-foreground text-sm">{t('v2.conflict.description')}</p>
      </div>
      <KeyValueGrid>
        <KeyValueRow label={t('v2.conflict.ref')} value={detail.ref_name} />
        <KeyValueRow
          label={t('v2.conflict.expected')}
          value={<CodeValue value={detail.expected_version} />}
        />
        <KeyValueRow
          label={t('v2.conflict.current')}
          value={<CodeValue value={detail.current_version} />}
        />
        <KeyValueRow
          label={t('v2.conflict.generated')}
          value={<CodeValue value={detail.new_version} />}
        />
      </KeyValueGrid>
      <div className="flex flex-wrap gap-2">
        {detail.current_version === null ? null : (
          <Button asChild size="sm" variant="outline">
            <Link params={{ ref: detail.current_version }} to="/datasets/$ref">
              {t('v2.conflict.viewCurrent')}
            </Link>
          </Button>
        )}
        {detail.new_dataset_committed ? (
          <Button asChild size="sm" variant="outline">
            <Link params={{ ref: detail.new_version }} to="/datasets/$ref">
              {t('v2.conflict.keepGenerated')}
            </Link>
          </Button>
        ) : null}
        <Button
          disabled={move.isPending}
          onClick={() => {
            controllerRef.current?.abort()
            const controller = new AbortController()
            controllerRef.current = controller
            move.mutate(
              {
                name: detail.ref_name,
                request: {
                  expected_version: detail.current_version,
                  message: null,
                  new_version: detail.new_version,
                },
                signal: controller.signal,
              },
              {
                onSuccess: () => {
                  if (!controller.signal.aborted) onResolved?.(detail.new_version)
                },
                onSettled: () => {
                  if (controllerRef.current === controller) controllerRef.current = null
                  if (controller.signal.aborted) move.reset()
                },
              },
            )
          }}
          size="sm"
          type="button"
        >
          {move.isPending ? t('v2.conflict.moving') : t('v2.conflict.reconfirm')}
        </Button>
      </div>
      {move.isError && latestMoveConflict === null ? (
        <div className="text-danger text-sm">{move.error.message}</div>
      ) : null}
    </Alert>
  )
}

function CodeValue({ value }: { value: string | null }) {
  const { t } = useTranslation()
  return <code className="break-all text-xs">{value ?? t('v2.common.none')}</code>
}

export function readRefConflictDetail(error: unknown): RefConflictDetailV2 | null {
  if (!(error instanceof ApiError) || error.code !== 'ref_conflict' || !isRecord(error.detail)) {
    return null
  }
  const value = error.detail
  if (
    typeof value.ref_name !== 'string' ||
    typeof value.new_version !== 'string' ||
    typeof value.new_dataset_committed !== 'boolean' ||
    (value.current_version !== null && typeof value.current_version !== 'string') ||
    (value.expected_version !== null && typeof value.expected_version !== 'string')
  ) {
    return null
  }
  return value as RefConflictDetailV2
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
