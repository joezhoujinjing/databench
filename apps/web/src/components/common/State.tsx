import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/errors.js'
import { Alert } from '@/components/ui/alert.js'
import { Skeleton } from '@/components/ui/skeleton.js'

export function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation()
  const text = label ?? t('common.loading')

  return (
    <div className="space-y-2 rounded-[5px] border border-border bg-surface p-4 text-muted-foreground text-sm">
      <Skeleton className="h-3 w-24" />
      <span>{text}</span>
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <Alert className="text-muted-foreground">{children}</Alert>
}

export function FeatureDisabled({ children }: { children?: ReactNode }) {
  const { t } = useTranslation()

  return <Alert className="text-muted-foreground">{children ?? t('common.featureDisabled')}</Alert>
}

export function ErrorState({ error }: { error: unknown }) {
  const { t } = useTranslation()

  return (
    <Alert className="border-danger/35 bg-danger/10 text-danger">
      <strong>{t('common.errorPrefix')}</strong> {messageForError(error, t('common.unknownError'))}
    </Alert>
  )
}

export function InlineError({ error }: { error: unknown }) {
  const { t } = useTranslation()
  const details = detailMessages(error)

  if (details.length === 0) {
    return (
      <div className="text-danger text-sm">{messageForError(error, t('common.unknownError'))}</div>
    )
  }

  return (
    <div className="space-y-1 text-danger text-sm">
      {details.map((message) => (
        <div key={message}>{message}</div>
      ))}
    </div>
  )
}

export function messageForError(error: unknown, unknownMessage = 'Unknown error'): string {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return error.message
    }

    return `${error.code} - ${error.message}`
  }

  if (error instanceof Error) {
    return error.message
  }

  return unknownMessage
}

export function detailMessages(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.status === 0) {
    return []
  }

  const detail = firstDetail(error.detail, error.body)
  return normalizeDetail(detail)
}

function firstDetail(...candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue
    }

    if (isRecord(candidate) && isRecord(candidate.error) && 'detail' in candidate.error) {
      return candidate.error.detail
    }

    if (isRecord(candidate) && 'detail' in candidate) {
      return candidate.detail
    }

    return candidate
  }

  return undefined
}

function normalizeDetail(detail: unknown): string[] {
  if (typeof detail === 'string' && detail.trim() !== '') {
    return [stripValueError(detail)]
  }

  if (!Array.isArray(detail)) {
    return []
  }

  return detail
    .map((item) => {
      if (isRecord(item) && typeof item.msg === 'string') {
        return item.msg
      }

      return typeof item === 'string' ? item : ''
    })
    .map(stripValueError)
    .filter(Boolean)
}

function stripValueError(message: string): string {
  return message.replace(/^Value error,\s*/u, '').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
