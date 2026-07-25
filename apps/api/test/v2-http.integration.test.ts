import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { V2Workspace } from '@databench/workspace'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTestApp } from './test-app.js'

const runIntegration = process.env.RUN_MINIO_STORE_TESTS === 'true'
const FIRST_ID = `rec_${'1'.repeat(64)}`
const SECOND_ID = `rec_${'2'.repeat(64)}`
const REF_NAME = `v12-http-${randomUUID()}`

interface CliV2Fixture {
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

describe.runIf(runIntegration)('V2 HTTP API against real MinIO and Postgres', () => {
  let temporaryRoot: string
  let workspace: V2Workspace
  let cliFixture: CliV2Fixture
  let fixtureRecords: unknown[]

  beforeAll(async () => {
    cliFixture = JSON.parse(
      await readFile(
        new URL('../../cli/test/golden/fixtures/v2/cli-v2-lifecycle.fixture.json', import.meta.url),
        'utf8',
      ),
    ) as CliV2Fixture
    const recordFixture = JSON.parse(
      await readFile(new URL(`../../../${cliFixture.record_source}`, import.meta.url), 'utf8'),
    ) as { records: unknown[] }
    fixtureRecords = recordFixture.records
    temporaryRoot = await mkdtemp(join(tmpdir(), 'databench-v12-http-'))
    workspace = await V2Workspace.open({
      root: temporaryRoot,
      cursorSecret: 'v12-http-integration-cursor-secret',
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
  })

  afterAll(async () => {
    await workspace?.close()
    if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true })
  })

  test('ingest → read → audit → transform → lineage → inspect → export', async () => {
    const app = createTestApp({ v2Workspace: workspace })
    const form = new FormData()
    form.set(
      'file',
      new File(
        [`${fixtureRecords.map((record) => JSON.stringify(record)).join('\n')}\n`],
        'v12.jsonl',
      ),
    )
    form.set('ref', REF_NAME)
    form.set('message', 'V12 real HTTP lifecycle')

    const ingestedResponse = await app.fetch(
      request('/v2/datasets:ingest-jsonl', { method: 'POST', body: form }),
    )
    expect(ingestedResponse.status).toBe(200)
    const ingested = await responseJson<{
      dataset_version: string
      manifest: { num_records: number }
    }>(ingestedResponse)
    expect(ingested.dataset_version).toBe(cliFixture.expected_dataset_version)
    expect(ingested.manifest.num_records).toBe(cliFixture.export.output_count)

    const described = await responseJson(await app.fetch(request(`/v2/datasets/${REF_NAME}`)))
    const directView = await workspace.describeDataset(REF_NAME)
    expect(described).toEqual(directView)
    expect(ingested.manifest).toEqual(directView.manifest)

    const sharedInspectResponse = await app.fetch(
      request(`/v2/datasets/${REF_NAME}:inspect-export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          converter: cliFixture.export.converter,
          options: cliFixture.export.options,
        }),
      }),
    )
    expect(sharedInspectResponse.status).toBe(200)
    const directSharedPlan = await workspace.inspectExport(REF_NAME, {
      converter: cliFixture.export.converter,
      options: cliFixture.export.options,
    })
    expect(await responseJson(sharedInspectResponse)).toEqual(directSharedPlan)

    const page = await responseJson<{
      dataset_version: string
      items: Array<{ record_id: string }>
    }>(await app.fetch(request(`/v2/datasets/${ingested.dataset_version}/records?limit=20`)))
    expect(page.dataset_version).toBe(ingested.dataset_version)
    expect(page.items.map(({ record_id }) => record_id).sort()).toEqual([
      FIRST_ID,
      SECOND_ID,
      `rec_${'3'.repeat(64)}`,
    ])

    const audit = await app.fetch(
      request(`/v2/datasets/${ingested.dataset_version}:audit`, { method: 'POST' }),
    )
    expect(audit.status).toBe(200)
    expect(await responseJson(audit)).toMatchObject({ checks: { dataset_version: 'ok' } })

    const transformedResponse = await app.fetch(
      request('/v2/transforms/subset/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          inputs: [ingested.dataset_version],
          params: { record_ids: [FIRST_ID] },
          ref: null,
          expected_ref_version: null,
          message: null,
        }),
      }),
    )
    expect(transformedResponse.status).toBe(200)
    const transformed = await responseJson<{
      run: { output_dataset_version: string; input_dataset_versions: string[] }
    }>(transformedResponse)
    expect(transformed.run.input_dataset_versions).toEqual([ingested.dataset_version])
    expect(transformed.run.output_dataset_version).not.toBe(ingested.dataset_version)

    const lineage = await responseJson<{
      root_dataset_version: string
      edges: Array<{ input_dataset_versions: string[] }>
    }>(
      await app.fetch(
        request(`/v2/lineage/${transformed.run.output_dataset_version}?max_depth=4&max_nodes=20`),
      ),
    )
    expect(lineage.root_dataset_version).toBe(transformed.run.output_dataset_version)
    expect(lineage.edges).toContainEqual(
      expect.objectContaining({ input_dataset_versions: [ingested.dataset_version] }),
    )

    const inspectResponse = await app.fetch(
      request(`/v2/datasets/${transformed.run.output_dataset_version}:inspect-export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ converter: 'canonical-jsonl', options: {} }),
      }),
    )
    expect(inspectResponse.status).toBe(200)
    const plan = await responseJson<{ fidelity_digest: string }>(inspectResponse)

    const exported = await app.fetch(
      request(`/v2/datasets/${transformed.run.output_dataset_version}:export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          converter: 'canonical-jsonl',
          options: {},
          accepted_fidelity_digest: plan.fidelity_digest,
        }),
      }),
    )
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toBe('application/x-ndjson')
    const exportedText = await exported.text()
    expect(exportedText).toContain(FIRST_ID)
    expect(exportedText).not.toContain(SECOND_ID)
  })

  test('MCP preview → import → show → canonical export → idempotent reimport', async () => {
    const app = createTestApp({
      v2Workspace: workspace,
      mcp: {
        enabled: true,
        authMode: 'none',
        publicBaseUrl: 'http://localhost',
        allowedOrigins: [],
        maxJsonBytes: 1024 * 1024,
        maxPreviewResponseBytes: 1024 * 1024,
        maxTokens: 128,
        maxActiveFileOperations: 2,
        tokenTtlMs: 15 * 60 * 1000,
        fileIdleTimeoutMs: 60 * 1000,
        fileTotalTimeoutMs: 30 * 60 * 1000,
      },
    })
    const client = new Client({ name: 'databench-integration', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    try {
      const jsonl = `${fixtureRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
      const contract = await client.callTool({
        name: 'contract_get',
        arguments: { name: 'canonical-jsonl' },
      })
      expect(contract.isError).not.toBe(true)

      const draftContract = structured(
        await client.callTool({
          name: 'contract_get',
          arguments: { name: 'canonical-draft-import' },
        }),
      )
      const draftJsonl = (draftContract.examples as Array<{ name: string; jsonl: string }>).find(
        ({ name }) => name === 'sft',
      )?.jsonl
      if (draftJsonl === undefined) throw new Error('Draft SFT contract example is missing')
      const draftPreviewPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-draft-jsonl-v1',
            action: 'validate-preview',
            preview_records: 1,
          },
        }),
      )
      const draftPreview = await app.fetch(
        new Request(String(draftPreviewPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: draftJsonl,
        }),
      )
      expect(draftPreview.status).toBe(200)
      const draftPreviewResult = await responseJson(draftPreview)
      expect(draftPreviewResult).toMatchObject({
        format: 'canonical-draft-jsonl-v1',
        record_count: 1,
        records: [{ candidates: [expect.objectContaining({ signals: [] })] }],
      })
      expect(JSON.stringify(draftPreviewResult)).not.toMatch(/"(?:rec|cand|pref|sig)_[0-9a-f]{64}"/)

