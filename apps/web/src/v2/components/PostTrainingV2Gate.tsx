import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/common/State.js'
import { usePostTrainingV2State } from '../api/hooks.js'

export function PostTrainingV2Gate({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const state = usePostTrainingV2State()

  switch (state.status) {
    case 'ready':
      return children
    case 'loading':
      return <GateBlock title={t('v2.gate.loadingTitle')}>{t('v2.gate.loading')}</GateBlock>
    case 'absent':
      return <GateBlock title={t('v2.gate.absentTitle')}>{t('v2.gate.absent')}</GateBlock>
    case 'disabled':
      return <GateBlock title={t('v2.gate.disabledTitle')}>{t('v2.gate.disabled')}</GateBlock>
    case 'unauthorized':
      return (
        <GateBlock title={t('v2.gate.unauthorizedTitle')}>{t('v2.gate.unauthorized')}</GateBlock>
      )
    case 'forbidden':
      return <GateBlock title={t('v2.gate.forbiddenTitle')}>{t('v2.gate.forbidden')}</GateBlock>
    case 'network_error':
      return <GateBlock title={t('v2.gate.networkTitle')}>{t('v2.gate.network')}</GateBlock>
    case 'server_error':
      return (
        <GateBlock title={t('v2.gate.errorTitle')}>
          <ErrorState error={state.error} />
        </GateBlock>
      )
    case 'client_incompatible':
      return (
        <GateBlock title={t('v2.gate.incompatibleTitle')}>
          {t('v2.gate.clientIncompatible')}
        </GateBlock>
      )
    case 'incompatible':
      return (
        <GateBlock title={t('v2.gate.incompatibleTitle')}>
          <p>{t('v2.gate.incompatible')}</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 font-mono text-xs">
            {state.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </GateBlock>
      )
  }
}

function GateBlock({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="mx-auto max-w-3xl border-border border-y py-12">
      <div className="font-medium text-primary text-xs uppercase tracking-[0.16em]">V2</div>
      <h1 className="mt-3 font-semibold text-2xl">{title}</h1>
      <div className="mt-3 text-muted-foreground text-sm leading-6">{children}</div>
    </section>
  )
}
