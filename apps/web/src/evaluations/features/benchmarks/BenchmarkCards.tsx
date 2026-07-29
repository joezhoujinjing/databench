import { ArrowUpRight, Boxes, Database, Gauge, Layers3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import type { CategorizedBenchmark } from '../../domain/benchmarks.js'

export function BenchmarkCards({
  benchmarks,
  onOpen,
}: {
  readonly benchmarks: readonly CategorizedBenchmark[]
  readonly onOpen: (benchmark: CategorizedBenchmark) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {benchmarks.map((benchmark) => (
        <button
          className="group min-h-64 rounded-[6px] border border-border bg-surface/72 p-5 text-left transition hover:border-primary/55 hover:bg-surface focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          key={`${benchmark.displayCategory}:${benchmark.name}`}
          onClick={() => onOpen(benchmark)}
          type="button"
        >
          <div className="flex items-start justify-between gap-3">
            <Badge
              tone={
                benchmark.displayCategory === 'text'
                  ? 'blue'
                  : benchmark.displayCategory === 'multimodal'
                    ? 'violet'
                    : benchmark.displayCategory === 'agent'
                      ? 'orange'
                      : 'green'
              }
            >
              {t(`evaluations.benchmarks.${benchmark.displayCategory}`)}
            </Badge>
            <ArrowUpRight
              aria-hidden="true"
              className="text-muted-foreground transition group-hover:text-primary"
              size={16}
            />
          </div>
          <h2 className="mt-5 break-words font-semibold text-lg">
            {benchmark.pretty_name || benchmark.name}
          </h2>
          <p className="mt-1 break-all font-mono text-muted-foreground text-xs">{benchmark.name}</p>
          <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="flex items-center gap-1 text-muted-foreground">
                <Database aria-hidden="true" size={12} />
                {t('evaluations.benchmarks.samples')}
              </dt>
              <dd className="mt-1 font-mono text-sm">{benchmark.total_samples.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-muted-foreground">
                <Layers3 aria-hidden="true" size={12} />
                {t('evaluations.benchmarks.subsets')}
              </dt>
              <dd className="mt-1 font-mono text-sm">{benchmark.subset_list.length}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-muted-foreground">
                <Boxes aria-hidden="true" size={12} />
                Few-shot
              </dt>
              <dd className="mt-1 font-mono text-sm">{benchmark.few_shot_num}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-muted-foreground">
                <Gauge aria-hidden="true" size={12} />
                Metrics
              </dt>
              <dd className="mt-1 truncate font-mono text-sm">
                {benchmark.metrics.join(', ') || '—'}
              </dd>
            </div>
          </dl>
          <div className="mt-5 flex flex-wrap gap-1.5">
            {benchmark.tags.slice(0, 6).map((tag) => (
              <Badge key={tag} tone="muted">
                {tag}
              </Badge>
            ))}
          </div>
        </button>
      ))}
    </div>
  )
}
