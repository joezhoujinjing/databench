import {
  BadInputError,
  McpCanonicalImportResultSchema,
  McpCanonicalValidationPreviewResultSchema,
  ResourceLimitError,
} from '@databench/schema'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { ApiEnv } from '../context.js'
import { getV2Workspace } from '../context.js'
import { errorResponse } from '../middleware/error.js'
import { contentDispositionAttachment, streamAsyncIterable } from '../response.js'
import type { McpEnabledConfig } from './config.js'
import {
  finalizeMcpResponseStream,
  McpFileOperationDeadline,
  streamMcpRequestBody,
} from './file-streams.js'
import type { McpFileTokenRegistry } from './file-tokens.js'

export interface McpFileRoutesRuntime {
  readonly config: McpEnabledConfig
  readonly tokens: McpFileTokenRegistry
}

export function registerMcpFileRoutes(
  app: OpenAPIHono<ApiEnv>,
  runtime: McpFileRoutesRuntime,
): void {
  app.put('/mcp-files/process/:token', async (context) => {
    const active = runtime.tokens.begin(context.req.param('token'), 'process')
    if (active.busy) return tooManyFileOperations(context)
    const request = context.req.raw
    const deadline = new McpFileOperationDeadline(
      request.signal,
      runtime.config.fileIdleTimeoutMs,
      runtime.config.fileTotalTimeoutMs,
    )
    try {
      assertNdjsonContentType(request)
      assertDeclaredLength(
        request,
        getV2Workspace(context).postTrainingV2Capability().limits.max_request_bytes,
      )
      const bytes = streamMcpRequestBody(request, deadline)
      if (active.metadata.action === 'validate-preview') {
        const result = await getV2Workspace(context).previewCanonicalJsonl(
          bytes,
          {
            previewRecords: active.metadata.previewRecords,
            maxResponseBytes: runtime.config.maxPreviewResponseBytes,
          },
          { signal: deadline.signal },
        )
        return context.json(McpCanonicalValidationPreviewResultSchema.parse(result), 200)
      }

      const result = await getV2Workspace(context).addJsonl(
        bytes,
        { ref: null, expected_ref_version: null, message: null },
        { signal: deadline.signal },
      )
      return context.json(McpCanonicalImportResultSchema.parse(result), 200)
    } catch (error) {
      throw deadline.mapError(error)
    } finally {
      deadline.close()
      active.finish()
    }
  })

  app.get('/mcp-files/export/:token', async (context) => {
    const active = runtime.tokens.begin(context.req.param('token'), 'export')
    if (active.busy) return tooManyFileOperations(context)
    const deadline = new McpFileOperationDeadline(
      context.req.raw.signal,
      runtime.config.fileIdleTimeoutMs,
      runtime.config.fileTotalTimeoutMs,
    )
    try {
      const exported = await getV2Workspace(context).export(
        active.metadata.datasetVersion,
        { converter: 'canonical-jsonl', options: {}, accepted_fidelity_digest: null },
        { signal: deadline.signal },
      )
      const source = finalizeMcpResponseStream(exported.bytes, deadline, active.finish)
      const body = streamAsyncIterable(
        source,
        (reason) => {
          deadline.abort(reason ?? new DOMException('MCP export was cancelled', 'AbortError'))
        },
        deadline.signal,
        () => {
          deadline.close()
          active.finish()
        },
      )
      return context.body(body, 200, {
        'Content-Type': active.metadata.mediaType,
        'Content-Disposition': contentDispositionAttachment(active.metadata.filename),
      })
    } catch (error) {
      deadline.close()
      active.finish()
      throw deadline.mapError(error)
    }
  })
}

function tooManyFileOperations(context: Context<ApiEnv>): Response {
  context.header('Retry-After', '1')
  return errorResponse(context, {
    status: 429,
    code: 'too_many_requests',
    message: 'Too many active MCP file operations',
    detail: { retry_after_seconds: 1 },
  })
}

function assertNdjsonContentType(request: Request): void {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/x-ndjson') {
    const message = 'MCP process upload requires application/x-ndjson'
    throw new BadInputError(message, {
      issues: [{ path: '', line: null, code: 'content_type_invalid', message }],
    })
  }
}

function assertDeclaredLength(request: Request, maxBytes: number): void {
  const value = request.headers.get('content-length')
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) return
  const numeric = Number(value)
  const actual: number | string = Number.isSafeInteger(numeric) ? numeric : value
  if (typeof actual === 'string' || actual > maxBytes) {
    if (request.body !== null) void request.body.cancel().catch(() => undefined)
    throw new ResourceLimitError('MCP process upload exceeds the request byte limit', {
      resource: 'request_bytes',
      limit: maxBytes,
      actual,
    })
  }
}
