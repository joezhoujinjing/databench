import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useCapabilities } from '@/api/capabilities.js'
import { isApiError } from '@/api/errors.js'

export function CapabilityGate({ children }: { children: ReactNode }) {
  const { compatibility, error, isError, isLoading } = useCapabilities()
  const { t } = useTranslation()

  if (isLoading) {
    return <GateBlock title={t('gate.connectingTitle')}>{t('gate.connecting')}</GateBlock>
  }

  if (isError) {
    return (
      <GateBlock title={t('gate.cannotConnectTitle')}>
        <div>{errorMessage(error, t('connection.unreachable'))}</div>
        <div>{t('gate.cannotConnectHint')}</div>
      </GateBlock>
    )
  }

  if (compatibility.status === 'client_too_old') {
    return (
      <GateBlock title={t('gate.incompatibleTitle')}>
        <div>
          {t('gate.clientTooOld', {
            current: compatibility.currentClient,
            min: compatibility.minClient,
          })}
        </div>
        <div>{t('gate.incompatibleHint')}</div>
      </GateBlock>
    )
  }

  if (compatibility.status === 'api_unsupported') {
    return (
      <GateBlock title={t('gate.incompatibleTitle')}>
        <div>{t('gate.apiUnsupported', { api: compatibility.apiVersion })}</div>
        <div>{t('gate.incompatibleHint')}</div>
      </GateBlock>
    )
  }

  return children
}

function GateBlock({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="rounded-[5px] border border-border bg-surface p-6">
      <h1 className="font-semibold text-xl">{title}</h1>
      <div className="mt-2 text-muted-foreground text-sm">{children}</div>
    </section>
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    return `${error.code}: ${error.message}`
  }

  if (error instanceof Error) {
    return error.message
  }

  return fallback
}
