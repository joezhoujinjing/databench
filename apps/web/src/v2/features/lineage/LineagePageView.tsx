import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState, Spinner } from '@/components/common/State.js'
import { Button } from '@/components/ui/button.js'
import { Field } from '@/components/ui/field.js'
import { TextInput } from '@/components/ui/input.js'
import { PageShell, Surface, SurfaceHeader, SurfaceTitle } from '@/components/ui/surface.js'
import { useV2Lineage } from '../../api/hooks.js'
import type { DatasetLineageV2 } from '../../api/types.js'
import { V2LineageGraph } from './LineageGraph.js'

export function V2LineagePageView({
  exactVersion,
  requestedRef,
}: {
  exactVersion: string
  requestedRef: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [input, setInput] = useState(requestedRef)
  const [depthInput, setDepthInput] = useState(8)
  const [nodeInput, setNodeInput] = useState(100)
  const [limits, setLimits] = useState({ maxDepth: 8, maxNodes: 100 })
  const lineage = useV2Lineage(exactVersion, limits.maxDepth, limits.maxNodes)
  const merged = lineage.data ? mergeLineagePages(lineage.data.pages) : null

  function submit(event: FormEvent) {
    event.preventDefault()
    const next = input.trim()
    setLimits({ maxDepth: depthInput, maxNodes: nodeInput })
    if (next !== '') void navigate({ params: { ref: next }, to: '/lineage/$ref' })
  }

  return (
    <PageShell className="space-y-4">
      <header className="space-y-3">
        <Link
          className="inline-flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          params={{ ref: exactVersion }}
          to="/datasets/$ref"
        >
          <ArrowLeft aria-hidden="true" size={15} />
          {t('v2.detail.back')}
        </Link>
        <h1 className="font-semibold text-[1.75rem] leading-tight tracking-tight">
          {t('v2.lineage.title')}
        </h1>
      </header>

      <Surface className="overflow-hidden shadow-none">
        <SurfaceHeader className="flex flex-wrap items-center justify-between gap-3 py-3.5">
          <SurfaceTitle>{t('v2.lineage.graph')}</SurfaceTitle>
          {merged ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs">
              <span>
                {t('v2.lineage.nodes')}{' '}
                <strong className="text-foreground">{merged.nodes.length}</strong>
              </span>
              <span>
                {t('v2.lineage.runs')}{' '}
                <strong className="text-foreground">{merged.edges.length}</strong>
              </span>
              {merged.truncated ? (
                <span className="text-warning">{t('v2.lineage.truncated')}</span>
              ) : null}
            </div>
          ) : null}
        </SurfaceHeader>

        <form
          className="grid gap-3 border-border border-b px-5 py-3.5 lg:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_auto] lg:items-end"
          onSubmit={submit}
        >
          <Field className="gap-1.5" label={t('v2.lineage.dataset')}>
            <TextInput
              aria-label={t('v2.lineage.dataset')}
              onChange={(event) => setInput(event.currentTarget.value)}
              value={input}
            />
          </Field>
          <Field className="gap-1.5" label={t('v2.lineage.maxDepth')}>
            <TextInput
              aria-label={t('v2.lineage.maxDepth')}
              max={32}
              min={1}
              onChange={(event) => setDepthInput(clampNumber(event.currentTarget.value, 1, 32))}
              type="number"
              value={depthInput}
            />
          </Field>
          <Field className="gap-1.5" label={t('v2.lineage.maxNodes')}>
            <TextInput
              aria-label={t('v2.lineage.maxNodes')}
              max={500}
              min={1}
              onChange={(event) => setNodeInput(clampNumber(event.currentTarget.value, 1, 500))}
              type="number"
              value={nodeInput}
            />
          </Field>
          <Button type="submit">{t('v2.lineage.open')}</Button>
        </form>

        <div>
          {lineage.isLoading ? <Spinner /> : null}
          {lineage.isError ? <ErrorState error={lineage.error} /> : null}
          {merged && merged.nodes.length === 0 ? (
            <EmptyState>{t('v2.lineage.empty')}</EmptyState>
          ) : null}
          {merged && merged.nodes.length > 0 ? <V2LineageGraph lineage={merged} /> : null}
        </div>

        {lineage.hasNextPage ? (
          <div className="border-border border-t px-5 py-3">
            <Button
              disabled={lineage.isFetchingNextPage}
              onClick={() => void lineage.fetchNextPage()}
              size="sm"
              type="button"
              variant="outline"
            >
              {lineage.isFetchingNextPage ? t('v2.lineage.loadingMore') : t('v2.lineage.loadMore')}
            </Button>
          </div>
        ) : null}
      </Surface>
    </PageShell>
  )
}

export function mergeLineagePages(pages: readonly DatasetLineageV2[]): DatasetLineageV2 {
  const first = pages[0]
  if (first === undefined) {
    return { edges: [], next_cursor: null, nodes: [], root_dataset_version: '', truncated: false }
  }
  const nodes = new Map(first.nodes.map((node) => [node.dataset_version, node]))
  const edges = new Map(
    first.edges.map((edge) => [
      `${edge.run_id}:${edge.output_dataset_version}:${edge.input_dataset_versions.join(',')}`,
      edge,
    ]),
  )
  for (const page of pages.slice(1)) {
    for (const node of page.nodes) nodes.set(node.dataset_version, node)
    for (const edge of page.edges) {
      edges.set(
        `${edge.run_id}:${edge.output_dataset_version}:${edge.input_dataset_versions.join(',')}`,
        edge,
      )
    }
  }
  const last = pages.at(-1) ?? first
  return {
    edges: [...edges.values()],
    next_cursor: last.next_cursor,
    nodes: [...nodes.values()],
    root_dataset_version: first.root_dataset_version,
    truncated: last.truncated,
  }
}

function clampNumber(value: string, min: number, max: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : min
}
