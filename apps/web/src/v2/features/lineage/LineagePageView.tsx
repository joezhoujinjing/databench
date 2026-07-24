import { Link, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState, Spinner } from '@/components/common/State.js'
import { Button } from '@/components/ui/button.js'
import { Field } from '@/components/ui/field.js'
import { TextInput } from '@/components/ui/input.js'
import {
  KeyValueGrid,
  KeyValueRow,
  PageHeader,
  PageShell,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
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
  const [maxDepth, setMaxDepth] = useState(8)
  const [maxNodes, setMaxNodes] = useState(100)
  const lineage = useV2Lineage(exactVersion, maxDepth, maxNodes)
  const merged = lineage.data ? mergeLineagePages(lineage.data.pages) : null

  function submit(event: FormEvent) {
    event.preventDefault()
    const next = input.trim()
    if (next !== '') void navigate({ params: { ref: next }, to: '/lineage/$ref' })
  }

  return (
    <PageShell>
      <PageHeader
        actions={
          <Button asChild variant="outline">
            <Link params={{ ref: exactVersion }} to="/datasets/$ref">
              {t('v2.lineage.openDataset')}
            </Link>
          </Button>
        }
        description={t('v2.lineage.description')}
        title={t('v2.lineage.title')}
      />
      <Surface>
        <SurfaceBody>
          <form
            className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_9rem_9rem_auto] lg:items-end"
            onSubmit={submit}
          >
            <Field label={t('v2.lineage.dataset')}>
              <TextInput
                aria-label={t('v2.lineage.dataset')}
                onChange={(event) => setInput(event.currentTarget.value)}
                value={input}
              />
            </Field>
            <Field label={t('v2.lineage.maxDepth')}>
              <TextInput
                aria-label={t('v2.lineage.maxDepth')}
                max={32}
                min={1}
                onChange={(event) => setMaxDepth(clampNumber(event.currentTarget.value, 1, 32))}
                type="number"
                value={maxDepth}
              />
            </Field>
            <Field label={t('v2.lineage.maxNodes')}>
              <TextInput
                aria-label={t('v2.lineage.maxNodes')}
                max={500}
                min={1}
                onChange={(event) => setMaxNodes(clampNumber(event.currentTarget.value, 1, 500))}
                type="number"
                value={maxNodes}
              />
            </Field>
            <Button type="submit">{t('v2.lineage.open')}</Button>
          </form>
        </SurfaceBody>
      </Surface>
      <Surface>
        <SurfaceHeader className="flex flex-wrap items-center justify-between gap-3">
          <SurfaceTitle>{t('v2.lineage.graph')}</SurfaceTitle>
          <code className="max-w-full break-all text-dim-foreground text-xs">{exactVersion}</code>
        </SurfaceHeader>
        <SurfaceBody>
          {lineage.isLoading ? <Spinner /> : null}
          {lineage.isError ? <ErrorState error={lineage.error} /> : null}
          {merged && merged.nodes.length === 0 ? (
            <EmptyState>{t('v2.lineage.empty')}</EmptyState>
          ) : null}
          {merged && merged.nodes.length > 0 ? <V2LineageGraph lineage={merged} /> : null}
        </SurfaceBody>
      </Surface>
      {merged ? (
        <Surface>
          <SurfaceBody className="space-y-4">
            <KeyValueGrid>
              <KeyValueRow label={t('v2.lineage.nodes')} value={merged.nodes.length} />
              <KeyValueRow label={t('v2.lineage.runs')} value={merged.edges.length} />
              <KeyValueRow
                label={t('v2.lineage.truncated')}
                value={merged.truncated ? t('v2.common.yes') : t('v2.common.no')}
              />
            </KeyValueGrid>
            {lineage.hasNextPage ? (
              <Button
                disabled={lineage.isFetchingNextPage}
                onClick={() => void lineage.fetchNextPage()}
                type="button"
                variant="outline"
              >
                {lineage.isFetchingNextPage
                  ? t('v2.lineage.loadingMore')
                  : t('v2.lineage.loadMore')}
              </Button>
            ) : null}
          </SurfaceBody>
        </Surface>
      ) : null}
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
    truncated: pages.some((page) => page.truncated),
  }
}

function clampNumber(value: string, min: number, max: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : min
}
