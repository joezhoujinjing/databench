import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '@databench/workspace'
import { expect, test } from 'vitest'
import { createApp } from '../src/app.js'
import { createMemoryStore } from './memory-store.js'

// The legacy Python repo lives outside this monorepo, so its path is
// configurable via `DATABENCH_LEGACY_REPO`. When it (or its venv) is absent —
// e.g. on CI or another machine — this end-to-end parity test skips gracefully
// via `test.runIf` rather than hard-failing on a spawn timeout.
const LEGACY_REPO = process.env.DATABENCH_LEGACY_REPO ?? '/Users/hanlu/Desktop/databench/databench'
const LEGACY_UVICORN = `${LEGACY_REPO}/.venv/bin/uvicorn`

test.runIf(existsSync(LEGACY_UVICORN))(
  'S20 G-parity: TS API matches legacy Python service for the lifecycle semantics',
  async () => {
    const prefix = `s20-${randomUUID()}`
    const python = await startLegacyService()
    const workspace = Workspace.open({ root: `./${prefix}`, store: createMemoryStore() })

    try {
      const legacy = await runLifecycle(httpClient(python.baseUrl), prefix)
      const ts = await runLifecycle(honoClient(createApp({ workspace })), prefix)

      expect(projectManifests(ts.manifests)).toEqual(projectManifests(legacy.manifests))
      expect(projectPage(ts.rawPage)).toEqual(projectPage(legacy.rawPage))
      expect(projectPage(ts.trainPage)).toEqual(projectPage(legacy.trainPage))
      expect(projectRefs(ts.refs, prefix)).toEqual(projectRefs(legacy.refs, prefix))
      expect(projectLineage(ts.cleanLineage)).toEqual(projectLineage(legacy.cleanLineage))
      expect(projectLineage(ts.trainLineage)).toEqual(projectLineage(legacy.trainLineage))
      expect(projectLineage(ts.unknownLineage)).toEqual(projectLineage(legacy.unknownLineage))
      expect(ts.exportRows).toEqual(legacy.exportRows)
    } finally {
      await workspace.close()
      await stopLegacyService(python)
    }
  },
  90_000,
)

interface TestClient {
  fetch(path: string, init?: RequestInit): Promise<Response>
}

interface LegacyService {
  readonly baseUrl: string
  readonly root: string
  readonly process: ChildProcessWithoutNullStreams
  readonly logs: () => string
}

interface LifecycleSnapshot {
  readonly manifests: Record<string, ManifestProjection>
  readonly rawPage: SamplesPage
  readonly trainPage: SamplesPage
  readonly refs: RefsPage
  readonly cleanLineage: LineageNode
  readonly trainLineage: LineageNode
  readonly unknownLineage: LineageNode
  readonly exportRows: unknown[]
}

interface ManifestProjection {
  readonly version: string
  readonly num_rows: number
  readonly kinds: Record<string, number>
}

interface SamplesPage {
  readonly total: number
  readonly limit: number
  readonly offset: number
  readonly items: unknown[]
}

interface RefsPage {
  readonly items: RefInfo[]
}

interface RefInfo {
  readonly name: string
  readonly version: string
}

interface LineageNode {
  readonly version: string
  readonly name?: string | null
  readonly num_rows?: number
  readonly produced_by?: {
    readonly op: string
    readonly op_version: string
    readonly params: Record<string, unknown>
  }
  readonly inputs?: readonly LineageNode[]
  readonly cycle?: true
}

