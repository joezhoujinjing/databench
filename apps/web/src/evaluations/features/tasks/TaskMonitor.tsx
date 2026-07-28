import { CheckCircle2, Loader2, OctagonX, Square, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/components/ui/alert.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { SafeReportLink } from '../../components/SafeReportLink.js'
import type { TaskRunnerState } from '../../domain/tasks/state.js'

export function TaskMonitor({
  onStop,
  state,
}: {
  readonly onStop: () => Promise<void>
  readonly state: TaskRunnerState
}) {
  const { t } = useTranslation()
  const active = state.phase === 'running' || state.phase === 'stopping'

  return (
    <div className="space-y-4">
      <div aria-live="polite" className="flex min-h-8 flex-wrap items-center gap-2 text-sm">
        {state.phase === 'idle' ? (
          <span className="text-muted-foreground">{t('evaluations.tasks.ready')}</span>
        ) : null}
        {active ? (
          <>
            <Loader2 aria-hidden="true" className="animate-spin text-primary" size={16} />
            <Badge tone="orange">
              {state.phase === 'stopping'
                ? t('evaluations.tasks.stopping')
                : t('evaluations.tasks.running', { progress: Math.round(state.progress) })}
            </Badge>
          </>
        ) : null}
        {state.phase === 'completed' ? (
          <>
            <CheckCircle2 aria-hidden="true" className="text-success" size={16} />
            <Badge tone="green">{t('evaluations.tasks.completed')}</Badge>
          </>
        ) : null}
        {state.phase === 'failed' ? (
          <>
            <XCircle aria-hidden="true" className="text-danger" size={16} />
            <Badge className="border-danger/45 bg-danger/10 text-danger" tone="muted">
              {t('evaluations.tasks.failed')}
            </Badge>
          </>
        ) : null}
        {state.phase === 'cancelled' ? (
          <>
            <OctagonX aria-hidden="true" className="text-warning" size={16} />
            <Badge tone="orange">{t('evaluations.tasks.cancelled')}</Badge>
          </>
        ) : null}
      </div>

      {state.taskId !== null ? (
        <div className="break-all font-mono text-dim-foreground text-xs">{state.taskId}</div>
      ) : null}

      {active || state.phase === 'completed' ? (
        <div
          aria-label={t('evaluations.tasks.progress')}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(state.progress)}
          className="h-1.5 overflow-hidden rounded-full bg-background"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${Math.max(0, Math.min(100, state.progress))}%` }}
          />
        </div>
      ) : null}

      {active ? (
        <Button
          className="border-danger/50 text-danger hover:bg-danger/10"
          disabled={state.phase === 'stopping'}
          onClick={() => void onStop()}
          size="sm"
          type="button"
          variant="outline"
        >
          <Square aria-hidden="true" size={14} />
          {t('evaluations.common.stop')}
        </Button>
      ) : null}

      {state.resumed && active ? <Alert>{t('evaluations.tasks.resumed')}</Alert> : null}
      {state.degradedMessage !== null ? (
        <Alert className="border-warning/40 bg-warning/8" role="status">
          <div className="font-medium">{t('evaluations.tasks.pollingDegraded')}</div>
          <div className="mt-1 text-sm">{state.degradedMessage}</div>
        </Alert>
      ) : null}
      {state.error !== null ? (
        <Alert className="border-danger/35 bg-danger/10" role="alert">
          <div>{state.error.message}</div>
          {state.error.code === undefined ? null : (
            <code className="mt-2 block text-xs">{state.error.code}</code>
          )}
        </Alert>
      ) : null}

      {state.logText !== '' ? (
        <section>
          <h3 className="mb-2 font-medium text-muted-foreground text-sm">
            {t('evaluations.tasks.logs')}
          </h3>
          <pre
            aria-live="polite"
            className="max-h-80 overflow-auto rounded-[6px] border border-border bg-code p-4 whitespace-pre-wrap font-mono text-xs leading-6"
          >
            {state.logText}
          </pre>
        </section>
      ) : null}

      {state.document !== null ? (
        <SafeReportLink document={state.document}>
          {t('evaluations.common.openNewTab')}
        </SafeReportLink>
      ) : null}
    </div>
  )
}
