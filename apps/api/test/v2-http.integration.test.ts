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
const MCP_CANONICAL_REF = `mcp-canonical-${randomUUID()}`
const MCP_CABLE_DIRECT_REF = `mcp-cable-direct-${randomUUID()}`
const MCP_CABLE_MATERIALIZED_REF = `mcp-cable-jsonl-${randomUUID()}`
const MCP_CABLE_INVALID_REF = `mcp-cable-invalid-${randomUUID()}`
const MCP_CABLE_MISMATCH_REF = `mcp-cable-mismatch-${randomUUID()}`

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

interface CableExpectedFixture {
  readonly source_workbook: {
    readonly record_count: number
  }
  readonly base_draft: ExpectedCableDraft
  readonly revised_no_system_draft: ExpectedCableDraft
  readonly jsonl_only_draft: ExpectedCableDraft
}

interface ExpectedCableDraft {
  readonly blake3: string
  readonly bytes: number
  readonly record_count: number
  readonly canonical_bytes?: number
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
      const draftPreviewResult = await responseJson<
        { input_digest: string } & Record<string, unknown>
      >(draftPreview)
      expect(draftPreviewResult).toMatchObject({
        format: 'canonical-draft-jsonl-v1',
        record_count: 1,
        records: [{ candidates: [expect.objectContaining({ signals: [] })] }],
      })
      expect(JSON.stringify(draftPreviewResult)).not.toMatch(/"(?:rec|cand|pref|sig)_[0-9a-f]{64}"/)

