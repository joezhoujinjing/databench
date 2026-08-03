import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Database, GitBranch } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyTextButton } from '@/components/common/CopyTextButton.js'
import { JsonBlock } from '@/components/common/JsonBlock.js'
import { Button } from '@/components/ui/button.js'
import { ellipsizeMiddle, formatBytes, formatDateTime, formatInteger } from '@/lib/format.js'
import { cn } from '@/lib/utils.js'
import type { DatasetLineageV2 } from '../../api/types.js'

type LineageNodeManifest = DatasetLineageV2['nodes'][number]['manifest']
type LineageRun = DatasetLineageV2['edges'][number]
type SelectionKey =
  | { readonly kind: 'node'; readonly version: string }
  | { readonly kind: 'run'; readonly runId: string }

interface LineageNodeData extends Record<string, unknown> {
  readonly boundary: boolean
  readonly current: boolean
  readonly label: string
  readonly onSelect: () => void
  readonly version: string
}

interface LineageEdgeData extends Record<string, unknown> {
  readonly label: string
  readonly loopOffset: number
  readonly onSelect: () => void
  readonly pathOffset: number
  readonly run: LineageRun
}

type LineageFlowNode = Node<LineageNodeData, 'lineage'>
type LineageFlowEdge = Edge<LineageEdgeData, 'lineage'>

const nodeTypes = { lineage: LineageNodeCard }
const edgeTypes = { lineage: LineageEdgePath }

export function V2LineageGraph({ lineage }: { lineage: DatasetLineageV2 }) {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<SelectionKey>(() => defaultSelection(lineage))

  useEffect(() => {
    setSelection((current) =>
      selectionExists(current, lineage) ? current : defaultSelection(lineage),
    )
  }, [lineage])

  const graph = useMemo(
    () => buildGraph(lineage, selection, setSelection, t),
    [lineage, selection, t],
  )
  const graphHeightClass =
    graph.nodes.length <= 4 ? 'h-[28rem]' : 'h-[min(62vh,42rem)] min-h-[28rem]'
  const selectedRun =
    selection.kind === 'run'
      ? (lineage.edges.find((edge) => edge.run_id === selection.runId) ?? null)
      : null
  const selectedVersion = selection.kind === 'node' ? selection.version : null
  const selectedManifest =
    selectedVersion === null
      ? null
      : (lineage.nodes.find((node) => node.dataset_version === selectedVersion)?.manifest ?? null)

  return (
    <div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section
          aria-label={t('v2.lineage.graphLabel')}
          className={`${graphHeightClass} lineage-readonly-graph bg-background/55`}
        >
          <ReactFlow
            colorMode="light"
            deleteKeyCode={null}
            edges={graph.edges}
            edgesReconnectable={false}
            edgeTypes={edgeTypes}
            elementsSelectable
            fitView
            fitViewOptions={{ padding: 0.25 }}
            maxZoom={1.2}
            minZoom={0.15}
            nodes={graph.nodes}
            nodesConnectable={false}
            nodesDraggable={false}
            nodeTypes={nodeTypes}
            onEdgeClick={(_event, edge) =>
              setSelection({ kind: 'run', runId: edge.data?.run.run_id ?? edge.id })
            }
            onNodeClick={(_event, node) =>
              setSelection({ kind: 'node', version: node.data.version })
            }
            onPaneClick={() => setSelection(defaultSelection(lineage))}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--border-strong)" gap={32} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </section>

        <LineageInspector
          boundary={selectedVersion !== null && selectedManifest === null}
          current={selectedVersion === lineage.root_dataset_version}
          heightClass={graphHeightClass}
          manifest={selectedManifest}
          run={selectedRun}
          version={selectedVersion}
        />
      </div>

      <details className="border-border border-t px-5 py-3.5">
        <summary className="cursor-pointer text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary">
          {t('v2.lineage.edgeList')}
        </summary>
        <ol className="mt-3 space-y-1 text-sm">
          {lineage.nodes.map((node) => (
            <li key={`node:${node.dataset_version}`}>
              <button
                className="w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                onClick={() => setSelection({ kind: 'node', version: node.dataset_version })}
                type="button"
              >
                {node.dataset_version === lineage.root_dataset_version
                  ? `${t('v2.lineage.root')}: `
                  : `${t('v2.lineage.node')}: `}
                <code className="break-all">{node.dataset_version}</code>
              </button>
            </li>
          ))}
          {lineage.edges.flatMap((edge) =>
            edge.input_dataset_versions.map((input) => (
              <li key={`${edge.run_id}:${input}`}>
                <button
                  className="w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  onClick={() => setSelection({ kind: 'run', runId: edge.run_id })}
                  type="button"
                >
                  <span className="font-medium">{operationLabel(t, edge.op)}</span>{' '}
                  <code className="break-all">{input}</code> →{' '}
                  <code className="break-all">{edge.output_dataset_version}</code>{' '}
                  <span className="text-muted-foreground">({edge.run_id})</span>
                </button>
              </li>
            )),
          )}
        </ol>
      </details>
    </div>
  )
}

