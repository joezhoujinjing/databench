import { Link, useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FEATURES, useModuleEnabled } from '@/api/capabilities.js'
import { useLineage } from '@/api/hooks.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { EmptyState, ErrorState, FeatureDisabled, Spinner } from '@/components/common/State.js'
import { LineageGraph } from '@/components/lineage/LineageGraph.js'
import { TreeNode } from '@/components/lineage/TreeNode.js'
import { StatusDot } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { TextInput } from '@/components/ui/input.js'
import {
  KeyValueGrid,
  KeyValueRow,
  PageHeader,
  PageShell,
  SectionLabel,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  SurfaceTitle,
} from '@/components/ui/surface.js'
import { SegmentedTabs } from '@/components/ui/tabs.js'
import { formatInteger, shortRef } from '@/lib/format.js'

type ViewMode = 'graph' | 'tree' | 'raw'

const VIEW_MODES = [
  { label: 'DAG', value: 'graph' },
  { label: 'Tree', value: 'tree' },
  { label: 'Raw', value: 'raw' },
] as const

export function LineagePageView({ initialRef }: { initialRef: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const enabled = useModuleEnabled(FEATURES.lineage)
  const [input, setInput] = useState(initialRef)
  const [activeRef, setActiveRef] = useState(initialRef)
  const [mode, setMode] = useState<ViewMode>('graph')
  const lineage = useLineage(activeRef)

  useEffect(() => {
    setInput(initialRef)
    setActiveRef(initialRef)
  }, [initialRef])

  function submit(event: FormEvent) {
    event.preventDefault()
    const next = input.trim()

    if (next === '') {
      return
    }

    setActiveRef(next)
    void navigate({ params: { ref: next }, to: '/lineage/$ref' })
  }

  if (!enabled) {
    return <FeatureDisabled>{t('lineage.disabled')}</FeatureDisabled>
  }

  return (
    <PageShell>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="space-y-5">
          <PageHeader
            actions={
              <form className="relative w-full min-w-[18rem] sm:w-[32rem]" onSubmit={submit}>
                <Search
                  aria-hidden="true"
                  className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
                  size={17}
                />
                <TextInput
                  aria-label={t('lineage.placeholder')}
                  className="h-12 pr-16 pl-10"
                  onChange={(event) => setInput(event.currentTarget.value)}
                  placeholder={t('lineage.placeholder')}
                  value={input}
                />
                <span className="absolute top-1/2 right-4 -translate-y-1/2 text-dim-foreground text-xs">
                  ⌘ K
                </span>
              </form>
            }
            description="Explore how datasets are produced and consumed."
            title={t('lineage.title')}
          />

          {!activeRef ? <EmptyState>{t('lineage.emptyPrompt')}</EmptyState> : null}
          {activeRef ? (
            <Surface className="min-h-[38rem] overflow-hidden">
              <SurfaceBody className="p-3">
                {lineage.isLoading ? <Spinner /> : null}
                {lineage.isError ? <ErrorState error={lineage.error} /> : null}
                {lineage.data && mode === 'graph' ? <LineageGraph lineage={lineage.data} /> : null}
                {lineage.data && mode === 'tree' ? (
                  <TreeNode defaultOpen label={t('lineage.rootLabel')} value={lineage.data} />
                ) : null}
                {lineage.data && mode === 'raw' ? <JsonBlock value={lineage.data} /> : null}
              </SurfaceBody>
            </Surface>
          ) : null}
          {lineage.data ? <LineageActivity lineage={lineage.data} /> : null}
        </div>

        <Surface className="h-fit">
          <SurfaceHeader>
            <SegmentedTabs items={VIEW_MODES} onChange={setMode} value={mode} />
          </SurfaceHeader>
          <SurfaceBody className="space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <SurfaceTitle>{activeRef ? shortRef(activeRef) : '-'}</SurfaceTitle>
                <span className="inline-flex items-center gap-2 text-muted-foreground text-sm">
                  <StatusDot /> Active
                </span>
              </div>
              <KeyValueGrid>
                <KeyValueRow label="Version">{activeRef ? shortRef(activeRef) : '-'}</KeyValueRow>
              </KeyValueGrid>
            </div>
            <div className="border-border border-t pt-5">
              <SectionLabel>Details</SectionLabel>
              <KeyValueGrid className="mt-4">
                <KeyValueRow label="Rows">{lineageRows(lineage.data)}</KeyValueRow>
                <KeyValueRow label="Schema">v1</KeyValueRow>
                <KeyValueRow label="Produced by">{producedBy(lineage.data)}</KeyValueRow>
                <KeyValueRow label="Inputs">{lineageInputs(lineage.data)}</KeyValueRow>
              </KeyValueGrid>
            </div>
            <div className="border-border border-t pt-5">
              <SectionLabel>Actions</SectionLabel>
              <div className="mt-4 grid gap-3">
                <Button asChild variant="outline">
                  {activeRef ? (
                    <Link params={{ ref: activeRef }} to="/datasets/$ref">
                      View dataset
                    </Link>
                  ) : (
                    <Link to="/datasets">View dataset</Link>
                  )}
                </Button>
                <Button variant="outline">Copy version</Button>
              </div>
            </div>
          </SurfaceBody>
        </Surface>
      </div>
    </PageShell>
  )
}

function LineageActivity({ lineage }: { lineage: unknown }) {
  const events = lineageEvents(lineage)

  return (
    <Surface className="overflow-hidden">
      <SurfaceHeader className="flex items-center justify-between gap-4">
        <SurfaceTitle>Recent runs</SurfaceTitle>
        <span className="text-muted-foreground text-sm">{events.length} events</span>
      </SurfaceHeader>
      <SurfaceBody className="p-0">
        <div className="grid grid-cols-[2rem_minmax(8rem,1fr)_minmax(8rem,1fr)_8rem] border-border border-b px-5 py-3 text-muted-foreground text-sm max-md:hidden">
          <span />
          <span>Operation</span>
          <span>Version</span>
          <span>Rows</span>
        </div>
        {events.map((event) => (
          <div
            className="grid gap-3 border-border border-b px-5 py-3 text-sm last:border-b-0 md:grid-cols-[2rem_minmax(8rem,1fr)_minmax(8rem,1fr)_8rem]"
            key={event.version}
          >
            <span className="flex items-center">
              <StatusDot />
            </span>
            <span>{event.op}</span>
            <code className="min-w-0 break-words text-muted-foreground">
              {shortRef(event.version)}
            </code>
            <span className="text-muted-foreground">{event.rows}</span>
          </div>
        ))}
      </SurfaceBody>
    </Surface>
  )
}

function lineageEvents(lineage: unknown): Array<{ op: string; rows: string; version: string }> {
  const events: Array<{ op: string; rows: string; version: string }> = []

  function visit(node: unknown) {
    const record = asRecord(node)
    const version = typeof record.version === 'string' ? record.version : 'unknown'
    events.push({
      op: producedBy(record),
      rows: lineageRows(record),
      version,
    })

    if (Array.isArray(record.inputs)) {
      record.inputs.forEach(visit)
    }
  }

  visit(lineage)
  return events
}

function lineageRows(lineage: unknown): string {
  const value = asRecord(lineage).num_rows
  return typeof value === 'number' ? formatInteger(value) : '-'
}

function lineageInputs(lineage: unknown): string {
  const inputs = asRecord(lineage).inputs
  return Array.isArray(inputs) ? String(inputs.length) : '0'
}

function producedBy(lineage: unknown): string {
  const produced = asRecord(asRecord(lineage).produced_by)
  const op = produced.op
  const version = produced.op_version

  if (typeof op !== 'string') {
    return 'ingest'
  }

  return typeof version === 'string' ? `${op} ${version}` : op
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
