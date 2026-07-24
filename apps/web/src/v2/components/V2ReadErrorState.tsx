import { Link } from '@tanstack/react-router'
import { ShieldAlert } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { isApiError } from '@/api/errors.js'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { ErrorState } from '@/components/common/State.js'
import { Button } from '@/components/ui/button.js'
import { useV2Audit } from '../api/hooks.js'

export type V2ReadErrorKind =
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'network'
  | 'validation'
  | 'integrity'
  | 'other'

export function V2ReadErrorState({
  error,
  identifier,
  onRetry,
}: {
  error: unknown
  identifier: string
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  const audit = useV2Audit(identifier)
  const kind = classifyV2ReadError(error)
  const requestId = isApiError(error) ? error.requestId : undefined
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])

  if (kind !== 'integrity') {
    return (
      <section className="space-y-4 border-border border-y py-8">
        <h2 className="font-semibold text-xl">{t(`v2.readError.${kind}Title`)}</h2>
        <p className="text-muted-foreground text-sm">{t(`v2.readError.${kind}`)}</p>
        <ErrorState error={error} />
        <div className="flex flex-wrap gap-2">
          {onRetry ? (
            <Button onClick={onRetry} type="button" variant="outline">
              {t('v2.readError.retry')}
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link to="/datasets">{t('v2.readError.back')}</Link>
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-5 border-danger/35 border-y bg-danger/5 px-5 py-8">
      <div className="flex items-start gap-3">
        <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0 text-danger" size={22} />
        <div>
          <h2 className="font-semibold text-xl">{t('v2.readError.integrityTitle')}</h2>
          <p className="mt-2 text-muted-foreground text-sm leading-6">
            {t('v2.readError.integrity')}
          </p>
        </div>
      </div>
      {requestId ? (
        <div className="flex items-center gap-2 font-mono text-xs">
          <span>
            {t('v2.readError.requestId')}: {requestId}
          </span>
          <CopyTextButton label={t('v2.readError.copyRequestId')} text={requestId} />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={audit.isPending}
          onClick={() => {
            controllerRef.current?.abort()
            const controller = new AbortController()
            controllerRef.current = controller
            audit.mutate(controller.signal, {
              onSettled: () => {
                if (controllerRef.current === controller) controllerRef.current = null
                if (controller.signal.aborted) audit.reset()
              },
            })
          }}
          type="button"
          variant="outline"
        >
          {audit.isPending ? t('v2.readError.auditing') : t('v2.readError.audit')}
        </Button>
        <Button asChild variant="outline">
          <Link to="/datasets">{t('v2.readError.back')}</Link>
        </Button>
      </div>
      {audit.isError ? <ErrorState error={audit.error} /> : null}
      {audit.data ? <JsonBlock value={audit.data} /> : null}
    </section>
  )
}

export function classifyV2ReadError(error: unknown): V2ReadErrorKind {
  if (!isApiError(error)) return 'other'
  if (error.code === 'integrity_error') return 'integrity'
  if (error.status === 401) return 'unauthorized'
  if (error.status === 403) return 'forbidden'
  if (error.status === 404) return 'not_found'
  if (error.status === 422) return 'validation'
  if (error.status === 0) return 'network'
  return 'other'
}
