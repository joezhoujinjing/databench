import { ChevronDown, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { useCapabilities } from '@/api/capabilities.js'
import { DEFAULT_API_BASE } from '@/api/config.js'
import { isApiError } from '@/api/errors.js'
import { StatusDot } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { TextInput } from '@/components/ui/input.js'
import { cn } from '@/lib/utils.js'

export function ConnectionPanel() {
  const { t } = useTranslation()
  const { base, setConnection, token } = useBackend()
  const { capabilities, error, health, isError, isHealthLoading, isLoading, refetch, version } =
    useCapabilities()
  const [open, setOpen] = useState(false)
  const [baseDraft, setBaseDraft] = useState(base)
  const [tokenDraft, setTokenDraft] = useState(token)
  const status = isError
    ? 'disconnected'
    : capabilities === undefined || health === undefined || isLoading || isHealthLoading
      ? 'checking'
      : 'connected'

  useEffect(() => {
    if (!open) {
      setBaseDraft(base)
      setTokenDraft(token)
    }
  }, [base, open, token])

  return (
    <div className="relative">
      <Button
        aria-label={t('connection.configure')}
        aria-expanded={open}
        className="px-2.5"
        onClick={() => setOpen((value) => !value)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <StatusDot
          tone={status === 'connected' ? 'green' : status === 'checking' ? 'amber' : 'red'}
        />
        <span>{t(`health.${status}`)}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </Button>

      {open ? (
        <div className="absolute right-0 z-20 mt-3 w-[24rem] rounded-[5px] border border-border bg-surface-raised p-4 text-sm shadow-2xl">
          <div className="space-y-3">
            <div className="block space-y-1">
              <span className="font-medium">{t('connection.apiBaseLabel')}</span>
              <TextInput
                aria-label={t('connection.apiBaseLabel')}
                onChange={(event) => setBaseDraft(event.target.value)}
                placeholder={t('connection.apiBasePlaceholder')}
                value={baseDraft}
              />
              <span className="text-muted-foreground text-xs">{t('connection.apiBaseHint')}</span>
            </div>

            <div className="block space-y-1">
              <span className="font-medium">{t('connection.tokenLabel')}</span>
              <TextInput
                aria-label={t('connection.tokenLabel')}
                autoComplete="off"
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder={t('connection.tokenPlaceholder')}
                type="password"
                value={tokenDraft}
              />
              <span className="text-muted-foreground text-xs">{t('connection.tokenHint')}</span>
            </div>

            <div className="rounded-[5px] border border-border bg-background p-3 text-muted-foreground">
              <div>
                {t('connection.apiVersion')}: {capabilities?.api_version ?? 'unknown'}
              </div>
              <div>
                {t('connection.serviceVersion')}: {version?.service_version ?? 'unknown'}
              </div>
              <div>
                {t('connection.schemaVersion')}: {version?.schema_version ?? 'unknown'}
              </div>
              <div>health {health?.status ?? 'unknown'}</div>
              {isError ? <div className="mt-1 text-danger">{errorLabel(error)}</div> : null}
            </div>

            {capabilities !== undefined ? (
              <div className="flex flex-wrap gap-1">
                {Object.entries(capabilities.features).map(([name, enabled]) => (
                  <span
                    className={cn(
                      'rounded border border-border px-1.5 py-0.5 text-xs',
                      enabled ? 'text-foreground' : 'text-muted-foreground line-through',
                    )}
                    key={name}
                  >
                    {name}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="flex justify-between gap-2">
              <Button
                onClick={() => {
                  setBaseDraft(DEFAULT_API_BASE)
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t('connection.reset')}
              </Button>
              <div className="flex gap-2">
                <Button onClick={() => refetch()} size="sm" type="button" variant="ghost">
                  {t('common.load')}
                </Button>
                <Button
                  onClick={() => {
                    setConnection(baseDraft, tokenDraft)
                    setOpen(false)
                  }}
                  size="sm"
                  type="button"
                >
                  <Settings aria-hidden="true" size={14} />
                  {t('common.apply')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function errorLabel(error: unknown): string {
  if (isApiError(error)) {
    return `${error.code}: ${error.message}`
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'unreachable'
}
