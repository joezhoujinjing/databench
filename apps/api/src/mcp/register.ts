import {
  DomainError,
  McpCanonicalImportContractSchema,
  McpContractGetInputSchema,
  McpDataProcessPreparedSchema,
  McpDataProcessPreparedToolOutputSchema,
  McpDataProcessPrepareInputSchema,
  McpDataProcessPrepareToolInputSchema,
  McpDatasetExportCanonicalPreparedSchema,
  McpDatasetExportCanonicalPrepareInputSchema,
  McpDatasetShowInputSchema,
  McpDatasetShowResultSchema,
} from '@databench/schema'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Context } from 'hono'
import type { ApiEnv } from '../context.js'
import { getV2Workspace } from '../context.js'
import type { McpEnabledConfig } from './config.js'
import { createCanonicalImportContract } from './contracts.js'
import type { McpFileTokenRegistry } from './file-tokens.js'

const MCP_INSTRUCTIONS = [
  'This M1a stage only processes existing canonical JSONL that already contains Databench-managed IDs.',
  'Do not convert Excel or CSV and do not invent canonical IDs; raw table support arrives with the canonical-draft stage.',
  'Call contract_get before validating or importing canonical JSONL, and do not place file bytes in MCP arguments.',
  'Use data_process_prepare to obtain a one-time PUT URL for optional validation preview or dataset import.',
  'Preview is optional: choose it when mapping is uncertain or a sample would help; do not treat it as an approval state machine.',
  'Use dataset_show with an exact dataset version and dataset_export_canonical_prepare for a one-time canonical JSONL GET URL.',
  'The current workspace is anonymous and grants full access; it is intended only for a trusted internal network.',
].join(' ')

export interface McpRoutesRuntime {
  readonly config: McpEnabledConfig
  readonly tokens: McpFileTokenRegistry
  readonly version: string
}

export function registerMcpRoutes(app: OpenAPIHono<ApiEnv>, runtime: McpRoutesRuntime): void {
  app.post('/mcp', async (context) => {
    const request = context.req.raw
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    })
    const server = createMcpServer(context, request, runtime)
    try {
      await server.connect(transport)
      const parsedBody = await readMcpJsonBody(request, runtime.config.maxJsonBytes)
      if (!parsedBody.ok) return parsedBody.response
      const response = await transport.handleRequest(request, { parsedBody: parsedBody.value })
      return await limitMcpResponse(response, runtime.config.maxJsonBytes)
    } catch {
      if (request.signal.aborted) {
        return jsonRpcErrorResponse(499, -32603, 'MCP request was aborted')
      }
      return jsonRpcErrorResponse(500, -32603, 'Internal server error')
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  app.get('/mcp', (context) => {
    context.header('Allow', 'POST')
    return context.body(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32_000, message: 'Method not allowed.' },
        id: null,
      }),
      405,
      { 'Content-Type': 'application/json' },
    )
  })
}

function createMcpServer(
  context: Context<ApiEnv>,
  request: Request,
  runtime: McpRoutesRuntime,
): McpServer {
  const server = new McpServer(
    { name: 'databench', version: runtime.version },
    { instructions: MCP_INSTRUCTIONS },
  )
  const workspace = getV2Workspace(context)

  server.registerTool(
    'contract_get',
    {
      title: 'Get Databench import contract',
      description: 'Return the canonical JSONL schema, rules, examples, and effective limits.',
      inputSchema: McpContractGetInputSchema,
      outputSchema: McpCanonicalImportContractSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      return safeToolResult(async () => {
        McpContractGetInputSchema.parse(input)
        const result = createCanonicalImportContract(
          workspace.postTrainingV2Capability(),
          runtime.config.maxPreviewResponseBytes,
        )
        return toolResult(McpCanonicalImportContractSchema.parse(result))
      })
    },
  )

  server.registerTool(
    'data_process_prepare',
    {
      title: 'Prepare canonical JSONL processing',
      description:
        'Create a one-time PUT URL. preview_records is valid only for validate-preview; import-dataset publishes a dataset.',
      inputSchema: McpDataProcessPrepareToolInputSchema,
      outputSchema: McpDataProcessPreparedToolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      return safeToolResult(async () => {
        const operation = McpDataProcessPrepareInputSchema.parse(input)
        const prepared = runtime.tokens.prepare(
          operation.action === 'validate-preview'
            ? {
                kind: 'process' as const,
                format: operation.format,
                action: operation.action,
                previewRecords: operation.preview_records,
              }
            : {
                kind: 'process' as const,
                format: operation.format,
                action: operation.action,
              },
        )
        const result = McpDataProcessPreparedSchema.parse({
          method: 'PUT',
          put_url: `${runtime.config.publicBaseUrl}/mcp-files/process/${prepared.token}`,
          content_type: 'application/x-ndjson',
          max_bytes: workspace.postTrainingV2Capability().limits.max_request_bytes,
          expires_at: prepared.expiresAt,
          format: operation.format,
          action: operation.action,
          response_kind:
            operation.action === 'validate-preview' ? 'json-preview' : 'json-ingest-result',
          side_effects: operation.action === 'validate-preview' ? [] : ['dataset_publish'],
        })
        return toolResult(result)
      })
    },
  )

  server.registerTool(
    'dataset_show',
    {
      title: 'Show a Databench dataset',
      description: 'Return the summary for an exact immutable dataset version.',
      inputSchema: McpDatasetShowInputSchema,
      outputSchema: McpDatasetShowResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      return safeToolResult(async () => {
        const { dataset_version } = McpDatasetShowInputSchema.parse(input)
        const result = await workspace.describeDataset(dataset_version, {
          signal: AbortSignal.any([request.signal, extra.signal]),
        })
        return toolResult(McpDatasetShowResultSchema.parse(result))
      })
    },
  )

  server.registerTool(
    'dataset_export_canonical_prepare',
    {
      title: 'Prepare canonical JSONL export',
      description: 'Create a one-time GET URL for the exact dataset canonical JSONL export.',
      inputSchema: McpDatasetExportCanonicalPrepareInputSchema,
      outputSchema: McpDatasetExportCanonicalPreparedSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    async (input, extra) => {
      return safeToolResult(async () => {
        const { dataset_version } = McpDatasetExportCanonicalPrepareInputSchema.parse(input)
        const plan = await workspace.inspectExport(
          dataset_version,
          { converter: 'canonical-jsonl', options: {} },
          { signal: AbortSignal.any([request.signal, extra.signal]) },
        )
        if (plan.media_type !== 'application/x-ndjson') {
          throw new TypeError('Canonical JSONL converter returned an unexpected media type')
        }
        const prepared = runtime.tokens.prepare({
          kind: 'export',
          datasetVersion: dataset_version,
          filename: plan.suggested_filename,
          mediaType: plan.media_type,
        })
        const result = McpDatasetExportCanonicalPreparedSchema.parse({
          method: 'GET',
          get_url: `${runtime.config.publicBaseUrl}/mcp-files/export/${prepared.token}`,
          media_type: plan.media_type,
          filename: plan.suggested_filename,
          dataset_version,
          expires_at: prepared.expiresAt,
        })
        return toolResult(result)
      })
    },
  )

  return server
}

function toolResult<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

async function safeToolResult<T>(run: () => Promise<T>): Promise<T | ReturnType<typeof toolError>> {
  try {
    return await run()
  } catch (error) {
    return toolError(error)
  }
}

function toolError(error: unknown) {
  const body =
    error instanceof DomainError
      ? safeDomainToolError(error.code)
      : { code: 'internal_error', message: 'internal server error' }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: body }) }],
    isError: true as const,
  }
}