function buildGraph(
  lineage: DatasetLineageV2,
  selection: SelectionKey,
  setSelection: (selection: SelectionKey) => void,
  t: ReturnType<typeof useTranslation>['t'],
): { readonly edges: LineageFlowEdge[]; readonly nodes: LineageFlowNode[] } {
  const manifests = new Map(
    lineage.nodes.map((node) => [node.dataset_version, node.manifest] as const),
  )
  const boundaryVersions: string[] = []
  const seenBoundaryVersions = new Set<string>()
  for (const edge of lineage.edges) {
    for (const input of edge.input_dataset_versions) {
      if (!manifests.has(input) && !seenBoundaryVersions.has(input)) {
        seenBoundaryVersions.add(input)
        boundaryVersions.push(input)
      }
    }
  }

  const depthByVersion = lineageDepths(lineage)
  const rowsByDepth = new Map<number, number>()
  const versions = [...lineage.nodes.map((node) => node.dataset_version), ...boundaryVersions]
  const nodes: LineageFlowNode[] = versions.map((version) => {
    const depth = depthByVersion.get(version) ?? 0
    const row = rowsByDepth.get(depth) ?? 0
    rowsByDepth.set(depth, row + 1)
    const boundary = !manifests.has(version)
    const current = version === lineage.root_dataset_version
    const selected = selection.kind === 'node' && selection.version === version
    const label = current
      ? t('v2.lineage.currentDataset')
      : boundary
        ? t('v2.lineage.boundaryDataset')
        : t('v2.lineage.upstreamDataset')
    return {
      ariaLabel: `${label}: ${version}`,
      ariaRole: 'group',
      data: {
        boundary,
        current,
        label,
        onSelect: () => setSelection({ kind: 'node', version }),
        version,
      },
      draggable: false,
      focusable: false,
      id: version,
      position: { x: depth * 320, y: row * 140 + 90 },
      selectable: false,
      selected,
      sourcePosition: Position.Left,
      style: { background: 'transparent', border: 0, padding: 0, width: 220 },
      targetPosition: Position.Right,
      type: 'lineage',
    }
  })

  const loopCounts = new Map<string, number>()
  const pathCounts = new Map<string, number>()
  const edges: LineageFlowEdge[] = lineage.edges.flatMap((run) =>
    run.input_dataset_versions.map((input, index) => {
      const selfLoop = input === run.output_dataset_version
      const loopIndex = loopCounts.get(input) ?? 0
      if (selfLoop) loopCounts.set(input, loopIndex + 1)
      const pathKey = `${input}\0${run.output_dataset_version}`
      const pathIndex = pathCounts.get(pathKey) ?? 0
      pathCounts.set(pathKey, pathIndex + 1)
      const selected = selection.kind === 'run' && selection.runId === run.run_id
      const label = operationLabel(t, run.op)
      return {
        ariaLabel: `${label}: ${input} → ${run.output_dataset_version}`,
        className: 'cursor-pointer',
        data: {
          label,
          loopOffset: 70 + loopIndex * 28,
          onSelect: () => setSelection({ kind: 'run', runId: run.run_id }),
          pathOffset: 22 + pathIndex * 12,
          run,
        },
        focusable: true,
        id: `${run.run_id}:${index}:${input}`,
        markerEnd: {
          color: selected ? 'var(--primary)' : 'var(--border-strong)',
          type: MarkerType.ArrowClosed,
        },
        reconnectable: false,
        selected,
        selectable: true,
        source: input,
        style: { stroke: selected ? 'var(--primary)' : 'var(--border-strong)' },
        target: run.output_dataset_version,
        type: 'lineage',
      }
    }),
  )

  return { edges, nodes }
}

