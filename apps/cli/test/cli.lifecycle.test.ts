import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '@databench/workspace'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { EXIT } from '../src/exit.js'
import { run } from '../src/main.js'
import { setWorkspaceForTest } from '../src/runtime.js'
import { createMemoryStore } from './memory-store.js'

// End-to-end: drives the CLI through the REAL Workspace — an in-memory object
// store plus the test Postgres catalog (DATABASE_URL is set by
// scripts/with-test-db-schema.mjs). This exercises the actual add → show →
// samples → transform → lineage → export path, unlike router.test.ts which
// injects a fake Workspace.

const JSONL = [
  {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  },
  {
    messages: [
      { role: 'user', content: 'bye' },
      { role: 'assistant', content: 'goodbye' },
    ],
  },
  {
    messages: [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
    ],
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n')

const SAMPLES_ARRAY = JSON.stringify([
  {
    kind: 'sft',
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ],
  },
  {
    kind: 'sft',
    messages: [
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ],
  },
])

// Brand-labeled sft samples (assistant content is a JSON blob the `brand`
// extractor preset reads), matching the workspace golden vocab fixtures.
const VOCAB_SAMPLES = JSON.stringify(
  [
    ['远东', '远东电缆'],
    ['远东电缆', '远东电缆'],
    ['TBEA', '特变电工'],
    ['怪牌', '怪牌'],
  ].map(([raw, std]) => ({
    kind: 'sft',
    messages: [
      { role: 'user', content: 'normalize this' },
      {
        role: 'assistant',
        content: JSON.stringify({ raw_brand: raw, std_brand: std, params: {} }),
      },
    ],
  })),
)

let workspace: Workspace
let dir: string
let jsonlPath: string
let samplesPath: string
let vocabPath: string
let stdout: string[]
let stderr: string[]

beforeAll(async () => {
  // Catalog defaults to DATABASE_URL (the isolated test schema); store is memory.
  workspace = new Workspace({ store: createMemoryStore() })
  setWorkspaceForTest(workspace)
  dir = await mkdtemp(join(tmpdir(), 'databench-cli-e2e-'))
  jsonlPath = join(dir, 'in.jsonl')
  samplesPath = join(dir, 'samples.json')
  vocabPath = join(dir, 'vocab-samples.json')
  await writeFile(jsonlPath, `${JSONL}\n`)
  await writeFile(samplesPath, SAMPLES_ARRAY)
  await writeFile(vocabPath, VOCAB_SAMPLES)
})

afterAll(async () => {
  setWorkspaceForTest(null)
  await workspace.close()
  await rm(dir, { recursive: true, force: true })
})

beforeEach(() => {
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function json(): unknown {
  return JSON.parse(stdout.join(''))
}

describe('cli lifecycle (real Workspace)', () => {
  test('add → show → samples → transform run → lineage → export round-trips', async () => {
    // ingest JSONL
    expect(await run(['dataset', 'add', jsonlPath, '--name', 'e2e_demo', '--compact'])).toBe(
      EXIT.ok,
    )
    const added = json() as { version: string; num_rows: number; name: string }
    expect(added).toMatchObject({ name: 'e2e_demo', num_rows: 3 })

    // show resolves the ref to the same version
    stdout.length = 0
    expect(await run(['dataset', 'show', 'e2e_demo', '--compact'])).toBe(EXIT.ok)
    expect((json() as { version: string }).version).toBe(added.version)

    // paginated samples
    stdout.length = 0
    expect(await run(['dataset', 'samples', 'e2e_demo', '--limit', '2', '--compact'])).toBe(EXIT.ok)
    const page = json() as { total: number; limit: number; items: unknown[] }
    expect(page.total).toBe(3)
    expect(page.items).toHaveLength(2)

    // transform produces a new, smaller version under a new ref
    stdout.length = 0
    expect(
      await run([
        'transform',
        'run',
        'sample_n',
        '--input',
        'e2e_demo',
        '--params',
        '{"n":2}',
        '--ref',
        'e2e_small',
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    const small = json() as { version: string; num_rows: number }
    expect(small.num_rows).toBe(2)
    expect(small.version).not.toBe(added.version)

    // lineage records the producing op and its input
    stdout.length = 0
    expect(await run(['lineage', 'e2e_small', '--compact'])).toBe(EXIT.ok)
    const lineage = json() as { produced_by?: { op: string }; inputs?: { version: string }[] }
    expect(lineage.produced_by?.op).toBe('sample_n')
    expect(lineage.inputs?.[0]?.version).toBe(added.version)
  })

  test('export writes NDJSON to a file with --out and prints {path}', async () => {
    await run(['dataset', 'add', jsonlPath, '--name', 'e2e_exp', '--compact'])
    const outPath = join(dir, 'out.jsonl')

    stdout.length = 0
    expect(await run(['dataset', 'export', 'e2e_exp', '--fmt', 'sft', '--out', outPath])).toBe(
      EXIT.ok,
    )
    expect(json()).toEqual({ path: outPath })

    const lines = (await readFile(outPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0] as string)).toHaveProperty('messages')
  })

  test('export streams raw NDJSON to stdout (no JSON wrapper) without --out', async () => {
    await run(['dataset', 'add', jsonlPath, '--name', 'e2e_stream', '--compact'])

    stdout.length = 0
    expect(await run(['dataset', 'export', 'e2e_stream', '--fmt', 'sft'])).toBe(EXIT.ok)
    const lines = stdout.join('').trim().split('\n')
    expect(lines).toHaveLength(3)
    // Each line is a standalone JSON object; nothing wrapped it in {path} or an array.
    for (const line of lines) {
      expect(JSON.parse(line)).toHaveProperty('messages')
    }
  })

  test('dataset add --samples ingests a canonical samples array from a file', async () => {
    stdout.length = 0
    expect(
      await run(['dataset', 'add', '--samples', samplesPath, '--name', 'e2e_arr', '--compact']),
    ).toBe(EXIT.ok)
    expect(json()).toMatchObject({ name: 'e2e_arr', num_rows: 2 })
  })

  test('meta doctor reports healthy backends against the real catalog', async () => {
    stdout.length = 0
    expect(await run(['meta', 'doctor', '--compact'])).toBe(EXIT.ok)
    expect(json()).toEqual({ database: { ok: true }, store: { ok: true } })
  })

  test('an unknown ref exits 3 (not found), distinct from infra failure', async () => {
    stdout.length = 0
    expect(await run(['dataset', 'show', 'no_such_ref', '--compact'])).toBe(EXIT.notFound)
    expect(JSON.parse(stderr.join('')).error.code).toBe('not_found')
  })

  test('recipe materialize mixes named datasets reproducibly', async () => {
    await run(['dataset', 'add', jsonlPath, '--name', 'mix_a', '--compact'])
    await run(['dataset', 'add', '--samples', samplesPath, '--name', 'mix_b', '--compact'])
    const recipePath = join(dir, 'recipe.json')
    await writeFile(
      recipePath,
      JSON.stringify({
        name: 'cli-mix',
        sources: [
          { dataset: 'mix_a', weight: 1 },
          { dataset: 'mix_b', weight: 1 },
        ],
        target_size: 4,
        seed: 0,
      }),
    )

    stdout.length = 0
    expect(await run(['recipe', 'materialize', recipePath, '--ref', 'mixed', '--compact'])).toBe(
      EXIT.ok,
    )
    const first = json() as { version: string; num_rows: number }
    expect(first.num_rows).toBeGreaterThan(0)

    // lineage records the recipe op
    stdout.length = 0
    await run(['lineage', 'mixed', '--compact'])
    expect((json() as { produced_by?: { op: string } }).produced_by?.op).toBe('recipe:cli-mix')

    // re-materializing the same recipe yields the same version (deterministic;
    // also served from the run cache — this asserts idempotence, not the cache path)
    stdout.length = 0
    await run(['recipe', 'materialize', recipePath, '--compact'])
    expect((json() as { version: string }).version).toBe(first.version)
  })

  test('ref list and resolve reflect created refs', async () => {
    await run(['dataset', 'add', jsonlPath, '--name', 'ref_demo', '--compact'])

    stdout.length = 0
    await run(['ref', 'list', '--compact'])
    const list = json() as { items: { name: string; version: string }[] }
    expect(list.items.find((item) => item.name === 'ref_demo')).toBeDefined()

    stdout.length = 0
    expect(await run(['ref', 'resolve', 'ref_demo', '--compact'])).toBe(EXIT.ok)
    expect((json() as { name: string }).name).toBe('ref_demo')

    stdout.length = 0
    expect(await run(['ref', 'resolve', 'no_such_ref_zzz', '--compact'])).toBe(EXIT.notFound)
  })

  test('vocab derive → list → show → normalize → validate', async () => {
    await run(['dataset', 'add', '--samples', vocabPath, '--name', 'vocab_raw', '--compact'])

    // derive using the built-in brand preset
    stdout.length = 0
    expect(
      await run([
        'vocab',
        'derive',
        'brand',
        '--dataset',
        'vocab_raw',
        '--dimension',
        'brand',
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    const draft = json() as {
      name: string
      dimension: string
      status: string
      terms: { canonical: string; aliases: string[] }[]
    }
    expect(draft).toMatchObject({ name: 'brand', dimension: 'brand', status: 'draft' })
    // derive must fold the (raw → std) pairs into canonical terms with aliases
    const canonicals = draft.terms.map((term) => term.canonical)
    expect(canonicals).toEqual(expect.arrayContaining(['远东电缆', '特变电工', '怪牌']))
    const yuandong = draft.terms.find((term) => term.canonical === '远东电缆')
    expect(yuandong?.aliases).toContain('远东')

    stdout.length = 0
    await run(['vocab', 'list', '--compact'])
    expect((json() as { total: number }).total).toBeGreaterThan(0)

    stdout.length = 0
    await run(['vocab', 'show', 'brand', '--compact'])
    expect((json() as { name: string }).name).toBe('brand')

    // normalize a dataset whose std is wrong: the alias 远东 must be rewritten to
    // the canonical 远东电缆 (proves normalize actually rewrites, not passes through)
    const denormPath = join(dir, 'denorm.json')
    await writeFile(
      denormPath,
      JSON.stringify([
        {
          kind: 'sft',
          messages: [
            { role: 'user', content: 'x' },
            {
              role: 'assistant',
              content: JSON.stringify({ raw_brand: '远东', std_brand: 'WRONG', params: {} }),
            },
          ],
        },
      ]),
    )
    await run(['dataset', 'add', '--samples', denormPath, '--name', 'vocab_denorm', '--compact'])

    stdout.length = 0
    expect(
      await run([
        'vocab',
        'normalize',
        'brand',
        '--dataset',
        'vocab_denorm',
        '--ref',
        'vocab_norm',
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    expect((json() as { num_rows: number }).num_rows).toBe(1)

    // read the normalized sample back and confirm std_brand was rewritten
    stdout.length = 0
    await run(['dataset', 'samples', 'vocab_norm', '--compact'])
    const normalized = json() as { items: { messages: { content: string }[] }[] }
    const payload = JSON.parse(normalized.items[0]?.messages.at(-1)?.content ?? '{}') as {
      std_brand?: string
    }
    expect(payload.std_brand).toBe('远东电缆')

    // validate the clean dataset: everything resolves, so nothing is offending
    stdout.length = 0
    expect(await run(['vocab', 'validate', 'brand', '--dataset', 'vocab_raw', '--compact'])).toBe(
      EXIT.ok,
    )
    const validation = json() as {
      summary: { checked: number; invalid: number; offending_values: Record<string, number> }
      dataset: { num_rows: number }
    }
    expect(validation.summary).toEqual({ checked: 4, invalid: 0, offending_values: {} })
    expect(validation.dataset.num_rows).toBe(4)
  })

  test('vocab validate flags out-of-vocabulary values', async () => {
    const badPath = join(dir, 'bad.json')
    await writeFile(
      badPath,
      JSON.stringify([
        {
          kind: 'sft',
          messages: [
            { role: 'user', content: 'x' },
            {
              role: 'assistant',
              content: JSON.stringify({ raw_brand: '陌生牌', std_brand: '陌生牌', params: {} }),
            },
          ],
        },
      ]),
    )
    await run(['dataset', 'add', '--samples', badPath, '--name', 'vocab_bad', '--compact'])

    stdout.length = 0
    expect(await run(['vocab', 'validate', 'brand', '--dataset', 'vocab_bad', '--compact'])).toBe(
      EXIT.ok,
    )
    const summary = (
      json() as { summary: { invalid: number; offending_values: Record<string, number> } }
    ).summary
    expect(summary.invalid).toBeGreaterThan(0)
    expect(summary.offending_values).toHaveProperty('陌生牌')
  })

  test('vocab derive honors an explicit --extractor override over the preset', async () => {
    stdout.length = 0
    expect(
      await run([
        'vocab',
        'derive',
        'brand_x',
        '--dataset',
        'vocab_raw',
        '--dimension',
        'brand',
        '--extractor',
        JSON.stringify({ source: 'assistant_json', raw_key: 'raw_x', std_key: 'std_x' }),
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    // the recorded extractor is the override, not the brand preset (raw_brand)
    expect((json() as { meta: { extractor: { raw_key: string } } }).meta.extractor.raw_key).toBe(
      'raw_x',
    )
  })

  test('vocab curate saves a curated vocabulary; the CLI name overrides the file', async () => {
    const curatePath = join(dir, 'curate.json')
    await writeFile(
      curatePath,
      JSON.stringify({
        name: 'name_in_file',
        dimension: 'color',
        terms: [{ canonical: '红', aliases: ['red'], meta: {} }],
        meta: {},
      }),
    )

    stdout.length = 0
    expect(await run(['vocab', 'curate', 'curated_color', '--file', curatePath, '--compact'])).toBe(
      EXIT.ok,
    )
    const saved = json() as { name: string; status: string; dimension: string }
    expect(saved).toMatchObject({ name: 'curated_color', status: 'curated', dimension: 'color' })
  })

  test('vocab normalize on an unknown dataset exits 3', async () => {
    stdout.length = 0
    expect(
      await run(['vocab', 'normalize', 'brand', '--dataset', 'no_such_dataset', '--compact']),
    ).toBe(EXIT.notFound)
    expect(JSON.parse(stderr.join('')).error.code).toBe('not_found')
  })
})
