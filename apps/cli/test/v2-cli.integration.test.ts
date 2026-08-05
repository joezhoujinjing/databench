import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExportPlanV2 } from '@databench/schema'
import { V2Workspace } from '@databench/workspace'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { EXIT } from '../src/exit.js'
import { run } from '../src/main.js'
import { setWorkspaceForTest } from '../src/runtime.js'

const runIntegration = process.env.RUN_MINIO_STORE_TESTS === 'true'
let integrationStdout: Uint8Array[] = []
const FIRST_RECORD_ID = `rec_${'1'.repeat(64)}`

interface CliFixture {
  readonly record_source: string
  readonly expected_dataset_version: string
  readonly export: {
    readonly converter: 'canonical-jsonl'
    readonly options: Record<string, never>
    readonly media_type: string
    readonly suggested_filename: string
    readonly output_count: number
  }
}

describe.runIf(runIntegration)('V2 CLI against real MinIO and Postgres', () => {
  let workspace: V2Workspace
  let temporaryRoot: string
  let inputPath: string
  let fixture: CliFixture
  let refName: string
  let stderr: Uint8Array[]

  beforeAll(async () => {
    fixture = JSON.parse(
      await readFile(
        new URL('./golden/fixtures/v2/cli-v2-lifecycle.fixture.json', import.meta.url),
        'utf8',
      ),
    ) as CliFixture
    const recordFixture = JSON.parse(
      await readFile(new URL(`../../../${fixture.record_source}`, import.meta.url), 'utf8'),
    ) as { records: unknown[] }
    temporaryRoot = await mkdtemp(join(tmpdir(), 'databench-v13-cli-'))
    inputPath = join(temporaryRoot, 'canonical.jsonl')
    await writeFile(
      inputPath,
      `${recordFixture.records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      { mode: 0o600 },
    )
    refName = `v13-cli-${randomUUID()}`
    workspace = await V2Workspace.open({
      root: temporaryRoot,
      cursorSecret: 'v13-cli-integration-cursor-secret',
      ...(process.env.DATABASE_URL === undefined ? {} : { databaseUrl: process.env.DATABASE_URL }),
      storeConfig: {
        kind: 's3',
        bucket: process.env.S3_BUCKET ?? 'databench',
        region: process.env.S3_REGION ?? 'us-east-1',
        endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'databench',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'databench-secret',
        forcePathStyle: true,
      },
    })
    setWorkspaceForTest(workspace)
  })

  afterAll(async () => {
    setWorkspaceForTest(null)
    await workspace?.close()
    if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true })
  })

  beforeEach(() => {
    integrationStdout = []
    stderr = []
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        integrationStdout.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
        callback?.()
        return true
      },
    )
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('CLI and Workspace return the same fixed version, manifest, and export plan', async () => {
    expect(
      await run([
        'dataset',
        'ingest',
        inputPath,
        '--ref',
        refName,
        '--message',
        'V13 CLI fixture',
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    const ingested = outputJson<{
      dataset_version: string
      manifest: unknown
    }>()
    expect(ingested.dataset_version).toBe(fixture.expected_dataset_version)

    const directView = await workspace.describeDataset(refName)
    expect(ingested.manifest).toEqual(directView.manifest)
    expect(directView.dataset_version).toBe(fixture.expected_dataset_version)

    integrationStdout.length = 0
    expect(await run(['dataset', 'show', refName, '--compact'])).toBe(EXIT.ok)
    expect(outputJson()).toEqual(directView)

    const directRecords = await workspace.getRecordPage(refName, { offset: 0, limit: 2 })
    integrationStdout.length = 0
    expect(
      await run(['dataset', 'records', refName, '--offset', '0', '--limit', '2', '--compact']),
    ).toBe(EXIT.ok)
    expect(outputJson()).toEqual(directRecords)

    const directAudit = await workspace.audit(refName)
    integrationStdout.length = 0
    expect(await run(['dataset', 'audit', refName, '--compact'])).toBe(EXIT.ok)
    expect(outputJson()).toEqual(directAudit)

    integrationStdout.length = 0
    expect(await run(['converter', 'list', '--compact'])).toBe(EXIT.ok)
    expect(outputJson<{ items: unknown[]; total: number }>()).toEqual({
      items: [...workspace.listConverters()],
      total: workspace.listConverters().length,
    })
    integrationStdout.length = 0
    expect(await run(['converter', 'show', 'canonical-jsonl', '--compact'])).toBe(EXIT.ok)
    expect(outputJson()).toEqual(workspace.getConverter('canonical-jsonl'))
    integrationStdout.length = 0
    expect(await run(['converter', 'show', 'evalscope-general-qa', '--compact'])).toBe(EXIT.ok)
    expect(outputJson()).toEqual(workspace.getConverter('evalscope-general-qa'))

    integrationStdout.length = 0
    expect(await run(['transform', 'list', '--compact'])).toBe(EXIT.ok)
    expect(outputJson<{ items: unknown[]; total: number }>()).toEqual({
      items: [...workspace.listTransforms()],
      total: workspace.listTransforms().length,
    })

    const directPlan = await workspace.inspectExport(refName, {
      converter: fixture.export.converter,
      options: fixture.export.options,
    })
    integrationStdout.length = 0
    expect(
      await run([
        'dataset',
        'export',
        refName,
        '--converter',
        fixture.export.converter,
        '--inspect',
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    const cliPlan = outputJson<ExportPlanV2>()
    expect(cliPlan).toEqual(directPlan)
    expect(cliPlan).toMatchObject({
      dataset_version: fixture.expected_dataset_version,
      converter: fixture.export.converter,
      media_type: fixture.export.media_type,
      suggested_filename: fixture.export.suggested_filename,
      output_count: fixture.export.output_count,
    })

    const evalScopeOptions = { target_source: 'none' as const }
    const directEvalScopePlan = await workspace.inspectExport(refName, {
      converter: 'evalscope-general-qa',
      options: evalScopeOptions,
    })
    integrationStdout.length = 0
    expect(
      await run([
        'dataset',
        'export',
        refName,
        '--converter',
        'evalscope-general-qa',
        '--options',
        JSON.stringify(evalScopeOptions),
        '--inspect',
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    expect(outputJson()).toEqual(directEvalScopePlan)

    const outputPath = join(temporaryRoot, 'exported.jsonl')
    integrationStdout.length = 0
    expect(await run(['dataset', 'export', refName, '--output', outputPath, '--compact'])).toBe(
      EXIT.ok,
    )
    const exported = outputJson<{ path: string; plan: ExportPlanV2 }>()
    expect(exported).toEqual({ path: outputPath, plan: directPlan })
    expect((await readFile(outputPath, 'utf8')).trim().split('\n')).toHaveLength(
      fixture.export.output_count,
    )

    const transformedRef = `v13-subset-${randomUUID()}`
    integrationStdout.length = 0
    expect(
      await run([
        'transform',
        'run',
        'subset',
        '--input',
        fixture.expected_dataset_version,
        '--params',
        JSON.stringify({ record_ids: [FIRST_RECORD_ID] }),
        '--ref',
        transformedRef,
        '--message',
        'V13 subset',
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    const transformed = outputJson<{
      run: { output_dataset_version: string }
      manifest: unknown
    }>()
    expect(transformed.run.output_dataset_version).not.toBe(fixture.expected_dataset_version)

    const directLineage = await workspace.lineage(transformed.run.output_dataset_version, {
      max_depth: 4,
      max_nodes: 20,
      cursor: null,
    })
    integrationStdout.length = 0
    expect(
      await run([
        'lineage',
        'show',
        transformed.run.output_dataset_version,
        '--max-depth',
        '4',
        '--max-nodes',
        '20',
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    expect(outputJson()).toEqual(directLineage)

    integrationStdout.length = 0
    expect(await run(['ref', 'show', transformedRef, '--compact'])).toBe(EXIT.ok)
    expect(outputJson()).toEqual(await workspace.getRef(transformedRef))

    integrationStdout.length = 0
    expect(await run(['ref', 'list', '--limit', '500', '--compact'])).toBe(EXIT.ok)
    expect(outputJson<{ items: Array<{ name: string }> }>().items.map(({ name }) => name)).toEqual(
      expect.arrayContaining([refName, transformedRef]),
    )

    integrationStdout.length = 0
    expect(
      await run([
        'ref',
        'move',
        refName,
        transformed.run.output_dataset_version,
        '--expected-version',
        fixture.expected_dataset_version,
        '--message',
        'V13 ref move',
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    expect(outputJson<{ version: string }>().version).toBe(transformed.run.output_dataset_version)
    expect(stderr).toHaveLength(0)
  })

  test('CLI registration matches Workspace and replays a lost response without partial writes', async () => {
    const suffix = randomUUID()
    const request = {
      target: {
        kind: 'create_model' as const,
        key: `cli-registry-${suffix}`,
        display_name: 'CLI Registry Integration',
        description: 'ModelScope offline declared-only registration',
        task_family: 'chat',
        tags: ['cli', 'integration'],
      },
      version_label: 'r1',
      source: {
        kind: 'repository_reference' as const,
        provider: 'modelscope' as const,
        repository_id: 'Qwen/Qwen3-0.6B',
        revision: 'main',
        revision_kind: 'tag' as const,
        base_model: null,
      },
    }
    const requestPath = join(temporaryRoot, `${suffix}.model-registration.json`)
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 })

    const directPlan = await workspace.inspectModelRegistration(request)
    expect(
      await run(['model', 'registration', 'inspect', '--input', requestPath, '--compact']),
    ).toBe(EXIT.ok)
    expect(outputJson()).toEqual(directPlan)

    integrationStdout.length = 0
    expect(
      await run([
        'model',
        'registration',
        'commit',
        '--input',
        requestPath,
        '--expected-digest',
        '0'.repeat(64),
        '--compact',
      ]),
    ).toBe(EXIT.conflict)
    expect(
      await workspace.listModels({
        search: request.target.key,
        archive: 'all',
        cursor: null,
        limit: 10,
      }),
    ).toMatchObject({ items: [] })

    stderr.length = 0
    const committedBeforeResponseLoss = await workspace.commitModelRegistration({
      request,
      expected_registration_digest: directPlan.registration_digest,
    })
    integrationStdout.length = 0
    expect(
      await run([
        'model',
        'registration',
        'commit',
        '--input',
        requestPath,
        '--expected-digest',
        directPlan.registration_digest,
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    const replayed = outputJson<typeof committedBeforeResponseLoss>()
    expect(replayed).toEqual({ ...committedBeforeResponseLoss, replayed: true })

    integrationStdout.length = 0
    expect(
      await run(['model', 'versions', committedBeforeResponseLoss.model_id, '--compact']),
    ).toBe(EXIT.ok)
    expect(outputJson()).toEqual(
      await workspace.listModelVersions(committedBeforeResponseLoss.model_id, {
        cursor: null,
        limit: 20,
      }),
    )

    integrationStdout.length = 0
    expect(
      await run([
        'model',
        'deployment',
        'list',
        committedBeforeResponseLoss.model_version_id,
        '--compact',
      ]),
    ).toBe(EXIT.ok)
    expect(outputJson()).toEqual(
      await workspace.listModelVersionDeployments(committedBeforeResponseLoss.model_version_id, {
        cursor: null,
        limit: 20,
      }),
    )
    expect(stderr).toHaveLength(0)
  })
})

function outputJson<T>(): T {
  const length = integrationStdout.reduce((sum, part) => sum + part.byteLength, 0)
  const joined = new Uint8Array(length)
  let offset = 0
  for (const part of integrationStdout) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return JSON.parse(new TextDecoder().decode(joined)) as T
}
