import { useQuery } from '@tanstack/react-query'
import { Expand, Minimize2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBackend } from '@/api/backend.js'
import { ApiError } from '@/api/errors.js'
import { ErrorState, FeatureDisabled, Spinner } from '@/components/common/State.js'
import { Alert } from '@/components/ui/alert.js'
import { StatusDot } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { getSwiftStudioRuntime, SwiftStudioRuntimeContractError } from '../api/client.js'
import type { SwiftStudioSessionV2 } from '../api/sessions.js'
import { ArtifactImportPanel, ModelArtifactLibrary } from '../components/ArtifactImportPanel.js'
import { StudioSessionControl } from '../components/StudioSessionControl.js'
import {
  isSwiftStudioFrameBooted,
  resolveSwiftStudioFrameLocation,
  shouldRenderSwiftStudioFrame,
  toggleSwiftStudioFullscreen,
} from '../domain/frame.js'

export function TrainingRoute() {
  const { t } = useTranslation()
  const { base, connectionScope, token } = useBackend()
  const [readySession, setReadySession] = useState<SwiftStudioSessionV2 | null>(null)
  const [artifactImportActive, setArtifactImportActive] = useState(false)
  const onReadySessionChange = useCallback(
    (session: SwiftStudioSessionV2 | null) => setReadySession(session),
    [],
  )
  const frameLocation = resolveSwiftStudioFrameLocation(
    base,
    typeof window === 'undefined' ? 'http://databench.invalid' : window.location.origin,
    token,
  )
  const runtimeQuery = useQuery({
    queryKey: [connectionScope, base, 'swift-studio', 'runtime'],
    queryFn: ({ signal }) => getSwiftStudioRuntime({ base, signal, token }),
    refetchInterval: (query) => {
      if (query.state.data?.ready === true) return 30_000
      if (query.state.data?.ready === false) return 3_000
      return false
    },
    retry: false,
  })
  const readyRuntime =
    runtimeQuery.isSuccess && runtimeQuery.data.ready ? runtimeQuery.data : undefined
  const runtimeReady = readyRuntime !== undefined
  const renderFrame =
    shouldRenderSwiftStudioFrame({
      frameLocation,
      querySucceeded: runtimeQuery.isSuccess,
      runtimeReady,
    }) && readySession !== null

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-border border-b pb-5">
        <div>
          <p className="font-medium text-primary text-xs uppercase tracking-[0.18em]">
            {t('training.eyebrow')}
          </p>
          <h1 className="mt-2 font-semibold text-3xl tracking-tight">{t('training.title')}</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
            {t('training.description')}
          </p>
        </div>
        <Button
          onClick={() => void runtimeQuery.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw aria-hidden="true" size={15} />
          {t('training.recheck')}
        </Button>
      </header>

      {runtimeQuery.isLoading ? <Spinner label={t('training.checking')} /> : null}
      {runtimeQuery.isError ? (
        <RuntimeError error={runtimeQuery.error} retry={() => void runtimeQuery.refetch()} />
      ) : null}
      {runtimeQuery.isSuccess && !runtimeQuery.data.ready ? (
        <StartingState retry={() => void runtimeQuery.refetch()} />
      ) : null}
      {runtimeReady ? (
        <StudioSessionControl
          closeDisabled={artifactImportActive}
          onReadySessionChange={onReadySessionChange}
        />
      ) : null}
      {runtimeReady && readySession !== null ? (
        <ArtifactImportPanel
          onImportActiveChange={setArtifactImportActive}
          session={readySession}
        />
      ) : null}
      {runtimeQuery.isSuccess ? <ModelArtifactLibrary /> : null}
      {runtimeReady && !frameLocation.supported ? (
        <Alert className="border-danger/35 bg-danger/10 text-danger">
          <strong className="block">
            {t(
              frameLocation.reason === 'bearer-token'
                ? 'training.bearerTitle'
                : 'training.sameOriginTitle',
            )}
          </strong>
          <span className="mt-1 block">
            {t(frameLocation.reason === 'bearer-token' ? 'training.bearer' : 'training.sameOrigin')}
          </span>
        </Alert>
      ) : null}
      {renderFrame && frameLocation.supported && readyRuntime !== undefined ? (
        <StudioFrame
          gpuAvailable={readyRuntime.gpu_available}
          runtimeLabel={`ms-swift ${readyRuntime.ms_swift_version} · Gradio ${readyRuntime.gradio_version} · Torch ${readyRuntime.torch_version}`}
          source={frameLocation.source}
        />
      ) : null}
      {runtimeReady && frameLocation.supported && readySession === null ? (
        <Alert className="border-border bg-surface-soft text-sm">
          <strong className="block">{t('training.sessionRequiredTitle')}</strong>
          <span className="mt-1 block text-muted-foreground">{t('training.sessionRequired')}</span>
        </Alert>
      ) : null}
    </section>
  )
}

