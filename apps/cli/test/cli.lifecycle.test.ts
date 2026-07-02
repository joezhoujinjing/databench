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

let workspace: Workspace
let dir: string
let jsonlPath: string
let samplesPath: string
let stdout: string[]
let stderr: string[]

beforeAll(async () => {
  // Catalog defaults to DATABASE_URL (the isolated test schema); store is memory.
  workspace = new Workspace({ store: createMemoryStore() })
  setWorkspaceForTest(workspace)
  dir = await mkdtemp(join(tmpdir(), 'databench-cli-e2e-'))
  jsonlPath = join(dir, 'in.jsonl')
  samplesPath = join(dir, 'samples.json')
  await writeFile(jsonlPath, `${JSONL}\n`)
  await writeFile(samplesPath, SAMPLES_ARRAY)
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
})
