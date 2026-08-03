import { describe, expect, test } from 'vitest'
import type { DatasetLineageV2 } from '../../api/types.js'
import { lineageDepths } from './LineageGraph.js'

const ROOT = 'a'.repeat(64)
const PARENT_A = 'b'.repeat(64)
const PARENT_B = 'c'.repeat(64)
const BOUNDARY = 'd'.repeat(64)

function lineage(edges: DatasetLineageV2['edges']): DatasetLineageV2 {
  return {
    edges,
    next_cursor: null,
    nodes: [],
    root_dataset_version: ROOT,
    truncated: false,
  }
}

function edge(runId: string, inputs: string[], output: string): DatasetLineageV2['edges'][number] {
  return {
    created_at: '2026-08-03T00:00:00.000Z',
    input_dataset_versions: inputs,
    normalized_params: {},
    op: 'subset',
    op_version: '1',
    output_dataset_version: output,
    run_id: runId,
  }
}

describe('lineage graph depth model', () => {
  test('keeps parents from every run that produced the same output', () => {
    const depths = lineageDepths(
      lineage([edge('run_a', [PARENT_A], ROOT), edge('run_b', [PARENT_B], ROOT)]),
    )

    expect(depths.get(ROOT)).toBe(0)
    expect(depths.get(PARENT_A)).toBe(1)
    expect(depths.get(PARENT_B)).toBe(1)
  })

  test('does not expand a self-loop into an extra depth', () => {
    const depths = lineageDepths(
      lineage([edge('run_loop', [ROOT], ROOT), edge('run_parent', [PARENT_A], ROOT)]),
    )

    expect(depths.get(ROOT)).toBe(0)
    expect(depths.get(PARENT_A)).toBe(1)
    expect(depths.size).toBe(2)
  })

  test('assigns a depth to an input outside the returned node page', () => {
    const depths = lineageDepths(lineage([edge('run_boundary', [BOUNDARY], ROOT)]))

    expect(depths.get(BOUNDARY)).toBe(1)
  })
})