function RuntimeError({ error, retry }: { error: unknown; retry(): void }) {
  const { t } = useTranslation()
  if (error instanceof ApiError && error.status === 404) {
    return (
      <FeatureDisabled>
        <strong className="block text-foreground">{t('training.disabledTitle')}</strong>
        <span className="mt-1 block">{t('training.disabled')}</span>
      </FeatureDisabled>
    )
  }
  if (error instanceof SwiftStudioRuntimeContractError) {
    return (
      <Alert className="border-danger/35 bg-danger/10 text-danger">
        <strong className="block">{t('training.incompatibleTitle')}</strong>
        <span className="mt-1 block">{t('training.incompatible')}</span>
      </Alert>
    )
  }
  return (
    <div className="space-y-3">
      <Alert className="border-danger/35 bg-danger/10 text-danger">
        <strong className="block">{t('training.unavailableTitle')}</strong>
        <span className="mt-1 block">{t('training.unavailable')}</span>
      </Alert>
      <ErrorState error={error} />
      <Button onClick={retry} size="sm" type="button" variant="outline">
        <RefreshCw aria-hidden="true" size={15} />
        {t('training.retry')}
      </Button>
    </div>
  )
}

function StartingState({ retry }: { retry(): void }) {
  const { t } = useTranslation()
  return (
    <Alert className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <strong className="block">{t('training.startingTitle')}</strong>
        <span className="mt-1 block text-muted-foreground">{t('training.starting')}</span>
      </div>
      <Button onClick={retry} size="sm" type="button" variant="outline">
        <RefreshCw aria-hidden="true" size={15} />
        {t('training.retry')}
      </Button>
    </Alert>
  )
}

function StudioFrame({
  gpuAvailable,
  runtimeLabel,
  source,
}: {
  gpuAvailable: boolean
  runtimeLabel: string
  source: string
}) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [frameGeneration, setFrameGeneration] = useState(0)
  const [frameState, setFrameState] = useState<'error' | 'loading' | 'ready'>('loading')
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState(false)
  const frameKey = useMemo(() => `${source}:${frameGeneration}`, [frameGeneration, source])

  useEffect(() => {
    const onFullscreenChange = () =>
      setFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])
  const toggleFullscreen = async (): Promise<void> => {
    setFullscreenError(false)
    const changed = await toggleSwiftStudioFullscreen(document, containerRef.current)
    setFullscreenError(!changed)
  }
  const onFrameLoad = (): void => {
    const frame = iframeRef.current
    if (frame === null) {
      setFrameState('error')
      return
    }
    try {
      const frameWindow = frame.contentWindow as
        | (Window & { readonly gradio_config?: unknown })
        | null
      const frameDocument = frame.contentDocument
      const booted = isSwiftStudioFrameBooted({
        appElementPresent:
          frameDocument !== null && frameDocument.querySelector('gradio-app') !== null,
        customElementRegistered: frameWindow?.customElements.get('gradio-app') !== undefined,
        gradioConfig: frameWindow?.gradio_config,
        origin: window.location.origin,
      })
      setFrameState(booted ? 'ready' : 'error')
    } catch {
      setFrameState('error')
    }
  }

  return (
    <div
      className={`overflow-hidden bg-background shadow-[0_20px_70px_rgba(0,0,0,0.18)] ${
        fullscreen
          ? 'flex h-dvh flex-col rounded-none border-0'
          : 'rounded-[6px] border border-border'
      }`}
      ref={containerRef}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-border border-b bg-surface-soft px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium text-sm">
            <StatusDot tone={gpuAvailable ? 'green' : 'amber'} />
            <span>{t('training.nativeStudio')}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              {gpuAvailable ? t('training.gpuReady') : t('training.gpuUnavailable')}
            </span>
          </div>
          <p className="mt-1 truncate text-muted-foreground text-xs">{runtimeLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              setFrameState('loading')
              setFrameGeneration((value) => value + 1)
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" size={15} />
            {t('training.reconnect')}
          </Button>
          <Button onClick={() => void toggleFullscreen()} size="sm" type="button" variant="ghost">
            {fullscreen ? (
              <Minimize2 aria-hidden="true" size={15} />
            ) : (
              <Expand aria-hidden="true" size={15} />
            )}
            {fullscreen ? t('training.exitFullscreen') : t('training.fullscreen')}
          </Button>
        </div>
      </div>
      {fullscreenError ? (
        <Alert className="m-3 border-warning/35 bg-warning/10 text-sm">
          {t('training.fullscreenFailed')}
        </Alert>
      ) : null}
      {!gpuAvailable ? (
        <Alert className="m-3 border-warning/35 bg-warning/10 text-sm">
          {t('training.gpuWarning')}
        </Alert>
      ) : null}
      <div
        className={`relative bg-white ${
          fullscreen ? 'min-h-0 flex-1' : 'h-[calc(100dvh-14rem)] min-h-[38rem]'
        }`}
      >
        {frameState === 'loading' ? (
          <div className="absolute inset-0 z-10 grid place-items-center bg-background/92">
            <Spinner label={t('training.loadingStudio')} />
          </div>
        ) : null}
        {frameState === 'error' ? (
          <div className="absolute inset-0 z-10 grid place-items-center bg-background p-8">
            <Alert className="max-w-xl border-danger/35 bg-danger/10 text-danger">
              {t('training.frameError')}
            </Alert>
          </div>
        ) : null}
        <iframe
          allow="clipboard-read; clipboard-write; fullscreen"
          className="h-full w-full border-0 bg-white"
          key={frameKey}
          onError={() => setFrameState('error')}
          onLoad={onFrameLoad}
          ref={iframeRef}
          referrerPolicy="same-origin"
          src={source}
          title={t('training.frameTitle')}
        />
      </div>
    </div>
  )
}
