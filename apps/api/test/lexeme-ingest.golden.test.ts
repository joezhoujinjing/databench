import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '@databench/workspace'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../src/app.js'
import { createMemoryStore } from './memory-store.js'

// A sample whose OPEN dicts carry integer-valued floats (signals.quality=1.0 and
// rollout.meta.s=2.0). Both the HTTP entry and the JSONL entry must preserve the
// `.0` lexeme so the content-addressed id (from rollout.meta) and dataset version
// (from signals via row_digest) agree with each other AND with Python. This is
// the parity crack the review flagged: `context.req.json()` folds `1.0` -> `1`.
const fixture = JSON.parse(
  readFileSync(new URL('./golden/fixtures/lexeme-ingest.json', import.meta.url), 'utf8'),
) as { sampleText: string; id: string; version: string }

const PYTHON =
  process.env.DATABENCH_LEGACY_PYTHON ??
  `${process.env.DATABENCH_LEGACY_REPO ?? '/Users/hanlu/Desktop/databench/databench'}/.venv/bin/python`

interface Ingested {
  readonly id: string
  readonly version: string
}

const workspaces: Workspace[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()))
})

describe('HTTP ingest preserves JSON number lexemes', () => {
  test('open-dict integer floats yield the same id/version via HTTP, JSONL, and Python', async () => {
    const http = await ingestViaHttp()
    const jsonl = await ingestViaJsonl()

    // Cross-entry consistency: the two ingest paths must not disagree.
    expect(http).toEqual(jsonl)
    // Committed Python golden (regenerated live below when the legacy repo exists).
    expect(http.id).toBe(fixture.id)
    expect(http.version).toBe(fixture.version)
  })
})

async function ingestViaHttp(): Promise<Ingested> {
  const workspace = openWorkspace()
  const app = createApp({ workspace })
  const ref = `lex-http-${randomUUID()}`
  // Build the request body as raw text so the `1.0`/`2.0` lexemes survive to the
  // server; JSON.stringify of a parsed object would already have folded them.
  const body = `{"name":${JSON.stringify(ref)},"samples":[${fixture.sampleText}]}`
  const response = await app.fetch(
    new Request('http://localhost/v1/datasets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  )
  expect(response.status).toBe(200)

  return read(await workspace.get(ref))
}

async function ingestViaJsonl(): Promise<Ingested> {
  const workspace = openWorkspace()
  const directory = mkdtempSync(join(tmpdir(), 'databench-lexeme-'))
  const path = join(directory, 'sample.jsonl')

  try {
    writeFileSync(path, `${fixture.sampleText}\n`)
    return read(await workspace.addJsonl(path, { source: 'lexeme-fixture' }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function openWorkspace(): Workspace {
  const workspace = Workspace.open({ root: `./lex-${randomUUID()}`, store: createMemoryStore() })
  workspaces.push(workspace)
  return workspace
}

function read(dataset: Awaited<ReturnType<Workspace['get']>>): Ingested {
  const records = dataset.toPolars().toRecords()
  expect(records).toHaveLength(1)

  return { id: String(records[0]?.id), version: dataset.version }
}

describe.runIf(existsSync(PYTHON))('live Python lexeme parity', () => {
  test('the committed golden matches freshly generated Python', () => {
    const script = `
import json
import sys
from databench.dataset import Dataset
from databench.schema import parse_sample

sample = parse_sample(json.loads(sys.stdin.read()))
dataset = Dataset.from_samples([sample], name="lexeme-http")
print(json.dumps({"id": sample.id, "version": dataset.version}))
`
    const output = spawnSync(PYTHON, ['-c', script], {
      encoding: 'utf8',
      input: fixture.sampleText,
    })

    expect(output.status, output.stderr).toBe(0)
    const python = JSON.parse(output.stdout) as Ingested

    expect(python.id).toBe(fixture.id)
    expect(python.version).toBe(fixture.version)
  })
})