      const draftMaterializePrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-draft-jsonl-v1',
            action: 'materialize-jsonl',
            expected_input_digest: draftPreviewResult.input_digest,
          },
        }),
      )
      expect(draftMaterializePrepared).toMatchObject({
        response_kind: 'canonical-jsonl',
        side_effects: ['identity_claims'],
      })
      const materializedResponse = await app.fetch(
        new Request(String(draftMaterializePrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: draftJsonl,
        }),
      )
      expect(materializedResponse.status, await materializedResponse.clone().text()).toBe(200)
      expect(materializedResponse.headers.get('content-type')).toContain('application/x-ndjson')
      const materializedJsonl = await materializedResponse.text()
      expect(materializedJsonl).toMatch(/"id":"rec_[0-9a-f]{64}"/)
      expect(materializedJsonl).toMatch(/"id":"cand_[0-9a-f]{64}"/)

      const replayPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-draft-jsonl-v1',
            action: 'materialize-jsonl',
          },
        }),
      )
      const replay = await app.fetch(
        new Request(String(replayPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: draftJsonl,
        }),
      )
      expect(replay.status).toBe(200)
      expect(await replay.text()).toBe(materializedJsonl)

      const mismatchPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-draft-jsonl-v1',
            action: 'materialize-jsonl',
            expected_input_digest: draftPreviewResult.input_digest,
          },
        }),
      )
      const mismatch = await app.fetch(
        new Request(String(mismatchPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: `${draftJsonl} `,
        }),
      )
      expect(mismatch.status).toBe(422)
      expect(await responseJson(mismatch)).toMatchObject({
        error: {
          code: 'validation_error',
          detail: { issues: [expect.objectContaining({ code: 'input_digest_mismatch' })] },
        },
      })

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
          arguments: {
            format: 'canonical-jsonl',
            action: 'import-dataset',
            ref: MCP_CANONICAL_REF,
            expected_ref_version: null,
            message: 'MCP canonical import',
          },
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
      await expect(workspace.getRef(MCP_CANONICAL_REF)).resolves.toMatchObject({
        version: imported.dataset_version,
        message: 'MCP canonical import',
      })

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
          arguments: {
            format: 'canonical-jsonl',
            action: 'import-dataset',
            ref: MCP_CANONICAL_REF,
            expected_ref_version: null,
            message: 'MCP canonical import',
          },
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

  test('MCP imports the 499-row cable draft through direct, revised, and JSONL-only paths', async () => {
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
    const client = new Client(
      { name: 'databench-cable-integration', version: '1' },
      {
        capabilities: {},
      },
    )
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
    })
    const cableDraft = await readFile(
      new URL('./golden/fixtures/cable-attribute-sft-v1.draft.jsonl', import.meta.url),
      'utf8',
    )
    const expected = JSON.parse(
      await readFile(
        new URL('./golden/fixtures/cable-attribute-sft-v1.expected.json', import.meta.url),
        'utf8',
      ),
    ) as CableExpectedFixture
    const revisedDraft = transformCableDraft(cableDraft, (record) => {
      record.contents = record.contents.filter(({ role }) => role !== 'system')
    })
    const jsonlOnlyDraft = transformCableDraft(cableDraft, (record) => {
      record.tags = ['delivery:jsonl-only', ...record.tags]
    })
    const firstDraftLine = cableDraft.split('\n')[0]
    if (firstDraftLine === undefined || firstDraftLine.length === 0) {
      throw new Error('Cable draft fixture is empty')
    }
    const invalidGuardDraft = transformCableDraft(`${firstDraftLine}\n`, (record) => {
      record.source = { ...record.source, original_id: 'm1b3-invalid-guard-row-0' }
      record.candidates = []
    })
    expect(expected.source_workbook.record_count).toBe(499)
    expectCableDraftBytes(cableDraft, expected.base_draft)
    expectCableDraftBytes(revisedDraft, expected.revised_no_system_draft)
    expectCableDraftBytes(jsonlOnlyDraft, expected.jsonl_only_draft)
    const refsBefore = await workspace.listRefs({ cursor: null, limit: 100 })

    await client.connect(transport)
    try {
      const contract = await client.callTool({
        name: 'contract_get',
        arguments: { name: 'canonical-draft-import' },
      })
      expect(contract.isError).not.toBe(true)

      const invalidGuardPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: { format: 'canonical-draft-jsonl-v1', action: 'materialize-jsonl' },
        }),
      )
      const invalidGuardResponse = await app.fetch(
        new Request(String(invalidGuardPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: invalidGuardDraft,
        }),
      )
      expect(invalidGuardResponse.status).toBe(200)
      const invalidGuardDisposition = invalidGuardResponse.headers.get('content-disposition') ?? ''
      const invalidGuardVersion = /canonical-([0-9a-f]{64})\.jsonl/.exec(
        invalidGuardDisposition,
      )?.[1]
      if (invalidGuardVersion === undefined) throw new Error('Missing invalid guard version')
      await invalidGuardResponse.body?.cancel()

      const materializePrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-draft-jsonl-v1',
            action: 'materialize-jsonl',
            expected_input_digest: expected.jsonl_only_draft.blake3,
          },
        }),
      )
      expect(materializePrepared).toMatchObject({
        response_kind: 'canonical-jsonl',
        side_effects: ['identity_claims'],
      })
      const materializedResponse = await app.fetch(
        new Request(String(materializePrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: jsonlOnlyDraft,
        }),
      )
      expect(materializedResponse.status).toBe(200)
      const disposition = materializedResponse.headers.get('content-disposition') ?? ''
      const materializedVersion = /canonical-([0-9a-f]{64})\.jsonl/.exec(disposition)?.[1]
      if (materializedVersion === undefined) throw new Error('Missing materialized dataset version')
      const materializedCanonical = await materializedResponse.text()
      expect(materializedCanonical.split('\n')).toHaveLength(500)
      expect(Buffer.byteLength(materializedCanonical)).toBe(
        expected.jsonl_only_draft.canonical_bytes,
      )

      const unpublishedAfterMaterialize = await client.callTool({
        name: 'dataset_show',
        arguments: { dataset_version: materializedVersion },
      })
      expect(unpublishedAfterMaterialize.isError).toBe(true)

      const invalidPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-draft-jsonl-v1',
            action: 'import-dataset',
            ref: MCP_CABLE_INVALID_REF,
            expected_ref_version: null,
          },
        }),
      )
      const invalid = await app.fetch(
        new Request(String(invalidPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: `${invalidGuardDraft}{`,
        }),
      )
      expect(invalid.status).toBe(400)
      const unpublishedAfterInvalid = await client.callTool({
        name: 'dataset_show',
        arguments: { dataset_version: invalidGuardVersion },
      })
      expect(unpublishedAfterInvalid.isError).toBe(true)

      const mismatchPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-draft-jsonl-v1',
            action: 'import-dataset',
            ref: MCP_CABLE_MISMATCH_REF,
            expected_ref_version: null,
            expected_input_digest: '0'.repeat(64),
          },
        }),
      )
      const mismatch = await app.fetch(
        new Request(String(mismatchPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: jsonlOnlyDraft,
        }),
      )
      expect(mismatch.status).toBe(422)
      expect(await responseJson(mismatch)).toMatchObject({
        error: {
          code: 'validation_error',
          detail: { issues: [expect.objectContaining({ code: 'input_digest_mismatch' })] },
        },
      })
      const unpublishedAfterMismatch = await client.callTool({
        name: 'dataset_show',
        arguments: { dataset_version: materializedVersion },
      })
      expect(unpublishedAfterMismatch.isError).toBe(true)

      const directPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-draft-jsonl-v1',
            action: 'import-dataset',
            ref: MCP_CABLE_DIRECT_REF,
            expected_ref_version: null,
            message: 'MCP cable direct import',
            expected_input_digest: expected.base_draft.blake3,
          },
        }),
      )
      expect(directPrepared).toMatchObject({
        ref: MCP_CABLE_DIRECT_REF,
        side_effects: ['identity_claims', 'dataset_publish', 'ref_update'],
      })
      const directResponse = await app.fetch(
        new Request(String(directPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: cableDraft,
        }),
      )
      expect(directResponse.status).toBe(200)
      const direct = await responseJson<{
        dataset_version: string
        manifest: { num_records: number }
        ref_update: { status: string }
      }>(directResponse)
      expect(direct).toMatchObject({
        manifest: { num_records: 499 },
        ref_update: {
          status: 'updated',
          ref_name: MCP_CABLE_DIRECT_REF,
          previous_version: null,
          current_version: direct.dataset_version,
        },
      })

      const directShown = await client.callTool({
        name: 'dataset_show',
        arguments: { dataset_version: direct.dataset_version },
      })
      expect(directShown.structuredContent).toMatchObject({
        dataset_version: direct.dataset_version,
        manifest: { num_records: 499 },
      })
      const directExportPrepared = structured(
        await client.callTool({
          name: 'dataset_export_canonical_prepare',
          arguments: { dataset_version: direct.dataset_version },
        }),
      )
      const directExport = await app.fetch(new Request(String(directExportPrepared.get_url)))
      expect(directExport.status).toBe(200)
      const directCanonical = await directExport.text()
      expect(Buffer.byteLength(directCanonical)).toBe(expected.base_draft.canonical_bytes)
      const directCanonicalPreviewPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-jsonl',
            action: 'validate-preview',
            preview_records: 0,
          },
        }),
      )
      const directCanonicalPreview = await responseJson<{
        input_digest: string
        record_count: number
      }>(
        await app.fetch(
          new Request(String(directCanonicalPreviewPrepared.put_url), {
            method: 'PUT',
            headers: { 'content-type': 'application/x-ndjson' },
            body: directCanonical,
          }),
        ),
      )
      expect(directCanonicalPreview.record_count).toBe(499)
      const directReimportPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-jsonl',
            action: 'import-dataset',
            ref: MCP_CABLE_DIRECT_REF,
            expected_ref_version: direct.dataset_version,
            message: 'MCP cable direct import',
          },
        }),
      )
      const directReimport = await responseJson<{ dataset_version: string }>(
        await app.fetch(
          new Request(String(directReimportPrepared.put_url), {
            method: 'PUT',
            headers: { 'content-type': 'application/x-ndjson' },
            body: directCanonical,
          }),
        ),
      )
      expect(directReimport.dataset_version).toBe(direct.dataset_version)

      const revisedPreviewPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-draft-jsonl-v1',
            action: 'validate-preview',
            preview_records: 3,
          },
        }),
      )
      const revisedPreviewResponse = await app.fetch(
        new Request(String(revisedPreviewPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: revisedDraft,
        }),
      )
      expect(revisedPreviewResponse.status).toBe(200)
      const revisedPreview = await responseJson<{
        input_digest: string
        record_count: number
        records: Array<{ contents: Array<{ role: string }> }>
        records_truncated: boolean
      }>(revisedPreviewResponse)
      expect(revisedPreview).toMatchObject({
        input_digest: expected.revised_no_system_draft.blake3,
        record_count: 499,
        records_truncated: false,
      })
      expect(revisedPreview.records).toHaveLength(3)
      expect(revisedPreview.records.every(({ contents }) => contents[0]?.role === 'user')).toBe(
        true,
      )

      const revisedImportPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-draft-jsonl-v1',
            action: 'import-dataset',
            ref: MCP_CABLE_DIRECT_REF,
            expected_ref_version: direct.dataset_version,
            message: 'MCP cable revised import',
            expected_input_digest: revisedPreview.input_digest,
          },
        }),
      )
      const revisedResponse = await app.fetch(
        new Request(String(revisedImportPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: revisedDraft,
        }),
      )
      expect(revisedResponse.status).toBe(200)
      const revised = await responseJson<{
        dataset_version: string
        manifest: { num_records: number }
        ref_update: { status: string }
      }>(revisedResponse)
      expect(revised).toMatchObject({
        manifest: { num_records: 499 },
        ref_update: {
          status: 'updated',
          ref_name: MCP_CABLE_DIRECT_REF,
          previous_version: direct.dataset_version,
          current_version: revised.dataset_version,
        },
      })

      const canonicalPreviewPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-jsonl',
            action: 'validate-preview',
            preview_records: 0,
          },
        }),
      )
      const canonicalPreviewResponse = await app.fetch(
        new Request(String(canonicalPreviewPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: materializedCanonical,
        }),
      )
      expect(canonicalPreviewResponse.status).toBe(200)
      const canonicalPreview = await responseJson<{
        input_digest: string
        record_count: number
      }>(canonicalPreviewResponse)
      expect(canonicalPreview.record_count).toBe(499)

      const canonicalImportPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-jsonl',
            action: 'import-dataset',
            ref: MCP_CABLE_MATERIALIZED_REF,
            expected_ref_version: null,
            message: 'MCP cable canonical import',
          },
        }),
      )
      const canonicalImported = await responseJson<{
        dataset_version: string
        ref_update: { status: string }
      }>(
        await app.fetch(
          new Request(String(canonicalImportPrepared.put_url), {
            method: 'PUT',
            headers: { 'content-type': 'application/x-ndjson' },
            body: materializedCanonical,
          }),
        ),
      )
      expect(canonicalImported).toMatchObject({
        dataset_version: materializedVersion,
        ref_update: {
          status: 'updated',
          ref_name: MCP_CABLE_MATERIALIZED_REF,
          previous_version: null,
          current_version: materializedVersion,
        },
      })
      expect(
        new Set([direct.dataset_version, revised.dataset_version, materializedVersion]).size,
      ).toBe(3)

      const refsAfter = await workspace.listRefs({ cursor: null, limit: 100 })
      const refsBeforeNames = new Set(refsBefore.items.map(({ name }) => name))
      expect(
        refsAfter.items
          .filter(({ name }) => !refsBeforeNames.has(name))
          .map(({ name, version }) => ({ name, version }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      ).toEqual(
        [
          { name: MCP_CABLE_DIRECT_REF, version: revised.dataset_version },
          { name: MCP_CABLE_MATERIALIZED_REF, version: materializedVersion },
        ].toSorted((left, right) => left.name.localeCompare(right.name)),
      )
      expect(refsAfter.items.map(({ name }) => name)).not.toContain(MCP_CABLE_INVALID_REF)
      expect(refsAfter.items.map(({ name }) => name)).not.toContain(MCP_CABLE_MISMATCH_REF)
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

interface MutableCableDraftRecord {
  candidates: unknown[]
  contents: Array<{ role: string } & Record<string, unknown>>
  source: Record<string, unknown> & { original_id: string | null }
  tags: string[]
  [key: string]: unknown
}

function transformCableDraft(
  jsonl: string,
  transform: (record: MutableCableDraftRecord) => void,
): string {
  return `${jsonl
    .trimEnd()
    .split('\n')
    .map((line) => {
      const record = JSON.parse(line) as MutableCableDraftRecord
      transform(record)
      return JSON.stringify(record)
    })
    .join('\n')}\n`
}

function expectCableDraftBytes(jsonl: string, expected: ExpectedCableDraft): void {
  expect(Buffer.byteLength(jsonl)).toBe(expected.bytes)
  expect(jsonl.trimEnd().split('\n')).toHaveLength(expected.record_count)
}