async function runLifecycle(client: TestClient, prefix: string): Promise<LifecycleSnapshot> {
  const rawRef = `${prefix}-sft-raw`
  const prefRef = `${prefix}-pref-raw`
  const cleanRef = `${prefix}-sft-clean`
  const trainRef = `${prefix}-train`

  const sft = await postJson<ManifestProjection>(client, '/v1/datasets', {
    name: rawRef,
    samples: sftSamples(prefix),
  })

  const uploadBody = new FormData()
  uploadBody.set(
    'file',
    new File([preferenceJsonl(prefix)], 'preference.jsonl', {
      type: 'application/x-ndjson',
    }),
  )
  const pref = await expectJson<ManifestProjection>(
    await client.fetch(`/v1/datasets:ingest-jsonl?name=${encodeURIComponent(prefRef)}`, {
      method: 'POST',
      body: uploadBody,
    }),
  )

  const raw = await getJson<ManifestProjection>(client, `/v1/datasets/${rawRef}`)
  const rawPage = await getJson<SamplesPage>(
    client,
    `/v1/datasets/${rawRef}/samples?limit=2&offset=1`,
  )

  const enriched = await postJson<ManifestProjection>(client, '/v1/transforms/enrich_length/run', {
    inputs: [rawRef],
  })
  const clean = await postJson<ManifestProjection>(client, '/v1/transforms/dedup/run', {
    inputs: [enriched.version],
    ref: cleanRef,
  })
  const cleanLineage = await getJson<LineageNode>(client, `/v1/lineage/${cleanRef}`)
  const unknownLineage = await getJson<LineageNode>(client, `/v1/lineage/${prefix}-missing`)

  const train = await postJson<ManifestProjection>(client, '/v1/recipes:materialize', {
    recipe: {
      name: `${prefix}-demo-mix`,
      sources: [
        { dataset: cleanRef, weight: 2 },
        { dataset: prefRef, weight: 1 },
      ],
    },
    ref: trainRef,
  })
  const trainPage = await getJson<SamplesPage>(
    client,
    `/v1/datasets/${trainRef}/samples?limit=2&offset=1`,
  )
  const trainLineage = await getJson<LineageNode>(client, `/v1/lineage/${trainRef}`)
  const refs = await getJson<RefsPage>(client, '/v1/refs?limit=500')
  const exportRows = await getNdjson(client, `/v1/datasets/${trainRef}/export?fmt=trl`)

  return {
    manifests: { sft, pref, raw, clean, train },
    rawPage,
    trainPage,
    refs,
    cleanLineage,
    trainLineage,
    unknownLineage,
    exportRows,
  }
}

function honoClient(app: ReturnType<typeof createApp>): TestClient {
  return {
    fetch: (path, init) => app.fetch(new Request(`http://localhost${path}`, init)),
  }
}

function httpClient(baseUrl: string): TestClient {
  return {
    fetch: (path, init) => fetch(`${baseUrl}${path}`, init),
  }
}

async function postJson<T>(client: TestClient, path: string, body: unknown): Promise<T> {
  return expectJson<T>(
    await client.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )
}

async function getJson<T>(client: TestClient, path: string): Promise<T> {
  return expectJson<T>(await client.fetch(path))
}

async function expectJson<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

async function getNdjson(client: TestClient, path: string): Promise<unknown[]> {
  const response = await client.fetch(path)
  expect(response.status).toBe(200)

  return (await response.text())
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown)
}

function projectManifests(
  manifests: Record<string, ManifestProjection>,
): Record<string, ManifestProjection> {
  return Object.fromEntries(
    Object.entries(manifests).map(([key, value]) => [
      key,
      {
        version: value.version,
        num_rows: value.num_rows,
        kinds: value.kinds,
      },
    ]),
  )
}

function projectPage(page: SamplesPage): SamplesPage {
  return {
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    items: page.items.map(projectSample),
  }
}

function projectSample(sample: unknown): unknown {
  if (!isRecord(sample)) {
    return sample
  }

  switch (sample.kind) {
    case 'sft':
    case 'trajectory':
      return {
        kind: sample.kind,
        source: sample.source ?? null,
        meta: sample.meta ?? {},
        signals: sample.signals ?? {},
        messages: Array.isArray(sample.messages) ? sample.messages.map(projectMessage) : [],
      }
    case 'preference':
      return {
        kind: sample.kind,
        source: sample.source ?? null,
        meta: sample.meta ?? {},
        signals: sample.signals ?? {},
        prompt: Array.isArray(sample.prompt) ? sample.prompt.map(projectMessage) : [],
        chosen: projectMessageOrMessages(sample.chosen),
        rejected: projectMessageOrMessages(sample.rejected),
        candidates: sample.candidates ?? null,
      }
    case 'rl':
      return {
        kind: sample.kind,
        source: sample.source ?? null,
        meta: sample.meta ?? {},
        signals: sample.signals ?? {},
        prompt: Array.isArray(sample.prompt) ? sample.prompt.map(projectMessage) : [],
        answer: sample.answer ?? null,
        verifier: sample.verifier ?? null,
        rollouts: sample.rollouts ?? [],
      }
    default:
      return sample
  }
}

