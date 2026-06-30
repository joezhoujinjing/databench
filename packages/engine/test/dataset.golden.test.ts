import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson } from '@databench/hashing'
import { COLUMNS, sampleId } from '@databench/schema'
import pl from 'nodejs-polars'
import { describe, expect, test } from 'vitest'
import { Dataset, fromParquetBytes, toParquetBytes } from '../src/index.js'

const PYTHON = '/Users/hanlu/Desktop/databench/databench/.venv/bin/python'

const samples = [
  {
    kind: 'sft',
    source: 'file-a',
    meta: { ignored: true },
    signals: { quality: 1 },
    messages: [
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ name: 'search', arguments: { q: 'x' } }],
      },
    ],
  },
  {
    kind: 'preference',
    prompt: [{ role: 'user', content: 'Pick one' }],
    chosen: { role: 'assistant', content: 'A' },
    rejected: [{ role: 'assistant', content: 'B' }],
  },
  {
    kind: 'rl',
    prompt: [{ role: 'user', content: '2+2?' }],
    rollouts: [{ text: '4', reward: 1.25, meta: { judge: 'exact' } }],
  },
] as const

const expectedRows = [
  {
    id: 'e7875c7ae377da948f073831969eae7c533c6cf183e81da3ecf9894231705b1c',
    row_digest: 'd8c47f24a184a7b0b4fcdd52d8559488647c71403c4a2a24d0bee455b5beb919',
    kind: 'sft',
    source: 'file-a',
    payload:
      '{"kind":"sft","messages":[{"content":"你好","name":null,"role":"user","tool_call_id":null,"tool_calls":null},{"content":null,"name":null,"role":"assistant","tool_call_id":null,"tool_calls":[{"arguments":{"q":"x"},"id":null,"name":"search"}]}]}',
    meta: '{"ignored":true}',
    signals: '{"quality":1}',
  },
  {
    id: '72a1c5c2a86347de1b8f24d7681d33d4fc06504f949eeb1de80aa6924e2d59ec',
    row_digest: '7f4dd3c02c6c9f301708a5802a9635147381fe52ad1b962e2f3f84cfd1eceb6e',
    kind: 'preference',
    source: null,
    payload:
      '{"candidates":null,"chosen":{"content":"A","name":null,"role":"assistant","tool_call_id":null,"tool_calls":null},"kind":"preference","prompt":[{"content":"Pick one","name":null,"role":"user","tool_call_id":null,"tool_calls":null}],"rejected":[{"content":"B","name":null,"role":"assistant","tool_call_id":null,"tool_calls":null}]}',
    meta: '{}',
    signals: '{}',
  },
  {
    id: 'dc74cea15e344e9b2f3188afb6ba9b021038b399568cdcb80651460c9ab40ef2',
    row_digest: '0d68f4b20a310ac13cdf7e621ed79480ec471c3d2be67cbe292154afae2d1b7f',
    kind: 'rl',
    source: null,
    payload:
      '{"answer":null,"kind":"rl","prompt":[{"content":"2+2?","name":null,"role":"user","tool_call_id":null,"tool_calls":null}],"rollouts":[{"meta":{"judge":"exact"},"reward":1.25,"text":"4"}],"verifier":null}',
    meta: '{}',
    signals: '{}',
  },
] as const

