import {
  type CanonicalDraftRecordV1,
  CanonicalDraftRecordV1Schema,
  createExportPlanV2,
  createRecordRevisionV2,
  NotFoundError,
  type PostTrainingRecordV2,
  PostTrainingRecordV2Schema,
} from '@databench/schema'
import { postTrainingV2Capability } from '@databench/workspace'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, test } from 'vitest'
import { createOpenApiDocument } from '../src/app.js'
import type { ApiV2Workspace } from '../src/context.js'
import type { McpEnabledConfig } from '../src/mcp/config.js'
import { createTestApp } from './test-app.js'

const VERSION = 'a'.repeat(64)
const ARTIFACT_DIGEST = 'b'.repeat(64)
const INPUT_DIGEST = 'c'.repeat(64)
const encoder = new TextEncoder()

const record: PostTrainingRecordV2 = PostTrainingRecordV2Schema.parse({
  schema_version: '2.0.0',
  id: `rec_${'1'.repeat(64)}`,
  contents: [
    {
      role: 'user',
      parts: [
        {
          type: 'text',
          text: 'hello MCP',
          thought: false,
          thought_signature: null,
          part_metadata: {},
        },
      ],
      loss_weight: 0,
    },
  ],
  candidates: [],
  preference_relations: [],
  tools: [],
  verification: null,
  source: null,
  lang: null,
  lineage: null,
  tags: [],
  extra: {},
})
const revision = createRecordRevisionV2(record)
const draftRecord: CanonicalDraftRecordV1 = CanonicalDraftRecordV1Schema.parse({
  draft_schema_version: '1.0.0',
  schema_version: '2.0.0',
  contents: record.contents,
})
const manifest = {
  manifest_version: '2.0.0' as const,
  identity_profile: 'databench-v2-jcs-1' as const,
  dataset_version: VERSION,
  record_schema_version: '2.0.0' as const,
  hash_algorithm: 'blake3' as const,
  num_records: 1,
  layout_version: 'record-json-v1' as const,
  artifact_digest: ARTIFACT_DIGEST,
  artifact_size_bytes: 512,
  columns: ['record_id', 'record_digest', 'record_json'] as [
    'record_id',
    'record_digest',
    'record_json',
  ],
}
const exportPlan = createExportPlanV2({
  export_fidelity_profile: 'databench-export-fidelity-1',
  dataset_version: VERSION,
  converter: 'canonical-jsonl',
  converter_version: '1',
  normalized_options: {},
  media_type: 'application/x-ndjson',
  suggested_filename: 'dataset.jsonl',
  output_count: 1,
  config_hints: {},
  fidelity: { preserved: ['/'], changes: [] },
})