function projectMessageOrMessages(value: unknown): unknown {
  return Array.isArray(value) ? value.map(projectMessage) : projectMessage(value)
}

function projectMessage(message: unknown): unknown {
  if (!isRecord(message)) {
    return message
  }

  return {
    role: message.role,
    content: message.content ?? null,
    name: message.name ?? null,
    tool_calls: message.tool_calls ?? null,
    tool_call_id: message.tool_call_id ?? null,
  }
}

function projectRefs(refs: RefsPage, prefix: string): RefInfo[] {
  return refs.items
    .filter((ref) => ref.name.startsWith(prefix))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function projectLineage(lineage: LineageNode): LineageNode {
  const node: LineageNode = { version: lineage.version }

  if ('name' in lineage) {
    node.name = lineage.name ?? null
  }
  if (lineage.num_rows !== undefined) {
    node.num_rows = lineage.num_rows
  }
  if (lineage.produced_by !== undefined) {
    node.produced_by = {
      op: lineage.produced_by.op,
      op_version: lineage.produced_by.op_version,
      params: lineage.produced_by.params,
    }
  }
  if (lineage.inputs !== undefined) {
    node.inputs = lineage.inputs.map(projectLineage)
  }
  if (lineage.cycle === true) {
    node.cycle = true
  }

  return node
}

function sftSamples(prefix: string): unknown[] {
  return [
    sft(prefix, 'hi', 'hello there'),
    sft(prefix, 'hi', 'hello there'),
    sft(prefix, 'what is 2+2', '4'),
  ]
}

function sft(prefix: string, user: string, assistant: string): unknown {
  return {
    kind: 'sft',
    messages: [
      { role: 'user', content: `${prefix}:${user}` },
      { role: 'assistant', content: assistant },
    ],
  }
}

function preferenceJsonl(prefix: string): string {
  return [
    { prompt: `${prefix}:q1`, chosen: 'good', rejected: 'bad' },
    { prompt: `${prefix}:q2`, chosen: 'yes', rejected: 'no' },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')
}

async function startLegacyService(): Promise<LegacyService> {
  const port = await freePort()
  const root = mkdtempSync(join(tmpdir(), 'databench-python-parity-'))
  const legacy = spawn(
    LEGACY_UVICORN,
    [
      'databench.service.app:create_app',
      '--factory',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: LEGACY_REPO,
      env: {
        ...process.env,
        DATABENCH_ROOT: root,
      },
    },
  )
  let stdout = ''
  let stderr = ''

  legacy.stdout.setEncoding('utf8')
  legacy.stderr.setEncoding('utf8')
  legacy.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  legacy.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const service = {
    baseUrl: `http://127.0.0.1:${port}`,
    root,
    process: legacy,
    logs: () => `${stdout}\n${stderr}`.trim(),
  }

  try {
    await waitForHealth(service)
  } catch (error) {
    await stopLegacyService(service)
    throw error
  }

  return service
}

async function waitForHealth(service: LegacyService): Promise<void> {
  const deadline = Date.now() + 15_000
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null

  service.process.once('exit', (code, signal) => {
    exit = { code, signal }
  })

  while (Date.now() < deadline) {
    if (exit !== null) {
      throw new Error(
        `legacy service exited before health check: ${JSON.stringify(exit)}\n${service.logs()}`,
      )
    }

    try {
      const response = await fetch(`${service.baseUrl}/health`)
      if (response.status === 200) {
        return
      }
    } catch {
      // Keep polling until uvicorn is listening.
    }

    await delay(100)
  }

  throw new Error(`legacy service did not become healthy\n${service.logs()}`)
}

async function stopLegacyService(service: LegacyService): Promise<void> {
  try {
    if (service.process.exitCode === null) {
      service.process.kill('SIGTERM')
      await Promise.race([
        new Promise<void>((resolve) => service.process.once('exit', () => resolve())),
        delay(5_000).then(() => {
          service.process.kill('SIGKILL')
        }),
      ])
    }
  } finally {
    rmSync(service.root, { recursive: true, force: true })
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address !== null) {
        const { port } = address
        server.close((error) => {
          if (error) {
            reject(error)
          } else {
            resolve(port)
          }
        })
      } else {
        server.close()
        reject(new Error('could not allocate a TCP port'))
      }
    })
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
