import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { V2Workspace } from '@databench/workspace'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTestApp } from './test-app.js'

const runIntegration = process.env.RUN_MINIO_STORE_TESTS === 'true'
const FIRST_ID = `rec_${'1'.repeat(64)}`
const SECOND_ID = `rec_${'2'.repeat(64)}`
const REF_NAME = `v12-http-${randomUUID()}`

describe.runIf(runIntegration)('V2 HTTP API against real MinIO and Postgres', () => {
  let temporaryRoot: string
  let workspace: V2Workspace

  beforeAll(async () => {
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
        [
          `${JSON.stringify(canonicalRecord(FIRST_ID, 'First real V12 HTTP record.'))}\n`,
          `${JSON.stringify(canonicalRecord(SECOND_ID, 'Second real V12 HTTP record.'))}\n`,
        ],
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
    expect(ingested.manifest.num_records).toBe(2)

    const described = await responseJson<{ dataset_version: string }>(
      await app.fetch(request(`/v2/datasets/${REF_NAME}`)),
    )
    expect(described.dataset_version).toBe(ingested.dataset_version)

    const page = await responseJson<{
      dataset_version: string
      items: Array<{ record_id: string }>
    }>(await app.fetch(request(`/v2/datasets/${ingested.dataset_version}/records?limit=20`)))
    expect(page.dataset_version).toBe(ingested.dataset_version)
    expect(page.items.map(({ record_id }) => record_id).sort()).toEqual([FIRST_ID, SECOND_ID])

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
})

function canonicalRecord(id: string, text: string) {
  return {
    schema_version: '2.0.0',
    id,
    system_instruction: null,
    contents: [
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text,
            thought: false,
            thought_signature: null,
            part_metadata: {},
          },
        ],
        loss_weight: null,
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
  }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init)
}

async function responseJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T
}