describe('MCP canonical vertical slice', () => {
  test('is disabled by default and does not change OpenAPI', async () => {
    const app = createTestApp({ v2Workspace: fakeWorkspace().workspace })
    expect((await app.fetch(request('/mcp'))).status).toBe(404)
    expect((await app.fetch(request('/mcp-files/process/unknown'))).status).toBe(404)

    const baseline = createOpenApiDocument({ version: '1.2.3' })
    const enabled = createOpenApiDocument({ version: '1.2.3', mcp: mcpConfig() })
    expect(enabled).toEqual(baseline)
  })

  test('serves initialize, lists four tools, and returns structured contracts', async () => {
    const fake = fakeWorkspace()
    const app = createTestApp({
      version: '1.2.3',
      v2Workspace: fake.workspace,
      mcp: mcpConfig(),
    })
    const client = new Client({ name: 'databench-test', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL('http://databench.test/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    try {
      expect(client.getInstructions()).toContain('map raw Excel and CSV rows')
      expect(client.getInstructions()).toContain(
        'draft materialization and dataset import are not available yet',
      )
      const tools = await client.listTools()
      expect(tools.tools.map(({ name }) => name)).toEqual([
        'contract_get',
        'data_process_prepare',
        'dataset_show',
        'dataset_export_canonical_prepare',
      ])
      const processTool = tools.tools.find(({ name }) => name === 'data_process_prepare')
      expect(processTool?.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        oneOf: [
          {
            properties: {
              action: { const: 'validate-preview' },
              format: { enum: ['canonical-jsonl', 'canonical-draft-jsonl-v1'] },
            },
          },
          {
            properties: { action: { const: 'import-dataset' } },
            additionalProperties: false,
          },
        ],
      })
      const contractTool = tools.tools.find(({ name }) => name === 'contract_get')
      expect(contractTool?.outputSchema).toMatchObject({
        type: 'object',
        oneOf: [
          { properties: { name: { const: 'canonical-jsonl' } } },
          { properties: { name: { const: 'canonical-draft-import' } } },
        ],
      })
      expect(JSON.stringify(contractTool?.outputSchema)).not.toContain('"$ref"')
      expect(processTool?.outputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        oneOf: [
          {
            properties: {
              action: { const: 'validate-preview' },
              response_kind: { const: 'json-preview' },
            },
          },
          {
            properties: {
              action: { const: 'import-dataset' },
              response_kind: { const: 'json-ingest-result' },
            },
          },
        ],
      })

      const contract = await client.callTool({
        name: 'contract_get',
        arguments: { name: 'canonical-jsonl' },
      })
      expect(contract.isError, JSON.stringify(contract)).not.toBe(true)
      expect(contract.structuredContent).toMatchObject({
        name: 'canonical-jsonl',
        version: '2.0.0',
        examples: [{ name: 'sft' }, { name: 'dpo' }, { name: 'rlvr' }],
      })

      const draftContract = structured(
        await client.callTool({
          name: 'contract_get',
          arguments: { name: 'canonical-draft-import' },
        }),
      )
      expect(draftContract).toMatchObject({
        name: 'canonical-draft-import',
        version: '1.0.0',
        schema: {
          required: ['draft_schema_version', 'schema_version', 'contents'],
        },
        examples: [{ name: 'sft' }, { name: 'dpo' }, { name: 'rlvr' }],
      })
      for (const example of draftContract.examples as Array<{ jsonl: string }>) {
        expect(() => CanonicalDraftRecordV1Schema.parse(JSON.parse(example.jsonl))).not.toThrow()
      }

      const invalid = await client.callTool({
        name: 'data_process_prepare',
        arguments: {
          format: 'canonical-jsonl',
          action: 'import-dataset',
          preview_records: 2,
        },
      })
      expect(invalid.isError).toBe(true)
    } finally {
      await client.close()
    }
  })

  test('previews, imports, shows, and exports through one-time URLs', async () => {
    const fake = fakeWorkspace()
    const app = createTestApp({ v2Workspace: fake.workspace, mcp: mcpConfig() })
    const client = new Client({ name: 'databench-test', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL('http://databench.test/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    try {
      const previewPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: {
            format: 'canonical-jsonl',
            action: 'validate-preview',
            preview_records: 1,
          },
        }),
      )
      const preview = await app.fetch(
        new Request(String(previewPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: canonicalLine(),
        }),
      )
      expect(preview.status).toBe(200)
      expect(await preview.json()).toMatchObject({
        format: 'canonical-jsonl',
        input_digest: INPUT_DIGEST,
        record_count: 1,
        records: [{ id: record.id }],
      })
      expect(fake.state.previewCalls).toBe(1)
      expect(fake.state.importCalls).toBe(0)
      expect(
        (await app.fetch(new Request(String(previewPrepared.put_url), { method: 'PUT' }))).status,
      ).toBe(400)

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
      expect(draftPreviewPrepared).toMatchObject({
        format: 'canonical-draft-jsonl-v1',
        action: 'validate-preview',
        side_effects: [],
      })
      const draftPreview = await app.fetch(
        new Request(String(draftPreviewPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: draftLine(),
        }),
      )
      expect(draftPreview.status).toBe(200)
      const draftPreviewBody = await draftPreview.json()
      expect(draftPreviewBody).toMatchObject({
        format: 'canonical-draft-jsonl-v1',
        input_digest: INPUT_DIGEST,
        record_count: 1,
        records: [{ candidates: [], extra: {} }],
      })
      expect(JSON.stringify(draftPreviewBody)).not.toMatch(/"(?:id|supersedes)":/)
      expect(fake.state.draftPreviewCalls).toBe(1)
      expect(fake.state.importCalls).toBe(0)

      const unavailableDraftImport = await client.callTool({
        name: 'data_process_prepare',
        arguments: { format: 'canonical-draft-jsonl-v1', action: 'import-dataset' },
      })
      expect(unavailableDraftImport.isError).toBe(true)

      const importPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: { format: 'canonical-jsonl', action: 'import-dataset' },
        }),
      )
      const imported = await app.fetch(
        new Request(String(importPrepared.put_url), {
          method: 'PUT',
          headers: { 'content-type': 'application/x-ndjson' },
          body: canonicalLine(),
        }),
      )
      expect(imported.status).toBe(200)
      expect(await imported.json()).toMatchObject({ dataset_version: VERSION })
      expect(fake.state.importCalls).toBe(1)

      const shown = await client.callTool({
        name: 'dataset_show',
        arguments: { dataset_version: VERSION },
      })
      expect(shown.structuredContent).toMatchObject({ dataset_version: VERSION })

      const exportPrepared = structured(
        await client.callTool({
          name: 'dataset_export_canonical_prepare',
          arguments: { dataset_version: VERSION },
        }),
      )
      const exported = await app.fetch(new Request(String(exportPrepared.get_url)))
      expect(exported.status).toBe(200)
      expect(exported.headers.get('content-type')).toContain('application/x-ndjson')
      expect(await exported.text()).toBe(canonicalLine())
      expect((await app.fetch(new Request(String(exportPrepared.get_url)))).status).toBe(400)
    } finally {
      await client.close()
    }
  })

  test('enforces method, Origin, JSON body, and companion content type boundaries', async () => {
    const fake = fakeWorkspace()
    const app = createTestApp({
      v2Workspace: fake.workspace,
      mcp: mcpConfig({ maxJsonBytes: 2_048 }),
    })

    const method = await app.fetch(request('/mcp'))
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('POST')
    expect(method.headers.get('cache-control')).toBe('private, no-store')
    expect(method.headers.get('x-content-type-options')).toBe('nosniff')

    const forbidden = await app.fetch(
      request('/mcp', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
    )
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.get('cache-control')).toBe('private, no-store')

    const tooLarge = await app.fetch(
      mcpRequest({ jsonrpc: '2.0', id: 1, method: 'x'.repeat(4_096) }),
    )
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toMatchObject({ error: { code: -32_000 } })

    const malformed = await app.fetch(
      new Request('http://databench.test/mcp', {
        method: 'POST',
        headers: mcpHeaders(),
        body: '{',
      }),
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: { code: -32_700 } })

    const prepared = await prepareRaw(app, 'validate-preview')
    const wrongType = await app.fetch(
      new Request(String(prepared.put_url), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: canonicalLine(),
      }),
    )
    expect(wrongType.status).toBe(400)
    expect(await wrongType.json()).toMatchObject({ error: { code: 'bad_request' } })
  })

  test('serves allowlisted MCP CORS without leaking companion bearer tokens', async () => {
    const origin = 'https://agent.internal'
    const app = createTestApp({
      v2Workspace: fakeWorkspace().workspace,
      mcp: mcpConfig({ allowedOrigins: [origin] }),
    })

    const preflight = await app.fetch(
      request('/mcp', {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')

    const method = await app.fetch(request('/mcp', { headers: { origin } }))
    expect(method.status).toBe(405)
    expect(method.headers.get('access-control-allow-origin')).toBe(origin)

    const prepared = await prepareRaw(app, 'validate-preview')
    const putUrl = String(prepared.put_url)
    const token = new URL(putUrl).pathname.split('/').at(-1)
    expect(token).toMatch(/^proc_/)
    for (const url of [putUrl, `${putUrl}/unknown`]) {
      const notFound = await app.fetch(new Request(url))
      expect(notFound.status).toBe(404)
      const body = JSON.stringify(await notFound.json())
      expect(body).not.toContain(String(token))
      expect(body).not.toContain('proc_')
      expect(body).toContain('/mcp-files/*')
    }
  })

  test('sanitizes unknown tool failures and preserves typed domain errors', async () => {
    const fake = fakeWorkspace()
    const app = createTestApp({ v2Workspace: fake.workspace, mcp: mcpConfig() })
    const client = new Client({ name: 'databench-test', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL('http://databench.test/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    try {
      fake.state.describeError = new Error('secret path: /srv/databench/private/catalog')
      const unknown = await client.callTool({
        name: 'dataset_show',
        arguments: { dataset_version: VERSION },
      })
      expect(unknown.isError).toBe(true)
      expect(JSON.stringify(unknown)).toContain('internal server error')
      expect(JSON.stringify(unknown)).not.toContain('/srv/databench/private/catalog')

      fake.state.describeError = new NotFoundError(
        'Dataset does not exist at /srv/databench/private/catalog',
      )
      const typed = await client.callTool({
        name: 'dataset_show',
        arguments: { dataset_version: VERSION },
      })
      expect(typed.isError).toBe(true)
      expect(JSON.stringify(typed)).toContain('not_found')
      expect(JSON.stringify(typed)).toContain('Requested resource was not found')
      expect(JSON.stringify(typed)).not.toContain('/srv/databench/private/catalog')
    } finally {
      await client.close()
    }
  })

  test('returns retryable 429 without consuming a ready file token', async () => {
    const fake = fakeWorkspace()
    const gate = deferred<void>()
    fake.state.previewGate = gate.promise
    const app = createTestApp({
      v2Workspace: fake.workspace,
      mcp: mcpConfig({ maxActiveFileOperations: 1 }),
    })
    const client = new Client({ name: 'databench-test', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL('http://databench.test/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    try {
      const firstPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: { format: 'canonical-jsonl', action: 'validate-preview' },
        }),
      )
      const secondPrepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: { format: 'canonical-jsonl', action: 'validate-preview' },
        }),
      )
      const firstResponse = app.fetch(processRequest(String(firstPrepared.put_url)))
      await eventually(() => fake.state.previewCalls === 1)

      const duplicate = await app.fetch(processRequest(String(firstPrepared.put_url)))
      expect(duplicate.status).toBe(400)
      expect(await duplicate.json()).toMatchObject({
        error: { code: 'bad_request', detail: { issues: [{ code: 'token_invalid_or_used' }] } },
      })

      const busy = await app.fetch(processRequest(String(secondPrepared.put_url)))
      expect(busy.status).toBe(429)
      expect(busy.headers.get('retry-after')).toBe('1')
      expect(await busy.json()).toMatchObject({
        error: { code: 'too_many_requests', detail: { retry_after_seconds: 1 } },
      })

      gate.resolve()
      expect((await firstResponse).status).toBe(200)
      expect((await app.fetch(processRequest(String(secondPrepared.put_url)))).status).toBe(200)
    } finally {
      gate.resolve()
      await client.close()
    }
  })

  test('times out an idle upload, cancels its body, and deletes the token', async () => {
    const fake = fakeWorkspace()
    const app = createTestApp({
      v2Workspace: fake.workspace,
      mcp: mcpConfig({ fileIdleTimeoutMs: 10, fileTotalTimeoutMs: 100 }),
    })
    const client = new Client({ name: 'databench-test', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL('http://databench.test/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    const prepared = structured(
      await client.callTool({
        name: 'data_process_prepare',
        arguments: { format: 'canonical-jsonl', action: 'validate-preview' },
      }),
    )
    await client.close()

    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Keep the body idle until the server-side deadline cancels it.
      },
      cancel(reason) {
        cancelReason = reason
      },
    })
    const timedOut = await app.fetch(
      new Request(String(prepared.put_url), {
        method: 'PUT',
        headers: { 'content-type': 'application/x-ndjson' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    )
    expect(timedOut.status).toBe(503)
    expect(await timedOut.json()).toMatchObject({
      error: {
        code: 'service_unavailable',
        detail: { dependency: 'unknown', retryable: true },
      },
    })
    expect(cancelReason).toMatchObject({ name: 'TimeoutError' })
    expect((await app.fetch(processRequest(String(prepared.put_url)))).status).toBe(400)
  })

  test('enforces total timeout on a continuously producing upload', async () => {
    const fake = fakeWorkspace()
    const app = createTestApp({
      v2Workspace: fake.workspace,
      mcp: mcpConfig({ fileIdleTimeoutMs: 1_000, fileTotalTimeoutMs: 30 }),
    })
    const prepared = await prepareRaw(app, 'validate-preview')
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
        controller.enqueue(Uint8Array.of(0x20))
      },
      cancel(reason) {
        cancelReason = reason
      },
    })
    const response = await app.fetch(
      new Request(String(prepared.put_url), {
        method: 'PUT',
        headers: { 'content-type': 'application/x-ndjson' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    )

    expect(response.status).toBe(503)
    expect(cancelReason).toMatchObject({ name: 'TimeoutError' })
    expect(fake.state.previewSignal?.aborted).toBe(true)
  })

  test('propagates an aborted companion PUT signal into Workspace', async () => {
    const fake = fakeWorkspace()
    const gate = deferred<void>()
    fake.state.previewGate = gate.promise
    const app = createTestApp({ v2Workspace: fake.workspace, mcp: mcpConfig() })
    const prepared = await prepareRaw(app, 'validate-preview')
    const controller = new AbortController()
    const responsePromise = app.fetch(
      new Request(String(prepared.put_url), {
        method: 'PUT',
        headers: { 'content-type': 'application/x-ndjson' },
        body: canonicalLine(),
        signal: controller.signal,
      }),
    )
    await eventually(() => fake.state.previewCalls === 1)
    controller.abort(new DOMException('test companion abort', 'AbortError'))

    expect((await responsePromise).status).toBe(500)
    expect(fake.state.previewSignal?.aborted).toBe(true)
    expect((await app.fetch(processRequest(String(prepared.put_url)))).status).toBe(400)
    gate.resolve()
  })

  test('releases an export slot on total timeout when the client stops reading', async () => {
    const fake = fakeWorkspace()
    const gate = deferred<void>()
    fake.state.exportGate = gate.promise
    const app = createTestApp({
      v2Workspace: fake.workspace,
      mcp: mcpConfig({
        maxActiveFileOperations: 1,
        fileIdleTimeoutMs: 1_000,
        fileTotalTimeoutMs: 30,
      }),
    })
    const client = new Client({ name: 'databench-test', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL('http://databench.test/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    const exportPrepared = structured(
      await client.callTool({
        name: 'dataset_export_canonical_prepare',
        arguments: { dataset_version: VERSION },
      }),
    )
    const processPrepared = structured(
      await client.callTool({
        name: 'data_process_prepare',
        arguments: { format: 'canonical-jsonl', action: 'validate-preview' },
      }),
    )
    await client.close()

    const response = await app.fetch(new Request(String(exportPrepared.get_url)))
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('Expected export response body')
    expect(await reader.read()).toMatchObject({ done: false })

    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    expect((await app.fetch(processRequest(String(processPrepared.put_url)))).status).toBe(200)

    gate.resolve()
    await reader.cancel().catch(() => undefined)
  })

  test('does not release an export slot before an abort-ignoring iterator is cleaned up', async () => {
    const fake = fakeWorkspace()
    const gate = deferred<void>()
    fake.state.exportGate = gate.promise
    fake.state.exportIgnoresAbort = true
    const app = createTestApp({
      v2Workspace: fake.workspace,
      mcp: mcpConfig({
        maxActiveFileOperations: 1,
        fileIdleTimeoutMs: 1_000,
        fileTotalTimeoutMs: 30,
      }),
    })
    const client = new Client({ name: 'databench-test', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL('http://databench.test/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    const exportPrepared = structured(
      await client.callTool({
        name: 'dataset_export_canonical_prepare',
        arguments: { dataset_version: VERSION },
      }),
    )
    const processPrepared = structured(
      await client.callTool({
        name: 'data_process_prepare',
        arguments: { format: 'canonical-jsonl', action: 'validate-preview' },
      }),
    )
    await client.close()

    const response = await app.fetch(new Request(String(exportPrepared.get_url)))
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('Expected export response body')
    expect(await reader.read()).toMatchObject({ done: false })
    await new Promise<void>((resolve) => setTimeout(resolve, 60))

    await expect(reader.read()).rejects.toMatchObject({ name: 'TimeoutError' })

    const busy = await app.fetch(processRequest(String(processPrepared.put_url)))
    expect(busy.status).toBe(429)
    gate.resolve()
    expect(await fetchWhenFileSlotIsReady(app, String(processPrepared.put_url))).toBe(200)
    await reader.cancel().catch(() => undefined)
  })

  test('releases an export slot immediately when the client cancels', async () => {
    const fake = fakeWorkspace()
    const gate = deferred<void>()
    fake.state.exportGate = gate.promise
    const app = createTestApp({
      v2Workspace: fake.workspace,
      mcp: mcpConfig({ maxActiveFileOperations: 1 }),
    })
    const client = new Client({ name: 'databench-test', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL('http://databench.test/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
    })
    await client.connect(transport)
    const exportPrepared = structured(
      await client.callTool({
        name: 'dataset_export_canonical_prepare',
        arguments: { dataset_version: VERSION },
      }),
    )
    const processPrepared = structured(
      await client.callTool({
        name: 'data_process_prepare',
        arguments: { format: 'canonical-jsonl', action: 'validate-preview' },
      }),
    )
    await client.close()

    const response = await app.fetch(new Request(String(exportPrepared.get_url)))
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('Expected export response body')
    expect(await reader.read()).toMatchObject({ done: false })
    const cancelled = reader.cancel(new DOMException('test client cancel', 'AbortError'))

    await cancelled
    expect((await app.fetch(processRequest(String(processPrepared.put_url)))).status).toBe(200)
    gate.resolve()
  })

  test('cancels a pending MCP JSON body read when the HTTP request aborts', async () => {
    const app = createTestApp({ v2Workspace: fakeWorkspace().workspace, mcp: mcpConfig() })
    const controller = new AbortController()
    let pulled = false
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true
      },
      cancel(reason) {
        cancelReason = reason
      },
    })
    const responsePromise = app.fetch(
      new Request('http://databench.test/mcp', {
        method: 'POST',
        headers: mcpHeaders(),
        body,
        duplex: 'half',
        signal: controller.signal,
      } as RequestInit & { duplex: 'half' }),
    )
    await eventually(() => pulled)
    controller.abort(new DOMException('test request abort', 'AbortError'))

    const response = await responsePromise
    expect(response.status).toBe(499)
    expect(cancelReason).toMatchObject({ name: 'AbortError' })
  })
})

interface FakeState {
  describeError?: unknown
  draftPreviewCalls: number
  exportGate?: Promise<void>
  exportIgnoresAbort?: boolean
  importCalls: number
  previewCalls: number
  previewGate?: Promise<void>
  previewSignal?: AbortSignal
}

function fakeWorkspace(): { workspace: ApiV2Workspace; state: FakeState } {
  const state: FakeState = { draftPreviewCalls: 0, importCalls: 0, previewCalls: 0 }
  const workspace = {
    postTrainingV2Capability: () => postTrainingV2Capability(),
    async previewCanonicalJsonl(
      source: AsyncIterable<Uint8Array>,
      options: { previewRecords?: number },
      execution?: { signal?: AbortSignal },
    ) {
      state.previewSignal = execution?.signal
      await collect(source)
      state.previewCalls += 1
      await waitForGateOrAbort(state.previewGate, execution?.signal)
      return {
        format: 'canonical-jsonl' as const,
        input_digest: INPUT_DIGEST,
        record_count: 1,
        records: options.previewRecords === 0 ? [] : [record],
        records_truncated: options.previewRecords === 0,
      }
    },
    async previewCanonicalDraftJsonl(
      source: AsyncIterable<Uint8Array>,
      options: { previewRecords?: number },
      execution?: { signal?: AbortSignal },
    ) {
      state.previewSignal = execution?.signal
      await collect(source)
      state.draftPreviewCalls += 1
      await waitForGateOrAbort(state.previewGate, execution?.signal)
      return {
        format: 'canonical-draft-jsonl-v1' as const,
        input_digest: INPUT_DIGEST,
        record_count: 1,
        records: options.previewRecords === 0 ? [] : [draftRecord],
        records_truncated: options.previewRecords === 0,
      }
    },
    async addJsonl(source: AsyncIterable<Uint8Array>) {
      await collect(source)
      state.importCalls += 1
      return {
        dataset_version: VERSION,
        manifest,
        ref_update: { status: 'not_requested' as const },
      }
    },
    async describeDataset() {
      if (state.describeError !== undefined) throw state.describeError
      return {
        requested_ref: VERSION,
        ref_name: null,
        dataset_version: VERSION,
        manifest,
      }
    },
    async inspectExport() {
      return exportPlan
    },
    async export(_datasetVersion: string, _request: unknown, options?: { signal?: AbortSignal }) {
      return {
        plan: exportPlan,
        bytes: (async function* () {
          yield encoder.encode(canonicalLine())
          if (state.exportIgnoresAbort) await state.exportGate
          else await waitForGateOrAbort(state.exportGate, options?.signal)
        })(),
      }
    },
  } as unknown as ApiV2Workspace
  return { workspace, state }
}

function mcpConfig(overrides: Partial<McpEnabledConfig> = {}): McpEnabledConfig {
  return {
    enabled: true,
    authMode: 'none',
    publicBaseUrl: 'http://databench.test',
    allowedOrigins: [],
    maxJsonBytes: 1024 * 1024,
    maxPreviewResponseBytes: 1024 * 1024,
    maxTokens: 128,
    maxActiveFileOperations: 2,
    tokenTtlMs: 15 * 60 * 1000,
    fileIdleTimeoutMs: 60 * 1000,
    fileTotalTimeoutMs: 30 * 60 * 1000,
    ...overrides,
  }
}

function canonicalLine(): string {
  return `${revision.record_json}\n`
}

function draftLine(): string {
  return `${JSON.stringify(draftRecord)}\n`
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://databench.test${path}`, init)
}

function mcpHeaders(): HeadersInit {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-06-18',
  }
}

function mcpRequest(message: unknown): Request {
  return request('/mcp', {
    method: 'POST',
    headers: mcpHeaders(),
    body: JSON.stringify(message),
  })
}

function processRequest(url: string): Request {
  return new Request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/x-ndjson' },
    body: canonicalLine(),
  })
}

async function prepareRaw(
  app: ReturnType<typeof createTestApp>,
  action: 'import-dataset' | 'validate-preview',
): Promise<Record<string, unknown>> {
  const response = await app.fetch(
    mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'data_process_prepare',
        arguments: { format: 'canonical-jsonl', action },
      },
    }),
  )
  const body = (await response.json()) as {
    error?: unknown
    result?: { structuredContent: Record<string, unknown> }
  }
  if (body.result === undefined) throw new Error(JSON.stringify(body))
  return body.result.structuredContent
}

function structured(result: {
  structuredContent?: Record<string, unknown>
}): Record<string, unknown> {
  if (result.structuredContent === undefined) throw new Error('Expected structured MCP result')
  return result.structuredContent
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of source) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function waitForGateOrAbort(
  gate: Promise<void> | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (gate === undefined) return
  if (signal === undefined) return gate
  signal.throwIfAborted()
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort?.(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([gate, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function fetchWhenFileSlotIsReady(
  app: ReturnType<typeof createTestApp>,
  putUrl: string,
): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.fetch(processRequest(putUrl))
    if (response.status !== 429) return response.status
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('MCP file operation slot was not released')
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition was not reached')
}
