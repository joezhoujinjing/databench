import { describe, expect, test } from 'vitest'
import { lineageToFlow } from './graph.js'

describe('lineage graph helpers', () => {
  test('extracts DAG nodes and input-to-output edges from lineage', () => {
    const graph = lineageToFlow({
      version: 'dedup',
      produced_by: { op: 'dedup', op_version: '1', params: {} },
      inputs: [
        {
          version: 'enriched',
          produced_by: { op: 'enrich_length', op_version: '1', params: {} },
          inputs: [{ version: 'raw' }],
        },
      ],
    })

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['dedup', 'enriched', 'raw'])
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { id: 'enriched->dedup', source: 'enriched', target: 'dedup' },
        { id: 'raw->enriched', source: 'raw', target: 'enriched' },
      ]),
    )
  })

  test('keeps unknown refs as a single node', () => {
    expect(lineageToFlow({ version: 'missing' })).toMatchObject({
      edges: [],
      nodes: [{ id: 'missing' }],
    })
  })
})
