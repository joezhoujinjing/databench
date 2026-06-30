export interface LineageFlowEdge {
  id: string
  source: string
  target: string
}

export interface LineageFlowNode {
  id: string
  label: string
  depth: number
  index: number
}

export interface LineageFlowGraph {
  edges: LineageFlowEdge[]
  nodes: LineageFlowNode[]
}

export function lineageToFlow(value: unknown): LineageFlowGraph {
  const nodes = new Map<string, LineageFlowNode>()
  const edges = new Map<string, LineageFlowEdge>()
  let index = 0

  function visit(node: unknown, depth: number, path: string): string {
    const record = asRecord(node)
    const version = typeof record.version === 'string' ? record.version : path
    const op = readOp(record.produced_by)
    const displayVersion = shortVersion(version)
    const label = op === null ? displayVersion : `${displayVersion}\n${op}`

    if (!nodes.has(version)) {
      nodes.set(version, { id: version, label, depth, index })
      index += 1
    }

    if (Array.isArray(record.inputs)) {
      record.inputs.forEach((input, inputIndex) => {
        const inputId = visit(input, depth + 1, `${path}.${inputIndex}`)
        const edgeId = `${inputId}->${version}`
        edges.set(edgeId, { id: edgeId, source: inputId, target: version })
      })
    }

    return version
  }

  visit(value, 0, 'root')

  return { edges: [...edges.values()], nodes: [...nodes.values()] }
}

function shortVersion(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12)
}

function readOp(value: unknown): string | null {
  const record = asRecord(value)
  const op = record.op

  return typeof op === 'string' ? op : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
