import { readdir, readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const gatewayBase = 'http://web/api'
const publicBase = process.env.DATABENCH_MCP_PUBLIC_BASE_URL
const fixturePath = process.argv[2]
const tempRoot = '/var/lib/databench/.databench-v2-temp'

if (publicBase === undefined || fixturePath === undefined) {
  throw new Error('offline MCP smoke configuration is incomplete')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function structured(result) {
  assert(result.isError !== true, 'MCP tool returned an error')
  assert(result.structuredContent !== undefined, 'MCP tool omitted structured content')
  return result.structuredContent
}

function transformedDraft(bytes, transform) {
  const lines = bytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => transform(JSON.parse(line)))
  return Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
}

async function companionFetch(preparedUrl, init) {
  const value = String(preparedUrl)
  assert(
    value.startsWith(`${publicBase}/mcp-files/`),
    'prepared file URL does not use the configured public /api base',
  )
  const gatewayUrl = `${gatewayBase}${value.slice(publicBase.length)}`
  try {
    return await fetch(gatewayUrl, init)
  } catch {
    throw new Error('MCP companion request failed')
  }
}

async function putDraft(prepared, bytes) {
  const response = await companionFetch(prepared.put_url, {
    method: 'PUT',
    headers: { 'content-type': 'application/x-ndjson' },
    body: bytes,
  })
  return response
}

async function requireOk(response, operation) {
  if (response.ok) return
  let code = 'unknown_error'
  let path = ''
  try {
    const body = await response.clone().json()
    const issue = body?.error?.detail?.issues?.[0]
    code = issue?.code ?? body?.error?.code ?? code
    path = typeof issue?.path === 'string' ? issue.path : ''
  } catch {
    // Keep diagnostics token-free even when an intermediary returns a non-JSON body.
  }
  throw new Error(`${operation} failed with HTTP ${response.status} (${code}${path})`)
}

async function draftTempEntries() {
  try {
    return (await readdir(tempRoot)).filter((name) => name.includes('-draft-')).sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function eventually(check, message) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

function startStalledUpload(prepared) {
  const abortController = new AbortController()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.alloc(1024 * 1024, 0x20))
    },
  })
  const completed = companionFetch(prepared.put_url, {
    method: 'PUT',
    headers: { 'content-type': 'application/x-ndjson' },
    body,
    duplex: 'half',
    signal: abortController.signal,
  }).catch(() => undefined)
  return { abortController, completed }
}

