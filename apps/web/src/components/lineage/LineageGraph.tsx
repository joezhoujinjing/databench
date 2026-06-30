import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Lineage } from '@/api/types.js'
import { lineageToFlow } from './graph.js'

export function LineageGraph({ lineage }: { lineage: Lineage }) {
  const graph = lineageToFlow(lineage)
  const rowsByDepth = new Map<number, number>()
  const nodes: Node[] = graph.nodes.map((node) => {
    const row = rowsByDepth.get(node.depth) ?? 0
    rowsByDepth.set(node.depth, row + 1)

    return {
      id: node.id,
      data: { label: node.label },
      position: { x: node.depth * 280, y: row * 110 },
      selectable: false,
      style: {
        background: 'var(--surface)',
        border: `1px solid ${node.index === 0 ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: 6,
        color: 'var(--foreground)',
        fontSize: 13,
        maxWidth: 220,
        overflowWrap: 'anywhere',
        padding: 12,
        boxShadow:
          node.index === 0
            ? '0 0 0 1px color-mix(in srgb, var(--primary) 35%, transparent)'
            : 'none',
        whiteSpace: 'pre-wrap',
      },
    }
  })
  const edges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id,
    style: { stroke: 'var(--border-strong)' },
    source: edge.source,
    target: edge.target,
    animated: false,
  }))

  return (
    <div className="h-[35rem] rounded-[6px] border border-border bg-background/75">
      <ReactFlow
        colorMode="dark"
        edges={edges}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.32 }}
        maxZoom={1}
        minZoom={0.25}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--border)" gap={32} />
        <Controls />
      </ReactFlow>
    </div>
  )
}
