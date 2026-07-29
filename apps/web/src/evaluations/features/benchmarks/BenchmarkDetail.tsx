import { ExternalLink, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import type { CategorizedBenchmark } from '../../domain/benchmarks.js'
import { benchmarkMarkdown } from '../../domain/benchmarks.js'
import { RichContent } from '../content/RichContent.js'
import { UseBenchmarkAction } from './UseBenchmarkAction.js'

function safePaperUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export function BenchmarkDetail({
  benchmark,
  onClose,
}: {
  readonly benchmark: CategorizedBenchmark
  readonly onClose: () => void
}) {
  const { i18n, t } = useTranslation()
  const dialogRef = useRef<HTMLElement>(null)
  const paper = safePaperUrl(benchmark.paper_url)
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', listener)
    return () => {
      window.removeEventListener('keydown', listener)
      previousFocus?.focus()
    }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <button
        aria-label={t('evaluations.common.close')}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        type="button"
      />
      <section
        aria-labelledby="benchmark-detail-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-[8px] border border-border-strong bg-surface-raised shadow-2xl"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex items-start gap-4 border-border border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <Badge tone="blue">{t(`evaluations.benchmarks.${benchmark.displayCategory}`)}</Badge>
            <h2 className="mt-3 break-words font-semibold text-2xl" id="benchmark-detail-title">
              {benchmark.pretty_name || benchmark.name}
            </h2>
            <p className="mt-1 font-mono text-muted-foreground text-xs">{benchmark.name}</p>
          </div>
          <Button
            aria-label={t('evaluations.common.close')}
            onClick={onClose}
            size="sm"
            variant="ghost"
          >
            <X aria-hidden="true" size={16} />
          </Button>
        </header>
        <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[1fr_18rem]">
          <div className="overflow-auto p-5">
            <RichContent
              content={
                benchmarkMarkdown(benchmark, i18n.language) ||
                t('evaluations.benchmarks.noDescription')
              }
            />
          </div>
          <aside className="overflow-auto border-border border-t bg-background/30 p-5 lg:border-t-0 lg:border-l">
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Dataset ID</dt>
                <dd className="mt-1 break-all font-mono text-xs">{benchmark.dataset_id}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('evaluations.benchmarks.samples')}</dt>
                <dd className="mt-1 font-mono">{benchmark.total_samples.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('evaluations.benchmarks.subsets')}</dt>
                <dd className="mt-1 flex flex-wrap gap-1">
                  {benchmark.subset_list.map((subset) => (
                    <Badge key={subset} tone="muted">
                      {subset}
                    </Badge>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Metrics</dt>
                <dd className="mt-1 flex flex-wrap gap-1">
                  {benchmark.metrics.map((metric) => (
                    <Badge key={metric} tone="blue">
                      {metric}
                    </Badge>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Metadata</dt>
                <dd className="mt-1">
                  <pre className="max-h-48 overflow-auto rounded-[5px] border border-border bg-background/60 p-3 font-mono text-xs">
                    {JSON.stringify(benchmark.meta, null, 2)}
                  </pre>
                </dd>
              </div>
            </dl>
          </aside>
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-border border-t px-5 py-4">
          {paper ? (
            <Button asChild variant="outline">
              <a href={paper} rel="noopener noreferrer" target="_blank">
                <ExternalLink aria-hidden="true" size={14} />
                Paper
              </a>
            </Button>
          ) : null}
          <UseBenchmarkAction benchmark={benchmark.name} />
        </footer>
      </section>
    </div>
  )
}
