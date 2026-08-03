import { describe, expect, test } from 'vitest'
import { ApiError } from '@/api/errors.js'
import fixture from '../../../test/golden/fixtures/v2/web-v2-mutations-export.fixture.json'
import {
  getLineageV2,
  ingestCanonicalDatasetV2,
  inspectExportV2,
  listConvertersV2,
  listTransformsV2,
  previewExportV2,
  putRefV2,
  runTransformV2,
} from './client.js'
import type {
  ConverterDescriptorV2,
  DatasetLineageV2,
  ExportPlanV2,
  IngestResultV2,
  RefConflictDetailV2,
  TransformDescriptorV2,
} from './types.js'

const input = fixture.versions.input
const output = fixture.versions.output
const current = fixture.versions.current

describe('V15 browser API lifecycle', () => {
  test('covers ingest, ordered transform conflict recovery, lineage and inspect', async () => {
    const requests: Request[] = []
    const fetcher = async (request: Request): Promise<Response> => {
      requests.push(request.clone())
      const url = new URL(request.url)
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'req-v15' },
          status,
        })

      if (url.pathname === '/v2/datasets:ingest-jsonl') return json(fixture.ingest_result)
      if (url.pathname === '/v2/transforms' && request.method === 'GET') {
        return json({ items: [fixture.transform], total: 1 })
      }
      if (url.pathname === '/v2/transforms/append-evidence/run') {
        return json(fixture.ref_conflict, 409)
      }
      if (url.pathname === '/v2/refs/main') {
        return json({
          message: null,
          name: 'main',
          num_records: 1,
          updated_at: '2026-07-24T00:00:00Z',
          version: output,
        })
      }
      if (url.pathname === `/v2/lineage/${output}`) return json(fixture.lineage)
      if (url.pathname === `/v2/datasets/${output}:inspect-export`) return json(fixture.export_plan)
      if (url.pathname === `/v2/datasets/${output}:preview-export`) {
        return json({
          plan: fixture.export_plan,
          source_record: {
            record_id: `rec_${'1'.repeat(64)}`,
            record_digest: '2'.repeat(64),
            text: '{"schema_version":"2.0.0"}',
            truncated: false,
          },
          output_record: { text: '{"messages":[]}', truncated: false },
        })
      }
      if (url.pathname === '/v2/converters') return json({ items: [fixture.converter], total: 1 })
      return json({ error: { code: 'not_found', message: url.pathname } }, 404)
    }
    const connection = { base: 'https://api.example.test', fetch: fetcher, token: 'private' }

    const ingested = await ingestCanonicalDatasetV2({
      ...connection,
      expectedRefVersion: null,
      file: new File(['{"schema_version":"2.0.0"}\n'], 'records.jsonl'),
      message: 'initial',
      ref: 'main',
    })
    expect(ingested).toEqual(fixture.ingest_result as IngestResultV2)

    const transforms = await listTransformsV2(connection)
    expect(transforms.items).toEqual([fixture.transform as TransformDescriptorV2])

    let conflict: RefConflictDetailV2 | null = null
    try {
      await runTransformV2({
        ...connection,
        name: 'append-evidence',
        request: {
          expected_ref_version: input,
          inputs: [input, current],
          message: null,
          params: {},
          ref: 'main',
        },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) conflict = error.detail as RefConflictDetailV2
    }
    expect(conflict).toEqual(fixture.ref_conflict.error.detail)

    const moved = await putRefV2({
      ...connection,
      name: 'main',
      request: { expected_version: current, message: null, new_version: output },
    })
    expect(moved.version).toBe(output)

    const lineage = await getLineageV2({
      ...connection,
      cursor: null,
      maxDepth: 8,
      maxNodes: 100,
      refOrVersion: output,
    })
    expect(lineage).toEqual(fixture.lineage as DatasetLineageV2)

    const converters = await listConvertersV2(connection)
    expect(converters.items).toEqual([fixture.converter as ConverterDescriptorV2])

    const plan = await inspectExportV2({
      ...connection,
      refOrVersion: output,
      request: { converter: 'canonical-jsonl', options: {} },
    })
    expect(plan).toEqual(fixture.export_plan as ExportPlanV2)

    const preview = await previewExportV2({
      ...connection,
      refOrVersion: output,
      request: { converter: 'canonical-jsonl', options: {} },
    })
    expect(preview.plan).toEqual(plan)
    expect(preview.source_record?.text).toContain('schema_version')
    expect(preview.output_record?.text).toContain('messages')

    const runRequest = requests.find((request) =>
      request.url.endsWith('/v2/transforms/append-evidence/run'),
    )
    expect(await runRequest?.json()).toMatchObject({ inputs: [input, current] })
    const refRequest = requests.find((request) => request.url.endsWith('/v2/refs/main'))
    expect(await refRequest?.json()).toMatchObject({
      expected_version: current,
      new_version: output,
    })
  })
})