function safeDomainToolError(code: string): { readonly code: string; readonly message: string } {
  const message = SAFE_DOMAIN_TOOL_MESSAGES[code]
  return message === undefined
    ? { code: 'internal_error', message: 'internal server error' }
    : { code, message }
}

const SAFE_DOMAIN_TOOL_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  bad_request: 'Request was invalid',
  capacity_exceeded: 'Service capacity is exhausted',
  conflict: 'Request conflicts with existing state',
  integrity_error: 'Stored data failed an integrity check',
  not_found: 'Requested resource was not found',
  resource_limit: 'Request exceeds a resource limit',
  service_unavailable: 'A required service is unavailable',
  unsupported_profile: 'Requested profile is not supported',
  validation_error: 'Request validation failed',
})

async function readMcpJsonBody(
  request: Request,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: Response }
> {
  if (!hasMcpJsonHeaders(request)) {
    return { ok: true, value: undefined }
  }
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null && /^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
    const numeric = Number(declaredLength)
    if (!Number.isSafeInteger(numeric) || numeric > maxBytes) {
      if (request.body !== null) void request.body.cancel().catch(() => undefined)
      return { ok: false, response: mcpBodyLimitResponse(maxBytes) }
    }
  }

  const body = request.body
  if (body === null) {
    return { ok: false, response: jsonRpcErrorResponse(400, -32_700, 'Parse error: Invalid JSON') }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => {
    const reason =
      request.signal.reason ?? new DOMException('MCP request was aborted', 'AbortError')
    rejectAbort?.(reason)
    try {
      void reader.cancel(reason).catch(() => undefined)
    } catch {
      // Preserve the request abort as the primary failure.
    }
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (request.signal.aborted) onAbort()
    while (true) {
      request.signal.throwIfAborted()
      const next = await Promise.race([reader.read(), aborted])
      request.signal.throwIfAborted()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel(
          new DOMException('MCP JSON request exceeds the byte limit', 'AbortError'),
        )
        return { ok: false, response: mcpBodyLimitResponse(maxBytes) }
      }
      chunks.push(next.value)
    }
  } catch (error) {
    try {
      void reader.cancel(error).catch(() => undefined)
    } catch {
      // Preserve the primary read failure.
    }
    throw error
  } finally {
    request.signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // A hostile stream may still be settling its cancelled pending read.
    }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, response: jsonRpcErrorResponse(400, -32_700, 'Parse error: Invalid JSON') }
  }
}

function hasMcpJsonHeaders(request: Request): boolean {
  const accept = request.headers.get('accept')
  const contentType = request.headers.get('content-type')
  return (
    accept?.includes('application/json') === true &&
    accept.includes('text/event-stream') &&
    contentType?.includes('application/json') === true
  )
}

async function limitMcpResponse(response: Response, maxBytes: number): Promise<Response> {
  if (response.body === null) return response
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    await response.body.cancel().catch(() => undefined)
    return mcpResponseLimitResponse(maxBytes)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel(
          new DOMException('MCP JSON response exceeds the byte limit', 'AbortError'),
        )
        return mcpResponseLimitResponse(maxBytes)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function mcpBodyLimitResponse(maxBytes: number): Response {
  return jsonRpcErrorResponse(413, -32_000, `MCP JSON request exceeds ${maxBytes} bytes`)
}

function mcpResponseLimitResponse(maxBytes: number): Response {
  return jsonRpcErrorResponse(500, -32_603, `MCP JSON response exceeds ${maxBytes} bytes`)
}

function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code, message }, id: null },
    {
      status,
      headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
    },
  )
}