      const previewPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-jsonl',
            action: 'validate-preview',
            preview_records: 2,
          },
        }),
      )
      const preview = await app.fetch(
        new Request(String(previewPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: jsonl,
        }),
      )
      expect(preview.status).toBe(200)
      expect(await responseJson(preview)).toMatchObject({ record_count: 3 })

      const importPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: { format: 'canonical-jsonl', action: 'import-dataset' },
        }),
      )
      const imported = await responseJson<{ dataset_version: string }>(
        await app.fetch(
          new Request(String(importPrepared.put_url), {
            method: 'PUT',
            headers: { 'content-type': 'application/x-ndjson' },
            body: jsonl,
          }),
        ),
      )
      expect(imported.dataset_version).toBe(cliFixture.expected_dataset_version)

      const shown = await client.callTool({
        name: 'dataset_show',
        arguments: { dataset_version: imported.dataset_version },
      })
      expect(shown.structuredContent).toMatchObject({
        dataset_version: imported.dataset_version,
        manifest: { num_records: 3 },
      })

      const exportPrepared = structured(
        await client.callTool({
          name: 'dataset_export_canonical_prepare',
          arguments: { dataset_version: imported.dataset_version },
        }),
      )
      const exported = await app.fetch(new Request(String(exportPrepared.get_url)))
      expect(exported.status).toBe(200)
      const exportedJsonl = await exported.text()

      const reimportPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: { format: 'canonical-jsonl', action: 'import-dataset' },
        }),
      )
      const reimported = await responseJson<{ dataset_version: string }>(
        await app.fetch(
          new Request(String(reimportPrepared.put_url), {
            method: 'PUT',
            headers: { 'content-type': 'application/x-ndjson' },
            body: exportedJsonl,
          }),
        ),
      )
      expect(reimported.dataset_version).toBe(imported.dataset_version)
    } finally {
      await client.close()
    }
  })
})

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init)
}

async function responseJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function structured(result: {
  structuredContent?: Record<string, unknown>
}): Record<string, unknown> {
  if (result.structuredContent === undefined) throw new Error('Expected structured MCP result')
  return result.structuredContent
}