function LineageNodeCard({ data, selected }: NodeProps<LineageFlowNode>) {
  return (
    <>
      <Handle position={Position.Left} type="source" />
      <button
        className={cn(
          'nodrag nopan flex h-[4.5rem] w-[13.75rem] flex-col justify-center gap-1 rounded-md border bg-surface px-4 text-left shadow-sm transition-[border-color,background-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-primary/65 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55',
          data.current ? 'border-primary' : 'border-border-strong',
          data.boundary && 'border-dashed bg-background/80',
          selected && 'border-primary bg-primary/5 shadow-[0_8px_24px_rgba(240,138,60,0.14)]',
        )}
        onClick={(event) => {
          event.stopPropagation()
          data.onSelect()
        }}
        title={data.version}
        type="button"
      >
        <span className="flex items-center gap-1.5 text-[0.68rem] text-muted-foreground uppercase tracking-[0.1em]">
          <Database aria-hidden="true" size={12} />
          {data.label}
        </span>
        <code className="text-[0.82rem] text-foreground">{ellipsizeMiddle(data.version, 9)}</code>
      </button>
      <Handle position={Position.Right} type="target" />
    </>
  )
}

function LineageEdgePath({
  data,
  id,
  markerEnd,
  selected,
  source,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  target,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps<LineageFlowEdge>) {
  if (!data) return null
  const selfLoop = source === target
  let path: string
  let labelX: number
  let labelY: number
  if (selfLoop) {
    const loopTop = Math.min(sourceY, targetY) - data.loopOffset
    path = `M ${sourceX} ${sourceY} C ${sourceX - 72} ${loopTop}, ${targetX + 72} ${loopTop}, ${targetX} ${targetY}`
    labelX = (sourceX + targetX) / 2
    labelY = loopTop
  } else {
    ;[path, labelX, labelY] = getSmoothStepPath({
      borderRadius: 10,
      offset: data.pathOffset,
      sourcePosition,
      sourceX,
      sourceY,
      targetPosition,
      targetX,
      targetY,
    })
  }

  return (
    <>
      <BaseEdge
        id={id}
        interactionWidth={30}
        path={path}
        style={{ ...style, strokeWidth: selected ? 2 : 1.35 }}
        {...(markerEnd === undefined ? {} : { markerEnd })}
      />
      <EdgeLabelRenderer>
        <button
          className={cn(
            'nodrag nopan pointer-events-auto absolute inline-flex h-7 items-center gap-1.5 rounded border border-border bg-surface/95 px-2 font-medium text-[0.7rem] text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:border-primary/65 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55',
            selected && 'border-primary bg-primary text-primary-foreground',
          )}
          onClick={(event) => {
            event.stopPropagation()
            data.onSelect()
          }}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title={data.run.run_id}
          type="button"
        >
          <GitBranch aria-hidden="true" size={12} />
          {data.label}
        </button>
      </EdgeLabelRenderer>
    </>
  )
}

function LineageInspector({
  boundary,
  current,
  heightClass,
  manifest,
  run,
  version,
}: {
  boundary: boolean
  current: boolean
  heightClass: string
  manifest: LineageNodeManifest | null
  run: LineageRun | null
  version: string | null
}) {
  const { t } = useTranslation()
  if (run) {
    const noVersionChange = run.input_dataset_versions.includes(run.output_dataset_version)
    return (
      <aside
        className={cn(heightClass, 'overflow-y-auto border-border border-l bg-surface/80 p-5')}
      >
        <p className="text-[0.68rem] text-muted-foreground uppercase tracking-[0.12em]">
          {t('v2.lineage.runDetails')}
        </p>
        <h3 className="mt-1.5 font-semibold text-lg">{operationLabel(t, run.op)}</h3>
        <p className="mt-1 text-muted-foreground text-xs">
          {t('v2.lineage.operationVersion', { version: run.op_version })}
        </p>

        {noVersionChange ? (
          <div className="mt-4 border-primary border-l-2 bg-primary/5 px-3 py-2.5 text-sm">
            <p className="font-medium">{t('v2.lineage.noVersionChange')}</p>
            <p className="mt-1 text-muted-foreground text-xs leading-5">
              {t('v2.lineage.noVersionChangeHint')}
            </p>
          </div>
        ) : null}

        <InspectorSection label={t('v2.lineage.runId')}>
          <CopyableCode copyLabel={t('v2.lineage.copyRunId')} value={run.run_id} />
        </InspectorSection>
        <InspectorSection label={t('v2.lineage.createdAt')}>
          <time dateTime={run.created_at} title={run.created_at}>
            {formatDateTime(run.created_at)}
          </time>
        </InspectorSection>
        <InspectorSection label={t('v2.lineage.inputs')}>
          <div className="space-y-1.5">
            {run.input_dataset_versions.map((input) => (
              <DatasetLink key={input} version={input} />
            ))}
          </div>
        </InspectorSection>
        <InspectorSection label={t('v2.lineage.output')}>
          <DatasetLink version={run.output_dataset_version} />
        </InspectorSection>
        <InspectorSection label={t('v2.lineage.params')}>
          {Object.keys(run.normalized_params).length > 0 ? (
            <JsonBlock value={run.normalized_params} />
          ) : (
            <span className="text-muted-foreground">{t('v2.lineage.noParams')}</span>
          )}
        </InspectorSection>
      </aside>
    )
  }

  if (version) {
    const label = current
      ? t('v2.lineage.currentDataset')
      : boundary
        ? t('v2.lineage.boundaryDataset')
        : t('v2.lineage.upstreamDataset')
    return (
      <aside
        className={cn(heightClass, 'overflow-y-auto border-border border-l bg-surface/80 p-5')}
      >
        <p className="text-[0.68rem] text-muted-foreground uppercase tracking-[0.12em]">
          {t('v2.lineage.datasetDetails')}
        </p>
        <h3 className="mt-1.5 font-semibold text-lg">{label}</h3>
        {boundary ? (
          <p className="mt-2 text-muted-foreground text-xs leading-5">
            {t('v2.lineage.boundaryHint')}
          </p>
        ) : null}
        <InspectorSection label={t('v2.datasets.version')}>
          <CopyableCode copyLabel={t('v2.lineage.copyVersion')} value={version} />
        </InspectorSection>
        {manifest ? (
          <>
            <InspectorSection label={t('v2.detail.records')}>
              {formatInteger(manifest.num_records)}
            </InspectorSection>
            <InspectorSection label={t('v2.detail.size')}>
              {formatBytes(manifest.artifact_size_bytes)}
            </InspectorSection>
            <InspectorSection label={t('v2.record.schemaVersion')}>
              {manifest.record_schema_version}
            </InspectorSection>
            <InspectorSection label={t('v2.detail.layout')}>
              {manifest.layout_version}
            </InspectorSection>
          </>
        ) : null}
        <Button asChild className="mt-5 w-full" size="sm" variant="outline">
          <Link params={{ ref: version }} to="/datasets/$ref">
            {t('v2.lineage.openDataset')}
            <ArrowUpRight aria-hidden="true" size={14} />
          </Link>
        </Button>
      </aside>
    )
  }

  return (
    <aside
      className={cn(
        heightClass,
        'flex flex-col justify-center border-border border-l bg-surface/80 p-6',
      )}
    >
      <GitBranch aria-hidden="true" className="text-primary" size={22} />
      <h3 className="mt-3 font-semibold">{t('v2.lineage.inspectTitle')}</h3>
      <p className="mt-1.5 text-muted-foreground text-sm leading-6">
        {t('v2.lineage.inspectHint')}
      </p>
    </aside>
  )
}

function InspectorSection({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="mt-4 border-border border-t pt-3">
      <h4 className="mb-1.5 text-[0.68rem] text-muted-foreground uppercase tracking-[0.1em]">
        {label}
      </h4>
      <div className="text-sm leading-6">{children}</div>
    </section>
  )
}

function CopyableCode({ copyLabel, value }: { copyLabel: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start gap-1">
      <code className="min-w-0 flex-1 break-all text-xs leading-5">{value}</code>
      <CopyTextButton className="-mt-1" label={copyLabel} text={value} />
    </div>
  )
}

function DatasetLink({ version }: { version: string }) {
  return (
    <Link
      className="flex items-center justify-between gap-2 rounded border border-border bg-background/50 px-2.5 py-2 font-mono text-xs transition-colors hover:border-primary/60 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      params={{ ref: version }}
      title={version}
      to="/datasets/$ref"
    >
      <span>{ellipsizeMiddle(version, 7)}</span>
      <ArrowUpRight aria-hidden="true" className="shrink-0 text-muted-foreground" size={13} />
    </Link>
  )
}

function defaultSelection(lineage: DatasetLineageV2): SelectionKey {
  const changed = lineage.edges.find(
    (edge) => !edge.input_dataset_versions.includes(edge.output_dataset_version),
  )
  const run = changed ?? lineage.edges[0]
  return run
    ? { kind: 'run', runId: run.run_id }
    : { kind: 'node', version: lineage.root_dataset_version }
}

function selectionExists(selection: SelectionKey, lineage: DatasetLineageV2): boolean {
  if (selection.kind === 'run') {
    return lineage.edges.some((edge) => edge.run_id === selection.runId)
  }
  return (
    lineage.nodes.some((node) => node.dataset_version === selection.version) ||
    lineage.edges.some((edge) => edge.input_dataset_versions.includes(selection.version))
  )
}

function operationLabel(t: ReturnType<typeof useTranslation>['t'], operation: string): string {
  return t(`v2.lineage.operations.${operation}`, { defaultValue: operation })
}

export function lineageDepths(lineage: DatasetLineageV2): Map<string, number> {
  const parentsByOutput = new Map<string, Set<string>>()
  for (const edge of lineage.edges) {
    const parents = parentsByOutput.get(edge.output_dataset_version) ?? new Set<string>()
    for (const input of edge.input_dataset_versions) parents.add(input)
    parentsByOutput.set(edge.output_dataset_version, parents)
  }
  const depths = new Map<string, number>([[lineage.root_dataset_version, 0]])
  const queue = [lineage.root_dataset_version]
  while (queue.length > 0) {
    const output = queue.shift()
    if (output === undefined) break
    const depth = depths.get(output) ?? 0
    for (const input of parentsByOutput.get(output) ?? []) {
      if (!depths.has(input)) {
        depths.set(input, depth + 1)
        queue.push(input)
      }
    }
  }
  return depths
}