async function main() {
  const draft = await readFile(fixturePath)
  const revisedDraft = transformedDraft(draft, (record) => ({
    ...record,
    contents: record.contents.filter((content) => content.role !== 'system'),
  }))
  const materializeOnlyDraft = transformedDraft(draft, (record) => ({
    ...record,
    tags: [...new Set([...(record.tags ?? []), 'smoke:materialize-only'])].sort(),
  }))

  const client = new Client({ name: 'databench-offline-smoke', version: '1' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayBase}/mcp`))
  await client.connect(transport)
  try {
    assert(
      client.getInstructions()?.includes('anonymous and grants full access'),
      'MCP warning missing',
    )
    const tools = await client.listTools()
    assert(
      tools.tools.map(({ name }) => name).join(',') ===
        'contract_get,data_process_prepare,dataset_show,dataset_export_canonical_prepare',
      'unexpected MCP tool surface',
    )
    const contract = structured(
      await client.callTool({
        name: 'contract_get',
        arguments: { name: 'canonical-draft-import' },
      }),
    )
    assert(contract.version === '1.0.0', 'unexpected canonical draft contract version')
    assert(contract.examples?.length === 3, 'canonical draft contract examples are incomplete')

    const directPrepared = structured(
      await client.callTool({
        name: 'data_process_prepare',
        arguments: { format: 'canonical-draft-jsonl-v1', action: 'import-dataset' },
      }),
    )
    const directResponse = await putDraft(directPrepared, draft)
    await requireOk(directResponse, 'direct draft import')
    const direct = await directResponse.json()
    assert(/^[0-9a-f]{64}$/.test(direct.dataset_version), 'direct import version is invalid')
    assert(
      direct.ref_update?.status === 'not_requested',
      'direct import unexpectedly updated a ref',
    )

    const previewPrepared = structured(
      await client.callTool({
        name: 'data_process_prepare',
        arguments: {
          format: 'canonical-draft-jsonl-v1',
          action: 'validate-preview',
          preview_records: 1,
        },
      }),
    )
    const previewResponse = await putDraft(previewPrepared, revisedDraft)
    await requireOk(previewResponse, 'draft preview')
    const preview = await previewResponse.json()
    assert(
      preview.record_count === 1 && preview.records?.length === 1,
      'draft preview is incomplete',
    )
    assert(/^[0-9a-f]{64}$/.test(preview.input_digest), 'preview digest is invalid')
    const reusedPreview = await putDraft(previewPrepared, revisedDraft)
    assert(reusedPreview.status === 400, 'one-time process URL was reusable')

    const revisedPrepared = structured(
      await client.callTool({
        name: 'data_process_prepare',
        arguments: {
          format: 'canonical-draft-jsonl-v1',
          action: 'import-dataset',
          expected_input_digest: preview.input_digest,
        },
      }),
    )
    const revisedResponse = await putDraft(revisedPrepared, revisedDraft)
    await requireOk(revisedResponse, 'previewed draft import')
    const revised = await revisedResponse.json()
    assert(
      revised.dataset_version !== direct.dataset_version,
      'revised draft kept the direct version',
    )
    assert(
      revised.ref_update?.status === 'not_requested',
      'revised import unexpectedly updated a ref',
    )

    let materializedBytes
    let materializedVersion
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prepared = structured(
        await client.callTool({
          name: 'data_process_prepare',
          arguments: { format: 'canonical-draft-jsonl-v1', action: 'materialize-jsonl' },
        }),
      )
      const response = await putDraft(prepared, materializeOnlyDraft)
      await requireOk(response, 'draft materialization')
      const disposition = response.headers.get('content-disposition') ?? ''
      const match = disposition.match(/canonical-([0-9a-f]{64})\.jsonl/)
      assert(match !== null, 'materialized response omitted the prospective version')
      const bytes = Buffer.from(await response.arrayBuffer())
      assert(bytes.length > 0, 'materialized response was empty')
      if (attempt === 0) {
        materializedBytes = bytes
        materializedVersion = match[1]
      } else {
        assert(match[1] === materializedVersion, 'materialization replay changed the version')
        assert(bytes.equals(materializedBytes), 'materialization replay changed canonical bytes')
      }
    }
    const materializedShow = await client.callTool({
      name: 'dataset_show',
      arguments: { dataset_version: materializedVersion },
    })
    assert(
      materializedShow.isError === true && JSON.stringify(materializedShow).includes('not_found'),
      'materialize-only unexpectedly published a dataset',
    )

    const shown = structured(
      await client.callTool({
        name: 'dataset_show',
        arguments: { dataset_version: direct.dataset_version },
      }),
    )
    assert(
      shown.dataset_version === direct.dataset_version,
      'dataset_show returned another version',
    )
    const exportPrepared = structured(
      await client.callTool({
        name: 'dataset_export_canonical_prepare',
        arguments: { dataset_version: direct.dataset_version },
      }),
    )
    const exportedResponse = await companionFetch(exportPrepared.get_url)
    await requireOk(exportedResponse, 'canonical export')
    const exported = Buffer.from(await exportedResponse.arrayBuffer())
    assert(exported.length > 0, 'canonical export was empty')
    const reusedExport = await companionFetch(exportPrepared.get_url)
    assert(reusedExport.status === 400, 'one-time export URL was reusable')
    const canonicalImportPrepared = structured(
      await client.callTool({
        name: 'data_process_prepare',
        arguments: { format: 'canonical-jsonl', action: 'import-dataset' },
      }),
    )
    const canonicalImportResponse = await putDraft(canonicalImportPrepared, exported)
    await requireOk(canonicalImportResponse, 'canonical reimport')
    const canonicalImport = await canonicalImportResponse.json()
    assert(
      canonicalImport.dataset_version === direct.dataset_version,
      'canonical reimport changed the dataset version',
    )

    const tempBeforeBackpressure = await draftTempEntries()
    const stalledPrepared = []
    for (let index = 0; index < 2; index += 1) {
      stalledPrepared.push(
        structured(
          await client.callTool({
            name: 'data_process_prepare',
            arguments: { format: 'canonical-draft-jsonl-v1', action: 'validate-preview' },
          }),
        ),
      )
    }
    const stalledUploads = stalledPrepared.map(startStalledUpload)
    await new Promise((resolve) => setTimeout(resolve, 1000))

    const retryPrepared = structured(
      await client.callTool({
        name: 'data_process_prepare',
        arguments: { format: 'canonical-draft-jsonl-v1', action: 'validate-preview' },
      }),
    )
    const busyResponse = await putDraft(retryPrepared, draft)
    assert(busyResponse.status === 429, 'active file limit did not return 429')
    assert(busyResponse.headers.get('retry-after') === '1', '429 omitted Retry-After')

    stalledUploads[0].abortController.abort()
    await stalledUploads[0].completed
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const retriedResponse = await putDraft(retryPrepared, draft)
    await requireOk(retriedResponse, 'retry-after process upload')
    const retriedPreview = await retriedResponse.json()
    assert(retriedPreview.record_count === 1, 'retry-after preview is incomplete')

    stalledUploads[1].abortController.abort()
    await stalledUploads[1].completed
    await eventually(
      async () =>
        JSON.stringify(await draftTempEntries()) === JSON.stringify(tempBeforeBackpressure),
      'stalled uploads left draft spools behind',
    )
    for (const prepared of stalledPrepared) {
      const abortedTokenRetry = await putDraft(prepared, draft)
      assert(abortedTokenRetry.status === 400, 'aborted upload token was not invalidated')
    }

    process.stdout.write(
      `${JSON.stringify({
        direct_dataset_version: direct.dataset_version,
        revised_dataset_version: revised.dataset_version,
        materialize_only_version: materializedVersion,
        record_count: preview.record_count,
      })}\n`,
    )
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown failure'
  const sanitized = message.replace(/(?:proc|exp)_[0-9a-f]{64}/g, '[redacted-token]')
  process.stderr.write(`offline MCP smoke failed: ${sanitized}\n`)
  process.exitCode = 1
})
