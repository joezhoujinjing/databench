import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import {
  BadInputError,
  DatasetResponseSchema,
  ExportDatasetQuerySchema,
  IngestJsonlQuerySchema,
  IngestSamplesOpenApiRequestSchema,
  IngestSamplesRequestSchema,
  PaginationQuerySchema,
  SamplesPageOpenApiSchema,
  toJsonCompatible,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import type { ApiEnv } from '../context.js'
import { getWorkspace } from '../context.js'
import { DEFAULT_ERROR_RESPONSES, jsonResponse } from '../openapi.js'

const ingestSamplesRoute = createRoute({
  method: 'post',
  path: '/v1/datasets',
  request: {
    body: {
      content: {
        'application/json': {
          schema: IngestSamplesOpenApiRequestSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse(DatasetResponseSchema, 'Dataset manifest'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const ingestJsonlRoute = createRoute({
  method: 'post',
  path: '/v1/datasets:ingest-jsonl',
  request: {
    query: IngestJsonlQuerySchema,
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.any(),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonResponse(DatasetResponseSchema, 'Dataset manifest'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const getDatasetRoute = createRoute({
  method: 'get',
  path: '/v1/datasets/{ref}',
  responses: {
    200: jsonResponse(DatasetResponseSchema, 'Dataset manifest'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const samplesRoute = createRoute({
  method: 'get',
  path: '/v1/datasets/{ref}/samples',
  request: {
    query: PaginationQuerySchema,
  },
  responses: {
    200: jsonResponse(SamplesPageOpenApiSchema, 'Paginated samples'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

// NDJSON streaming responses can't be expressed by `app.openapi()`: the
// `application/x-ndjson` media type makes @hono/zod-openapi infer the 200 body
// as `never`, so a streaming `Response` is not assignable to the handler type.
// We register the OpenAPI path for documentation and serve it with a plain
// (fully typed, cast-free) `app.get` handler below.
const exportRoute = createRoute({
  method: 'get',
  path: '/v1/datasets/{ref}/export',
  request: {
    query: ExportDatasetQuerySchema,
  },
  responses: {
    200: {
      description: 'Dataset export as NDJSON',
      content: {
        'application/x-ndjson': {
          schema: z.string(),
        },
      },
    },
    ...DEFAULT_ERROR_RESPONSES,
  },
})

export function registerDatasetRoutes(app: OpenAPIHono<ApiEnv>): void {
  app.openapi(ingestSamplesRoute, async (context) => {
    // The route schema is a surrogate (SampleSchema embeds the unrenderable
    // JSON-number lexeme), so validate the full body with the real schema here.
    const body = IngestSamplesRequestSchema.parse(await context.req.json())
    const dataset = await getWorkspace(context).addSamples(body.samples, {
      name: body.name,
      message: body.message,
    })

    return context.json(dataset.manifest, 200)
  })

  app.openapi(ingestJsonlRoute, async (context) => {
    const query = context.req.valid('query')
    const body = await context.req.parseBody()
    const file = body.file

    if (!isFile(file)) {
      throw new BadInputError('multipart field "file" is required')
    }

    const tempPath = join(tmpdir(), `databench-${randomUUID()}.jsonl`)

    try {
      await writeFile(tempPath, Buffer.from(await file.arrayBuffer()))
      const dataset = await getWorkspace(context).addJsonl(tempPath, {
        ...(query.name !== undefined ? { name: query.name } : {}),
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
        source: query.source ?? defaultSource(file),
      })

      return context.json(dataset.manifest, 200)
    } finally {
      await rm(tempPath, { force: true })
    }
  })

  app.openapi(getDatasetRoute, async (context) => {
    const dataset = await getWorkspace(context).get(context.req.param('ref'))

    return context.json(dataset.manifest, 200)
  })

  app.openapi(samplesRoute, async (context) => {
    const { limit, offset } = context.req.valid('query')
    const dataset = await getWorkspace(context).get(context.req.param('ref'))
    const items = [...dataset.toSamples(offset, limit)]

    return context.json(
      {
        total: dataset.length,
        limit,
        offset,
        items: items.map(toJsonCompatible),
      },
      200,
    )
  })

  app.openAPIRegistry.registerPath(exportRoute)
  app.get(exportRoute.getRoutingPath(), async (context) => {
    const { fmt } = ExportDatasetQuerySchema.parse(context.req.query())
    const ref = context.req.param('ref')

    const { filename, lines } = await getWorkspace(context).exportJsonl(ref, fmt)

    return context.body(streamLines(lines), 200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="${safeFilename(filename)}"`,
    })
  })
}

function isFile(value: unknown): value is File {
  return value instanceof File
}

function defaultSource(file: File): string | null {
  return file.name ? parse(file.name).name : null
}

function safeFilename(filename: string): string {
  return filename.replaceAll('"', '_')
}

function streamLines(lines: Iterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line))
      }

      controller.close()
    },
  })
}
