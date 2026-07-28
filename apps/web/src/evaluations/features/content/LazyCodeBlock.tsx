import { Check, Copy } from 'lucide-react'
import { type ComponentType, type CSSProperties, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

type HighlighterModule = {
  readonly SyntaxHighlighter: ComponentType<Record<string, unknown>>
  readonly style: Record<string, CSSProperties>
}

let highlighterPromise: Promise<HighlighterModule> | null = null

async function loadHighlighter(): Promise<HighlighterModule> {
  highlighterPromise ??= Promise.all([
    import('react-syntax-highlighter/dist/esm/prism-async-light'),
    import('react-syntax-highlighter/dist/esm/styles/prism'),
  ]).then(([core, styles]) => ({
    SyntaxHighlighter: core.default as unknown as ComponentType<Record<string, unknown>>,
    style: styles.vscDarkPlus as Record<string, CSSProperties>,
  }))
  return highlighterPromise
}

export function LazyCodeBlock({
  language,
  value,
}: {
  readonly language: string
  readonly value: string
}) {
  const { t } = useTranslation()
  const [module, setModule] = useState<HighlighterModule | null>(null)
  const [failed, setFailed] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | 'idle'>('idle')

  useEffect(() => {
    let cancelled = false
    void loadHighlighter()
      .then((loaded) => {
        if (!cancelled) setModule(loaded)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
    window.setTimeout(() => setCopyStatus('idle'), 1_500)
  }

  const copyLabel =
    copyStatus === 'copied'
      ? t('evaluations.prediction.copied')
      : copyStatus === 'failed'
        ? t('evaluations.prediction.copyFailed')
        : t('evaluations.prediction.copyContent')

  const normalizedLanguage = language.toLowerCase().replace(/[^a-z0-9#+-]/gu, '') || 'text'
  return (
    <div className="group relative overflow-hidden rounded-[5px] border border-border bg-background/80">
      <button
        aria-label={copyLabel}
        className="absolute top-2 right-2 z-10 inline-flex size-8 items-center justify-center rounded-[4px] border border-border bg-surface text-muted-foreground opacity-75 transition hover:text-foreground group-hover:opacity-100"
        onClick={() => void copy()}
        type="button"
      >
        {copyStatus === 'copied' ? (
          <Check aria-hidden="true" size={13} />
        ) : (
          <Copy aria-hidden="true" size={13} />
        )}
        <span aria-live="polite" className="sr-only">
          {copyLabel}
        </span>
      </button>
      {failed ? (
        <p className="border-border border-b px-3 py-2 text-danger text-xs" role="status">
          {t('evaluations.markdown.codeLoadError')}
        </p>
      ) : null}
      {module === null ? (
        <pre className="overflow-x-auto p-4 pr-12 font-mono text-[0.78rem] leading-6">
          <code>{value.replace(/\n$/u, '')}</code>
        </pre>
      ) : (
        <module.SyntaxHighlighter
          PreTag="div"
          customStyle={{
            background: 'transparent',
            fontSize: '0.78rem',
            lineHeight: 1.6,
            margin: 0,
            padding: '1rem 3rem 1rem 1rem',
          }}
          language={normalizedLanguage}
          style={module.style}
        >
          {value.replace(/\n$/u, '')}
        </module.SyntaxHighlighter>
      )}
    </div>
  )
}
