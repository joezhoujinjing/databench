import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CapacityExceededError,
  createExportPlanV2,
  createRecordRevisionV2,
  createRecordSummaryV2,
  deriveRecordEligibilityV2,
  FidelityErrorV2,
  IntegrityError,
  type PostTrainingRecordV2,
  PostTrainingRecordV2Schema,
  RefConflictErrorV2,
  ServiceUnavailableError,
  UnsupportedProfileError,
} from '@databench/schema'
import { postTrainingV2Capability } from '@databench/workspace'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, test } from 'vitest'
import { createOpenApiDocument } from '../src/app.js'
import type { ApiV2Workspace } from '../src/context.js'
import { createTestApp } from './test-app.js'

const VERSION = 'a'.repeat(64)
const OTHER_VERSION = 'b'.repeat(64)
const ARTIFACT_DIGEST = 'c'.repeat(64)
const CACHE_KEY = 'd'.repeat(64)
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const wireFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./golden/fixtures/v2/api-v2-wire-contract.fixture.json', import.meta.url),
    ),
    'utf8',
  ),
) as WireContractFixture

const record: PostTrainingRecordV2 = PostTrainingRecordV2Schema.parse({
  schema_version: '2.0.0',
  id: `rec_${'1'.repeat(64)}`,
  contents: [
    {
      role: 'user',
      parts: [
        {
          type: 'text',
          text: 'hello V2',
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
  suggested_filename: '训练集.jsonl',
  output_count: 1,
  config_hints: {},
  fidelity: {
    preserved: ['/contents'],
    changes: [],
  },
})

describe('V2 HTTP API', () => {
  test('publishes the complete endpoint set and generated wire components', () => {
    const document = createOpenApiDocument({ version: '2.0.0' }) as OpenApiDocument
    const operations = Object.entries(document.paths)
      .filter(([path]) => path.startsWith('/v2/'))
      .flatMap(([path, item]) =>
        Object.keys(item)
          .filter((method) => ['get', 'post', 'put'].includes(method))
          .map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort()

    expect(operations).toEqual([...wireFixture.operations].sort())
    for (const component of [
      ...wireFixture.success_components,
      ...wireFixture.typed_error_detail_components,
    ]) {
      expect(document.components.schemas[component], component).toBeDefined()
    }
    expect(
      document.paths['/v2/datasets/{dataset_version}:export']?.post.responses[200],
    ).toMatchObject({
      headers: {
        'X-Request-ID': { required: true },
        'Content-Disposition': { required: true },
        'Content-Length': { required: false },
      },
      content: {
        'application/x-ndjson': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    })
    expect(document.components.schemas.PostTrainingV2Capability).toBeDefined()
    expect(document.components.schemas.ExportPlanV2).toBeDefined()
    expect(document.components.schemas.RecordPageV2).toMatchObject({
      properties: { items: { maxItems: 500 } },
    })
    expect(document.components.schemas.RefPageV2).toMatchObject({
      properties: {
        items: { maxItems: 500 },
        next_cursor: { maxLength: 1536, nullable: true, type: 'string' },
      },
    })
    expect(document.components.schemas.RefMetadataV2).toMatchObject({
      required: expect.arrayContaining(['num_records']),
      properties: { num_records: { minimum: 0, type: 'integer' } },
    })
    expect(document.components.schemas.TransformRegistryPageV2).toMatchObject({
      properties: { items: { maxItems: 128 }, total: { maximum: 128 } },
    })

    const converterResponses = document.paths['/v2/converters']?.get?.responses
    expect(converterResponses?.[409]).toBeUndefined()
    expect(converterResponses?.[413]).toBeUndefined()
    expect(converterResponses?.[422]).toBeUndefined()
    expect(document.paths['/v2/datasets/{ref_or_version}']?.get?.responses[413]).toBeUndefined()
    for (const response of [
      document.paths['/v2/datasets/{ref_or_version}/records']?.get?.responses[413],
      document.paths['/v2/datasets/{ref_or_version}/records/{record_id}']?.get?.responses[413],
      document.paths['/v2/datasets/{ref_or_version}:audit']?.post?.responses[413],
    ]) {
      expect(JSON.stringify(response)).toContain('ResourceLimitErrorResponseV2')
    }
    const putRefConflict = document.paths['/v2/refs/{name}']?.put?.responses[409]
    expect(JSON.stringify(putRefConflict)).toContain('RefConflictErrorResponseV2')
    expect(JSON.stringify(putRefConflict)).not.toContain('DeterminismConflictErrorResponseV2')
  })

  test('reports enabled V2 capability diagnostics without opening dependencies', async () => {
    const fake = createFakeWorkspace()
    const response = await createTestApp({ v2Workspace: fake.workspace }).fetch(
      request('/capabilities'),
    )
    const body = await json<{
      post_training_v2: {
        enabled: boolean
        api_versions: string[]
        converters: string[]
        limits: Record<string, number>
      }
    }>(response)

    expect(body.post_training_v2.enabled).toBe(true)
    expect(body.post_training_v2.api_versions).toEqual(['2'])
    expect(body.post_training_v2.converters).toContain('canonical-jsonl')
    expect(body.post_training_v2.limits.max_request_bytes).toBe(1024 * 1024 * 1024)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('streams multipart ingest and preserves absent versus present field semantics', async () => {
    const fake = createFakeWorkspace()
    const app = createTestApp({
      corsOrigins: ['https://web.example.test'],
      v2Workspace: fake.workspace,
    })
    const form = new FormData()
    form.set('file', new File([canonicalLine()], 'records.jsonl'))
    form.set('ref', 'main')
    form.set('message', 'initial import')

    const response = await app.fetch(
      request('/v2/datasets:ingest-jsonl', {
        method: 'POST',
        headers: { origin: 'https://web.example.test' },
        body: form,
      }),
    )

    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      dataset_version: VERSION,
      ref_update: { status: 'updated', ref_name: 'main' },
    })
    expect(decoder.decode(fake.state.ingestedBytes)).toBe(canonicalLine())
    expect(fake.state.ingestOptions).toEqual({
      ref: 'main',
      expected_ref_version: null,
      message: 'initial import',
    })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('access-control-expose-headers')).toBe(
      'Content-Disposition, Content-Length, Content-Type, X-Request-ID',
    )
  })

  test('rejects multipart literal null and leaves the workspace unpublished', async () => {
    const fake = createFakeWorkspace()
    const boundary = 'v2-http-null-boundary'
    const body = encoder.encode(
      [
        `--${boundary}\r\nContent-Disposition: form-data; name="ref"\r\n\r\nnull\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="records.jsonl"\r\nContent-Type: application/x-ndjson\r\n\r\n${canonicalLine()}\r\n`,
        `--${boundary}--\r\n`,
      ].join(''),
    )
    const response = await createTestApp({ v2Workspace: fake.workspace }).fetch(
      request('/v2/datasets:ingest-jsonl', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
      }),
    )

    expect(response.status).toBe(400)
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('bad_request')
    expect(fake.state.ingestCalls).toBe(1)
    expect(fake.state.publishedIngests).toBe(0)
  })

  test('serves exact dataset, record pagination, record detail, and audit action paths', async () => {
    const fake = createFakeWorkspace()
    const app = createTestApp({ v2Workspace: fake.workspace })

    const described = await json<{ dataset_version: string }>(
      await app.fetch(request('/v2/datasets/main')),
    )
    expect(described.dataset_version).toBe(VERSION)

    const page = await json<{ offset: number; limit: number; dataset_version: string }>(
      await app.fetch(request('/v2/datasets/main/records?offset=2&limit=7')),
    )
    expect(page).toMatchObject({ offset: 2, limit: 7, dataset_version: VERSION })
    expect(fake.state.recordPageRequest).toEqual({ offset: 2, limit: 7 })

    const view = await json<{ record: { id: string }; dataset_version: string }>(
      await app.fetch(request(`/v2/datasets/${VERSION}/records/${record.id}`)),
    )
    expect(view.record.id).toBe(record.id)
    expect(view.dataset_version).toBe(VERSION)

    const audit = await app.fetch(request('/v2/datasets/main:audit', { method: 'POST' }))
    expect(audit.status).toBe(200)
    expect(await json(audit)).toMatchObject({ checks: { dataset_version: 'ok' } })

    const malformedAction = await app.fetch(request('/v2/datasets/mainoops', { method: 'POST' }))
    expect(malformedAction.status).toBe(404)

    const invalidPage = await app.fetch(request('/v2/datasets/main/records?limit=0'))
    expect(invalidPage.status).toBe(422)
    expect(await json(invalidPage)).toMatchObject({
      error: {
        code: 'validation_error',
        detail: { issues: [{ path: '/limit', line: null, code: 'too_small' }] },
      },
    })
  })

  test('uses duplicate-aware raw JSON for transforms and ref compare-and-set', async () => {
    const fake = createFakeWorkspace()
    const app = createTestApp({ v2Workspace: fake.workspace })
    const duplicateTransform = await app.fetch(
      request('/v2/transforms/filter/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"inputs":["main"],"inputs":["${VERSION}"],"params":{},"ref":null,"expected_ref_version":null,"message":null}`,
      }),
    )
    expect(duplicateTransform.status).toBe(400)
    expect(await json(duplicateTransform)).toMatchObject({
      error: { detail: { issues: [{ code: 'duplicate_key' }] } },
    })
    expect(fake.state.transformCalls).toBe(0)

    const transformed = await app.fetch(
      request('/v2/transforms/filter/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          inputs: ['main'],
          params: {},
          ref: null,
          expected_ref_version: null,
          message: null,
        }),
      }),
    )
    expect(transformed.status).toBe(200)
    expect(
      (await json<{ run: { input_dataset_versions: string[] } }>(transformed)).run,
    ).toMatchObject({
      input_dataset_versions: [VERSION],
    })

    const moved = await app.fetch(
      request('/v2/refs/main', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          new_version: OTHER_VERSION,
          expected_version: VERSION,
          message: 'move',
        }),
      }),
    )
    expect(moved.status).toBe(200)
    expect(await json(moved)).toMatchObject({ name: 'main', version: OTHER_VERSION })
  })

  test('serves registries, cursor refs, and bounded lineage with query coercion', async () => {
    const fake = createFakeWorkspace()
    const app = createTestApp({ v2Workspace: fake.workspace })

    expect(await json(await app.fetch(request('/v2/converters')))).toMatchObject({ total: 1 })
    expect(await json(await app.fetch(request('/v2/converters/canonical-jsonl')))).toMatchObject({
      name: 'canonical-jsonl',
    })
    expect(await json(await app.fetch(request('/v2/transforms')))).toMatchObject({ total: 1 })

    const refs = await json<{ items: unknown[]; next_cursor: string | null }>(
      await app.fetch(request('/v2/refs?limit=5')),
    )
    expect(refs.items).toHaveLength(1)
    expect(fake.state.refPageRequest).toEqual({ cursor: null, limit: 5 })

    const lineage = await json<{ root_dataset_version: string }>(
      await app.fetch(request('/v2/lineage/main?max_depth=3&max_nodes=9')),
    )
    expect(lineage.root_dataset_version).toBe(VERSION)
    expect(fake.state.lineageRequest).toEqual({
      cursor: null,
      max_depth: 3,
      max_nodes: 9,
    })
  })

  test('performs stateless inspect and exact-version binary export with safe headers', async () => {
    const fake = createFakeWorkspace()
    const app = createTestApp({ v2Workspace: fake.workspace })
    const inspect = await app.fetch(
      request('/v2/datasets/main:inspect-export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ converter: 'canonical-jsonl', options: {} }),
      }),
    )
    expect(inspect.status).toBe(200)
    expect(await json(inspect)).toMatchObject({
      dataset_version: VERSION,
      fidelity_digest: exportPlan.fidelity_digest,
    })

    const exported = await app.fetch(
      request(`/v2/datasets/${VERSION}:export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          converter: 'canonical-jsonl',
          options: {},
          accepted_fidelity_digest: exportPlan.fidelity_digest,
        }),
      }),
    )
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toBe('application/x-ndjson')
    expect(exported.headers.get('content-disposition')).toContain('filename="___.jsonl"')
    expect(exported.headers.get('content-disposition')).toContain("filename*=UTF-8''")
    expect(await exported.text()).toBe('first\nsecond\n')

    const mutableTarget = await app.fetch(
      request('/v2/datasets/main:export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          converter: 'canonical-jsonl',
          options: {},
          accepted_fidelity_digest: null,
        }),
      }),
    )
    expect(mutableTarget.status).toBe(422)
  })

  test('cancelling a binary response closes the converter iterator and aborts the operation', async () => {
    const fake = createFakeWorkspace()
    fake.state.blockExport = true
    const response = await createTestApp({ v2Workspace: fake.workspace }).fetch(
      request(`/v2/datasets/${VERSION}:export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          converter: 'canonical-jsonl',
          options: {},
          accepted_fidelity_digest: null,
        }),
      }),
    )
    const reader = response.body?.getReader()
    expect(decoder.decode((await reader?.read())?.value)).toBe('first\n')
    await reader?.cancel('consumer stopped')

    expect(fake.state.exportIteratorClosed).toBe(true)
    expect(fake.state.exportSignal?.aborted).toBe(true)
  })

  test('returns the current export plan in a typed fidelity failure before streaming bytes', async () => {
    const fake = createFakeWorkspace()
    fake.state.exportFailure = new FidelityErrorV2({
      reason: 'fidelity_digest_mismatch',
      plan: exportPlan,
    })
    const response = await createTestApp({ v2Workspace: fake.workspace }).fetch(
      request(`/v2/datasets/${VERSION}:export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          converter: 'canonical-jsonl',
          options: {},
          accepted_fidelity_digest: OTHER_VERSION,
        }),
      }),
    )

    expect(response.status).toBe(422)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await json(response)).toMatchObject({
      error: {
        code: 'fidelity_error',
        detail: {
          reason: 'fidelity_digest_mismatch',
          plan: { fidelity_digest: exportPlan.fidelity_digest },
        },
      },
    })
  })

  test('keeps a committed ingest result visible in typed ref-conflict detail', async () => {
    const fake = createFakeWorkspace()
    fake.state.ingestFailure = new RefConflictErrorV2({
      ref_name: 'main',
      expected_version: OTHER_VERSION,
      current_version: VERSION,
      new_version: OTHER_VERSION,
      new_dataset_committed: true,
    })
    const form = new FormData()
    form.set('file', new File([canonicalLine()], 'records.jsonl'))
    form.set('ref', 'main')
    form.set('expected_ref_version', OTHER_VERSION)

    const response = await createTestApp({ v2Workspace: fake.workspace }).fetch(
      request('/v2/datasets:ingest-jsonl', { method: 'POST', body: form }),
    )

    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({
      error: {
        code: 'ref_conflict',
        detail: {
          new_dataset_committed: true,
          current_version: VERSION,
        },
      },
    })
  })

  test('maps auth, rate, capacity, dependency, profile, and integrity failures to typed envelopes', async () => {
    const fake = createFakeWorkspace()
    const app = createTestApp({ v2Workspace: fake.workspace })
    app.get('/v2/_test-errors/:kind', (context) => {
      switch (context.req.param('kind')) {
        case 'unauthorized':
          throw new HTTPException(401, { message: 'credentials missing' })
        case 'forbidden':
          throw new HTTPException(403, { message: 'workspace denied' })
        case 'rate':
          throw new HTTPException(429, { message: 'slow down' })
        case 'capacity':
          throw new CapacityExceededError('busy', {
            resource: 'v2_dataset_cache_bytes',
            limit: 10,
            actual: 11,
          })
        case 'dependency':
          throw new ServiceUnavailableError('object store unavailable', { provider: 's3' })
        case 'profile':
          throw new UnsupportedProfileError('unsupported layout', {
            kind: 'layout',
            value: 'future-layout',
            supported: ['record-json-v1'],
            issues: [{ record_payload: 'must be dropped' }],
          })
        case 'integrity':
          throw new IntegrityError('corrupt', {
            reason: 'artifact_digest_mismatch',
            dataset_version: VERSION,
            local_path: '/private/tmp/secret.parquet',
          })
        default:
          throw new Error('unexpected')
      }
    })

    const expected = [
      ['unauthorized', 401, 'unauthorized', { reason: 'credentials_missing' }],
      ['forbidden', 403, 'forbidden', { reason: 'workspace_access_denied' }],
      ['rate', 429, 'too_many_requests', { retry_after_seconds: null }],
      [
        'capacity',
        503,
        'capacity_exceeded',
        { resource: 'v2_dataset_cache_bytes', limit: 10, actual: 11 },
      ],
      ['dependency', 503, 'service_unavailable', { dependency: 'object_store', retryable: true }],
      [
        'profile',
        422,
        'unsupported_profile',
        { kind: 'layout', value: 'future-layout', supported: ['record-json-v1'] },
      ],
      [
        'integrity',
        500,
        'integrity_error',
        { reason: 'artifact_digest_mismatch', dataset_version: VERSION },
      ],
    ] as const

    for (const [path, status, code, detail] of expected) {
      const response = await app.fetch(request(`/v2/_test-errors/${path}`))
      expect(response.status).toBe(status)
      expect(await json(response)).toEqual({
        error: {
          code,
          message:
            path === 'unauthorized'
              ? 'credentials missing'
              : path === 'forbidden'
                ? 'workspace denied'
                : path === 'rate'
                  ? 'slow down'
                  : path === 'capacity'
                    ? 'busy'
                    : path === 'dependency'
                      ? 'object store unavailable'
                      : path === 'profile'
                        ? 'unsupported layout'
                        : 'corrupt',
          detail,
        },
      })
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }
  })

  test('does not expose untyped V2 runtime failures', async () => {
    const fake = createFakeWorkspace()
    const app = createTestApp({ v2Workspace: fake.workspace })
    app.get('/v2/_test-untyped-failure', () => {
      throw new TypeError('SDK failed at /private/tmp/records.parquet with token secret-value')
    })

    const response = await app.fetch(request('/v2/_test-untyped-failure'))
    expect(response.status).toBe(500)
    expect(await json(response)).toEqual({
      error: {
        code: 'internal_error',
        message: 'internal server error',
        detail: { reason: 'unexpected_error' },
      },
    })
  })
})

interface FakeState {
  blockExport: boolean
  exportFailure: unknown
  exportIteratorClosed: boolean
  exportSignal: AbortSignal | undefined
  ingestCalls: number
  ingestFailure: unknown
  ingestedBytes: Uint8Array
  ingestOptions: unknown
  lineageRequest: unknown
  publishedIngests: number
  recordPageRequest: unknown
  refPageRequest: unknown
  transformCalls: number
}

function createFakeWorkspace(): { workspace: ApiV2Workspace; state: FakeState } {
  const state: FakeState = {
    blockExport: false,
    exportFailure: undefined,
    exportIteratorClosed: false,
    exportSignal: undefined,
    ingestCalls: 0,
    ingestFailure: undefined,
    ingestedBytes: new Uint8Array(),
    ingestOptions: undefined,
    lineageRequest: undefined,
    publishedIngests: 0,
    recordPageRequest: undefined,
    refPageRequest: undefined,
    transformCalls: 0,
  }
  const converter = {
    name: 'canonical-jsonl' as const,
    version: '1',
    options_schema: { type: 'object', additionalProperties: false },
    media_type: 'application/x-ndjson',
    task_views: ['canonical'] as ['canonical'],
    export_fidelity_profile: 'databench-export-fidelity-1' as const,
  }
  const transform = {
    name: 'filter',
    version: '1',
    identity_mode: 'preserve' as const,
    input_roles: ['base'],
    params_schema: { type: 'object', additionalProperties: false },
    params_example: {},
  }
  const ref = {
    name: 'main',
    version: VERSION,
    num_records: 1,
    message: null,
    updated_at: '2026-07-24T00:00:00.000Z',
  }

  const workspace = {
    postTrainingV2Capability: () => postTrainingV2Capability(),
    async addJsonl(
      source: AsyncIterable<Uint8Array>,
      optionsInput: PromiseLike<unknown> | unknown,
    ) {
      state.ingestCalls += 1
      const [bytes, options] = await Promise.all([collect(source), Promise.resolve(optionsInput)])
      state.ingestedBytes = bytes
      state.ingestOptions = options
      if (state.ingestFailure !== undefined) throw state.ingestFailure
      state.publishedIngests += 1
      const optionRecord = options as { ref: string | null }
      return {
        dataset_version: VERSION,
        manifest,
        ref_update:
          optionRecord.ref === null
            ? { status: 'not_requested' as const }
            : {
                status: 'updated' as const,
                ref_name: optionRecord.ref,
                previous_version: null,
                current_version: VERSION,
              },
      }
    },
    async describeDataset(refOrVersion: string) {
      return {
        requested_ref: refOrVersion,
        ref_name: refOrVersion === VERSION ? null : refOrVersion,
        dataset_version: VERSION,
        manifest,
      }
    },
    async getRecordPage(_refOrVersion: string, requestInput: unknown) {
      state.recordPageRequest = requestInput
      const requestValue = requestInput as { offset: number; limit: number }
      return {
        items: [createRecordSummaryV2(revision)],
        offset: requestValue.offset,
        limit: requestValue.limit,
        total: 1,
        dataset_version: VERSION,
      }
    },
    async getRecordView(_refOrVersion: string, recordId: string) {
      if (recordId !== record.id) return null
      return {
        record,
        record_digest: revision.record_digest,
        eligibility: deriveRecordEligibilityV2(record),
        dataset_version: VERSION,
      }
    },
    async audit() {
      return {
        dataset_version: VERSION,
        layout_version: 'record-json-v1' as const,
        artifact_digest: ARTIFACT_DIGEST,
        artifact_size_bytes: 512,
        checks: {
          manifest: 'ok' as const,
          artifact_digest: 'ok' as const,
          parquet_schema: 'ok' as const,
          record_digests: 'ok' as const,
          dataset_version: 'ok' as const,
        },
      }
    },
    listConverters: () => [converter],
    getConverter: (name: string) => (name === converter.name ? converter : null),
    async inspectExport() {
      return exportPlan
    },
    async export(_version: string, _requestInput: unknown, context: { signal?: AbortSignal } = {}) {
      if (state.exportFailure !== undefined) throw state.exportFailure
      state.exportSignal = context.signal
      return {
        plan: exportPlan,
        bytes: (async function* () {
          try {
            yield encoder.encode('first\n')
            if (state.blockExport) {
              await new Promise<void>((resolve, reject) => {
                const signal = context.signal
                if (signal === undefined) return resolve()
                const abort = () => reject(signal.reason)
                signal.addEventListener('abort', abort, { once: true })
                if (signal.aborted) abort()
              })
            } else {
              yield encoder.encode('second\n')
            }
          } finally {
            state.exportIteratorClosed = true
          }
        })(),
      }
    },
    listTransforms: () => [transform],
    async runTransform() {
      state.transformCalls += 1
      return {
        run: {
          run_id: `run_${CACHE_KEY}`,
          cache_key: CACHE_KEY,
          op: 'filter',
          op_version: '1',
          input_dataset_versions: [VERSION],
          normalized_params: {},
          output_dataset_version: VERSION,
          created_at: '2026-07-24T00:00:00.000Z',
        },
        manifest,
        ref_update: { status: 'not_requested' as const },
        cache_hit: false,
      }
    },
    async listRefs(requestInput: unknown) {
      state.refPageRequest = requestInput
      return { items: [ref], next_cursor: null }
    },
    async getRef(name: string) {
      return name === ref.name ? ref : null
    },
    async putRef(name: string, requestInput: unknown) {
      const put = requestInput as { new_version: string; message: string | null }
      return {
        name,
        version: put.new_version,
        num_records: 1,
        message: put.message,
        updated_at: '2026-07-24T00:00:00.000Z',
      }
    },
    async lineage(_refOrVersion: string, requestInput: unknown) {
      state.lineageRequest = requestInput
      return {
        root_dataset_version: VERSION,
        nodes: [{ dataset_version: VERSION, manifest }],
        edges: [],
        truncated: false,
        next_cursor: null,
      }
    },
  } as unknown as ApiV2Workspace

  return { workspace, state }
}

function canonicalLine(): string {
  return `${revision.record_json}\n`
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

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init)
}

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T
}

interface OpenApiDocument {
  readonly paths: Record<
    string,
    {
      readonly get?: {
        readonly responses: Record<number, unknown>
      }
      readonly post: {
        readonly responses: Record<number, unknown>
      }
      readonly put?: {
        readonly responses: Record<number, unknown>
      }
    }
  >
  readonly components: {
    readonly schemas: Record<string, unknown>
  }
}

interface WireContractFixture {
  readonly operations: readonly string[]
  readonly success_components: readonly string[]
  readonly typed_error_detail_components: readonly string[]
}