describe('Dataset', () => {
  test('fromSamples matches Python row and version golden values', () => {
    const dataset = Dataset.fromSamples(samples, 'demo')

    expect(dataset.version).toBe('80411d63c8c5b8e6eec8f4183740f9c1e93143ddfc54d9def974fb864cf01fe5')
    expect(dataset.name).toBe('demo')
    expect(dataset.length).toBe(3)
    expect(dataset.manifest.kinds).toEqual({ sft: 1, preference: 1, rl: 1 })
    expect(dataset.manifest.columns).toEqual([...COLUMNS])
    expect(dataset.toPolars().toRecords()).toEqual(expectedRows)
  })

  test('toArrow returns a canonical all-Utf8 Arrow table', () => {
    const table = Dataset.fromSamples(samples, 'demo').toArrow()
    const rows = table.toArray().map((row) => row.toJSON())

    expect(table.numRows).toBe(3)
    expect(table.schema.fields.map((field) => field.name)).toEqual([...COLUMNS])
    expect(table.schema.fields.map((field) => field.type.toString())).toEqual(
      COLUMNS.map(() => 'Utf8'),
    )
    expect(rows).toEqual(expectedRows)
  })

  test('dataset version is order independent and empty version is hashText("empty")', () => {
    expect(Dataset.fromSamples(samples).version).toBe(
      Dataset.fromSamples([...samples].reverse()).version,
    )

    const empty = Dataset.fromSamples([], 'empty')
    expect(empty.version).toBe('6bdf3fe55052831d222fc6b82b2ba03f32b3599410fafd317642e21925c38f16')
    expect(empty.manifest.kinds).toEqual({})
    expect(empty.toPolars().columns).toEqual([...COLUMNS])
  })

  test('toSamples round-trips parsed samples and identity', () => {
    const dataset = Dataset.fromSamples(samples)
    const roundTrip = Array.from(dataset.toSamples())

    expect(roundTrip).toHaveLength(3)
    expect(sampleId(roundTrip[0])).toBe(expectedRows[0].id)
    expect(roundTrip[0]?.source).toBe('file-a')
    expect(roundTrip[0]?.meta).toEqual({ ignored: true })
    expect(canonicalJson(roundTrip[0]?.signals)).toBe('{"quality":1}')
    expect(Array.from(dataset.toSamples(1, 1)).map((sample) => sample.kind)).toEqual(['preference'])
    expect(Array.from(dataset.toSamples(3, 2))).toEqual([])
    expect(dataset.head(2).map(sampleId)).toEqual([expectedRows[0].id, expectedRows[1].id])
  })

  test('fromFrame ignores stale id and row_digest columns', () => {
    const original = Dataset.fromSamples([samples[0]]).toPolars()
    const stale = pl.DataFrame(
      {
        id: ['stale'],
        row_digest: ['stale'],
        kind: ['wrong'],
        source: ['file-a'],
        payload: [expectedRows[0].payload],
        meta: [expectedRows[0].meta],
        signals: [expectedRows[0].signals],
      },
      {
        schema: {
          id: pl.Utf8,
          row_digest: pl.Utf8,
          kind: pl.Utf8,
          source: pl.Utf8,
          payload: pl.Utf8,
          meta: pl.Utf8,
          signals: pl.Utf8,
        },
      },
    )

    expect(Dataset.fromFrame(stale).toPolars().toRecords()).toEqual(original.toRecords())
  })

  test('fromFrame rejects missing payload column', () => {
    const frame = pl.DataFrame({ source: ['x'] }, { schema: { source: pl.Utf8 } })

    expect(() => Dataset.fromFrame(frame)).toThrow("frame is missing required columns: {'payload'}")
  })

  test('parquet bytes round-trip through nodejs-polars', () => {
    const dataset = Dataset.fromSamples(samples, 'demo')
    const roundTrip = fromParquetBytes(toParquetBytes(dataset), dataset.manifest)

    expect(roundTrip.toPolars().toRecords()).toEqual(expectedRows)
    expect(roundTrip.version).toBe(dataset.version)
  })
})

describe.runIf(existsSync(PYTHON))('Python parquet compatibility', () => {
  test('Python Polars can read parquet bytes written by nodejs-polars', () => {
    const directory = mkdtempSync(join(tmpdir(), 'databench-engine-'))
    const parquetPath = join(directory, 'dataset.parquet')

    try {
      writeFileSync(parquetPath, toParquetBytes(Dataset.fromSamples(samples, 'demo')))

      const script = `
import json
import polars as pl
import sys
df = pl.read_parquet(sys.argv[1])
print(json.dumps({
    "columns": df.columns,
    "dtypes": [str(dtype) for dtype in df.dtypes],
    "rows": df.to_dicts(),
}, ensure_ascii=False))
`

      const output = spawnSync(PYTHON, ['-c', script, parquetPath], {
        encoding: 'utf8',
      })

      expect(output.status, output.stderr).toBe(0)

      const python = JSON.parse(output.stdout) as {
        columns: string[]
        dtypes: string[]
        rows: typeof expectedRows
      }

      expect(python.columns).toEqual([...COLUMNS])
      expect(python.dtypes).toEqual(COLUMNS.map(() => 'String'))
      expect(python.rows).toEqual(expectedRows)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  }, 30_000)
})
