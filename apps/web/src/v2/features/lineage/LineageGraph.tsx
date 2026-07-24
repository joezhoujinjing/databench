import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTranslation } from 'react-i18next'
import type { DatasetLineageV2 } from '../../api/types.js'

export function V2LineageGraph({ lineage }: { lineage: DatasetLineageV2 }) {
  const { t } = useTranslation()
  const depthByVersion = lineageDepths(lineage)
  const rowsByDepth = new Map<number, number>()
  const nodes: Node[] = lineage.nodes.map((node) => {
    const depth = depthByVersion.get(node.dataset_version) ?? 0
    const row = rowsByDepth.get(depth) ?? 0
    rowsByDepth.set(depth, row + 1)
    const isRoot = node.dataset_version === lineage.root_dataset_version
    return {
      data: { label: node.dataset_version },
      id: node.dataset_version,
      position: { x: depth * 300, y: row * 110 },
      selectable: false,
      style: {
        background: 'var(--surface)',
        border: `1px solid ${isRoot ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: 6,
        color: 'var(--foreground)',
        fontFamily: 'monospace',
        fontSize: 11,
        maxWidth: 240,
        overflowWrap: 'anywhere',
        padding: 12,
      },
    }
  })
  const edges: Edge[] = lineage.edges.flatMap((edge) =>
    edge.input_dataset_versions.map((input, index) => ({
      id: `${edge.run_id}:${index}:${input}`,
      label: edge.run_id,
      source: input,
      style: { stroke: 'var(--border-strong)' },
      target: edge.output_dataset_version,
    })),
  )

  return (
    <div className="space-y-4">
      <section
        aria-label={t('v2.lineage.graphLabel')}
        className="h-[34rem] rounded-[6px] border border-border bg-background/75"
      >
        <ReactFlow
          colorMode="dark"
          edges={edges}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          maxZoom={1}
          minZoom={0.2}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--border)" gap={32} />
          <Controls />
        </ReactFlow>
      </section>
      <details>
        <summary className="cursor-pointer text-muted-foreground text-sm">
          {t('v2.lineage.edgeList')}
        </summary>
        <ol className="mt-3 space-y-2 text-sm">
          {lineage.nodes.map((node) => (
            <li className="break-all" key={`node:${node.dataset_version}`}>
              {node.dataset_version === lineage.root_dataset_version
                ? `${t('v2.lineage.root')}: `
                : `${t('v2.lineage.node')}: `}
              <code>{node.dataset_version}</code>
            </li>
          ))}
          {lineage.edges.flatMap((edge) =>
            edge.input_dataset_versions.map((input) => (
              <li className="break-all" key={`${edge.run_id}:${input}`}>
                <code>{input}</code> → <code>{edge.output_dataset_version}</code>{' '}
                <span className="text-muted-foreground">({edge.run_id})</span>
              </li>
            )),
          )}
        </ol>
      </details>
    </div>
  )
}

export function lineageDepths(lineage: DatasetLineageV2): Map<string, number> {
  const parentsByOutput = new Map<string, string[]>()
  for (const edge of lineage.edges) {
    parentsByOutput.set(edge.output_dataset_version, edge.input_dataset_versions)
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
