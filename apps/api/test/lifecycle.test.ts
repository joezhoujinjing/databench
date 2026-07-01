import { randomUUID } from 'node:crypto'
import { Workspace } from '@databench/workspace'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../src/app.js'
import { createMemoryStore } from './memory-store.js'

const workspaces: Workspace[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close()))
})

describe('api lifecycle', () => {
  test('runs the dataset, transform, lineage, refs, recipe, and export lifecycle', async () => {
    const { app, prefix } = makeApp()
    const rawRef = `${prefix}-sft-raw`
    const prefRef = `${prefix}-pref-raw`
    const cleanRef = `${prefix}-sft-clean`
    const trainRef = `${prefix}-train`

    const ingest = await postJson(app, '/v1/datasets', {
      name: rawRef,
      samples: sftSamples(prefix),
    })
    expect(ingest.status).toBe(200)
    const sft = (await ingest.json()) as ManifestResponse
    expect(sft.num_rows).toBe(3)
    expect(sft.kinds).toEqual({ sft: 3 })

    const uploadBody = new FormData()
    uploadBody.set(
      'file',
      new File([preferenceJsonl(prefix)], 'preference.jsonl', {
        type: 'application/x-ndjson',
      }),
    )
    const upload = await app.fetch(
      request(`/v1/datasets:ingest-jsonl?name=${prefRef}`, {
        method: 'POST',
        body: uploadBody,
      }),
    )
    expect(upload.status).toBe(200)
    expect(((await upload.json()) as ManifestResponse).num_rows).toBe(2)

    const prefSamples = (await getJson<SamplesPage>(app, `/v1/datasets/${prefRef}/samples`)).items
    expect(prefSamples.every((sample) => sample.source === 'preference')).toBe(true)

    const manifest = await getJson<ManifestResponse>(app, `/v1/datasets/${rawRef}`)
    expect(manifest.version).toBe(sft.version)

    const page = await getJson<SamplesPage>(app, `/v1/datasets/${rawRef}/samples?limit=2&offset=1`)
    expect(page.total).toBe(3)
    expect(page.offset).toBe(1)
    expect(page.items).toHaveLength(2)

    const capped = await app.fetch(request(`/v1/datasets/${rawRef}/samples?limit=5000`))
    expect(capped.status).toBe(422)
    expect(((await capped.json()) as ErrorResponse).error.code).toBe('validation_error')
    const atCap = await getJson<SamplesPage>(app, `/v1/datasets/${rawRef}/samples?limit=500`)
    expect(atCap.limit).toBe(500)

    const transforms = await getJson<TransformsPage>(app, '/v1/transforms')
    expect(new Set(transforms.items.map((item) => item.name))).toEqual(
      new Set(['dedup', 'enrich_length', 'filter_by_signal', 'sample_n']),
    )
    expect(transforms.items.find((item) => item.name === 'sample_n')?.params_schema).toBeTruthy()

    const enriched = await postJson(app, '/v1/transforms/enrich_length/run', {
      inputs: [rawRef],
    })
    expect(enriched.status).toBe(200)
    const enrichedVersion = ((await enriched.json()) as ManifestResponse).version

    const deduped = await postJson(app, '/v1/transforms/dedup/run', {
      inputs: [enrichedVersion],
      ref: cleanRef,
    })
    expect(deduped.status).toBe(200)
    expect(((await deduped.json()) as ManifestResponse).num_rows).toBe(2)

    const lineage = await getJson<LineageNode>(app, `/v1/lineage/${cleanRef}`)
    expect(lineage.produced_by?.op).toBe('dedup')
    expect(lineage.inputs?.[0]?.produced_by?.op).toBe('enrich_length')
    expect((await getJson<LineageNode>(app, `/v1/lineage/${prefix}-missing`)).version).toBe(
      `${prefix}-missing`,
    )

    const refs = await getJson<RefsPage>(app, '/v1/refs?limit=500')
    const refVersions = new Map(refs.items.map((item) => [item.name, item.version]))
    expect(refVersions.has(cleanRef)).toBe(true)
    expect((await getJson<RefInfo>(app, `/v1/refs/${cleanRef}`)).version).toBe(
      refVersions.get(cleanRef),
    )

    const recipe = await postJson(app, '/v1/recipes:materialize', {
      recipe: {
        name: `${prefix}-demo-mix`,
        sources: [
          { dataset: cleanRef, weight: 2 },
          { dataset: prefRef, weight: 1 },
        ],
      },
      ref: trainRef,
    })
    expect(recipe.status).toBe(200)
    expect(((await recipe.json()) as ManifestResponse).num_rows).toBe(4)

    const exported = await app.fetch(request(`/v1/datasets/${trainRef}/export`))
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toContain('application/x-ndjson')
    expect(exported.headers.get('content-disposition')).toContain('.jsonl')
    expect((await exported.text()).split('\n').filter(Boolean)).toHaveLength(4)
  })

  test('endpoint errors use the shared envelope', async () => {
    const { app, prefix } = makeApp()

    const missingDataset = await app.fetch(request(`/v1/datasets/${prefix}-missing`))
    expect(missingDataset.status).toBe(404)
    expect(((await missingDataset.json()) as ErrorResponse).error.code).toBe('not_found')

    const unknownTransform = await postJson(app, '/v1/transforms/nope/run', { inputs: ['x'] })
    expect(unknownTransform.status).toBe(404)
    expect(((await unknownTransform.json()) as ErrorResponse).error.code).toBe('not_found')

    const badSample = await postJson(app, '/v1/datasets', {
      samples: [{ kind: 'sft' }],
    })
    expect(badSample.status).toBe(422)
    expect(((await badSample.json()) as ErrorResponse).error.code).toBe('validation_error')

    const missingRef = await app.fetch(request(`/v1/refs/${prefix}-missing`))
    expect(missingRef.status).toBe(404)
    expect(((await missingRef.json()) as ErrorResponse).error.code).toBe('not_found')
  })

  test('refs endpoints hide catalog pointers whose objects are missing', async () => {
    const { app, prefix, workspace } = makeApp()
    const liveRef = `${prefix}-live`
    const staleRef = `${prefix}-stale`

    const ingest = await postJson(app, '/v1/datasets', {
      name: liveRef,
      samples: sftSamples(prefix),
    })
    await expectStatus(ingest, 200)
    await workspace.catalog.setRef(staleRef, 'missing-version')

    const refs = await getJson<RefsPage>(app, '/v1/refs?limit=500')
    const names = refs.items.map((item) => item.name)
    expect(names).toContain(liveRef)
    expect(names).not.toContain(staleRef)

    const stale = await app.fetch(request(`/v1/refs/${staleRef}`))
    expect(stale.status).toBe(404)
    expect(((await stale.json()) as ErrorResponse).error.code).toBe('not_found')
  })

  test('runs vocabulary derive, curate, normalize, validate, and list endpoints', async () => {
    const { app, prefix } = makeApp()
    const rawRef = `${prefix}-labels`
    const vocabName = `${prefix}-brand`

    const ingest = await postJson(app, '/v1/datasets', {
      name: rawRef,
      samples: [
        labeledSft('远东', '远东电缆'),
        labeledSft('远东电缆', '远东电缆'),
        labeledSft('TBEA', '特变电工'),
      ],
    })
    expect(ingest.status).toBe(200)

    const derive = await app.fetch(
      request(
        `/v1/vocabularies/${encodeURIComponent(vocabName)}:derive?dataset=${encodeURIComponent(
          rawRef,
        )}&dimension=brand`,
        { method: 'POST' },
      ),
    )
    await expectStatus(derive, 200)
    const draft = (await derive.json()) as VocabularyResponse
    expect(draft.status).toBe('draft')
    expect(draft.meta.extractor).toEqual({
      source: 'assistant_json',
      raw_key: 'raw_brand',
      std_key: 'std_brand',
    })
    expect(draft.terms.map((term) => term.canonical).sort()).toEqual(['特变电工', '远东电缆'])

    const list = await getJson<VocabulariesPage>(app, '/v1/vocabularies?limit=500')
    expect(list.items.find((item) => item.name === vocabName)).toMatchObject({
      id: draft.id,
      dimension: 'brand',
      num_terms: 2,
      status: 'draft',
    })

    const curatedBody: VocabularyResponse = {
      ...draft,
      terms: [...draft.terms, { canonical: '新牌', aliases: [], meta: {} }],
    }
    const put = await app.fetch(
      request(`/v1/vocabularies/${encodeURIComponent(vocabName)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(curatedBody),
      }),
    )
    await expectStatus(put, 200)
    const curated = (await put.json()) as VocabularyResponse
    expect(curated.status).toBe('curated')
    expect(curated.id).not.toBe(draft.id)

    const normalizedRef = `${prefix}-labels-normalized`
    const normalize = await app.fetch(
      request(
        `/v1/vocabularies/${encodeURIComponent(vocabName)}:normalize?dataset=${encodeURIComponent(
          rawRef,
        )}&ref=${encodeURIComponent(normalizedRef)}`,
        { method: 'POST' },
      ),
    )
    await expectStatus(normalize, 200)
    expect(((await normalize.json()) as ManifestResponse).num_rows).toBe(3)
    const normalizedSamples = await getJson<SamplesPage>(
      app,
      `/v1/datasets/${normalizedRef}/samples`,
    )
    const stds = normalizedSamples.items.map(
      (sample) => JSON.parse(sample.messages.at(-1)?.content ?? '{}').std_brand,
    )
    expect(stds).toEqual(['远东电缆', '远东电缆', '特变电工'])

    const validateRef = `${prefix}-labels-checked`
    const validate = await app.fetch(
      request(
        `/v1/vocabularies/${encodeURIComponent(vocabName)}:validate?dataset=${encodeURIComponent(
          rawRef,
        )}&ref=${encodeURIComponent(validateRef)}`,
        { method: 'POST' },
      ),
    )
    await expectStatus(validate, 200)
    const validation = (await validate.json()) as ValidateResponse
    expect(validation.summary).toEqual({
      checked: 3,
      invalid: 0,
      offending_values: {},
    })
    const checkedSamples = await getJson<SamplesPage>(app, `/v1/datasets/${validateRef}/samples`)
    expect(checkedSamples.items.every((sample) => sample.signals.vocab_brand_valid)).toBe(true)
  })

  test('vocabulary routes surface invariant and extractor errors in the shared envelope', async () => {
    const { app, prefix } = makeApp()

    // 422: a vocabulary whose alias maps to two canonicals violates the
    // invariants; PUT must reject it as a validation error (parity: test_vocabulary.py).
    const conflict = await app.fetch(
      request(`/v1/vocabularies/${encodeURIComponent(`${prefix}-bad`)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dimension: 'brand',
          terms: [
            { canonical: 'A', aliases: ['x'] },
            { canonical: 'B', aliases: ['x'] },
          ],
        }),
      }),
    )
    expect(conflict.status).toBe(422)
    expect(((await conflict.json()) as ErrorResponse).error.code).toBe('validation_error')

    // 400: deriving for a dimension with no extractor preset and no override
    // body is a bad request.
    const missingExtractor = await app.fetch(
      request(
        `/v1/vocabularies/${encodeURIComponent(`${prefix}-color`)}:derive?dataset=${encodeURIComponent(
          `${prefix}-missing`,
        )}&dimension=color`,
        { method: 'POST' },
      ),
    )
    expect(missingExtractor.status).toBe(400)
    expect(((await missingExtractor.json()) as ErrorResponse).error.code).toBe('bad_request')
  })
})

function makeApp(): {
  app: ReturnType<typeof createApp>
  prefix: string
  workspace: Workspace
} {
  const prefix = `api-${randomUUID()}`
  const workspace = Workspace.open({ root: `./${prefix}`, store: createMemoryStore() })
  workspaces.push(workspace)

  return {
    app: createApp({ workspace }),
    prefix,
    workspace,
  }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init)
}

function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.fetch(
    request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )
}

async function getJson<T>(app: ReturnType<typeof createApp>, path: string): Promise<T> {
  const response = await app.fetch(request(path))
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${response.status}: ${await response.text()}`)
  }
}

function sftSamples(prefix: string): unknown[] {
  return [
    sft(prefix, 'hi', 'hello there'),
    sft(prefix, 'hi', 'hello there'),
    sft(prefix, 'what is 2+2', '4'),
  ]
}

function sft(prefix: string, user: string, assistant: string): unknown {
  return {
    kind: 'sft',
    messages: [
      { role: 'user', content: `${prefix}:${user}` },
      { role: 'assistant', content: assistant },
    ],
  }
}

function labeledSft(rawBrand: string, stdBrand: string): unknown {
  return {
    kind: 'sft',
    messages: [
      { role: 'user', content: 'normalize this' },
      {
        role: 'assistant',
        content: JSON.stringify({
          raw_brand: rawBrand,
          std_brand: stdBrand,
          params: {},
        }),
      },
    ],
  }
}

function preferenceJsonl(prefix: string): string {
  return [
    { prompt: `${prefix}:q1`, chosen: 'good', rejected: 'bad' },
    { prompt: `${prefix}:q2`, chosen: 'yes', rejected: 'no' },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')
}

interface ManifestResponse {
  readonly version: string
  readonly num_rows: number
  readonly kinds: Record<string, number>
}

interface SamplesPage {
  readonly total: number
  readonly limit: number
  readonly offset: number
  readonly items: Array<{
    readonly source?: string | null
    readonly messages: Array<{ readonly content?: string | null }>
    readonly signals: Record<string, unknown>
  }>
}

interface TransformsPage {
  readonly items: Array<{
    readonly name: string
    readonly params_schema: unknown
  }>
}

interface RefsPage {
  readonly items: RefInfo[]
}

interface RefInfo {
  readonly name: string
  readonly version: string
}

interface LineageNode {
  readonly version: string
  readonly produced_by?: {
    readonly op: string
  }
  readonly inputs?: LineageNode[]
}

interface ErrorResponse {
  readonly error: {
    readonly code: string
  }
}

interface VocabularyResponse {
  readonly id: string
  readonly name?: string | null
  readonly dimension: string
  readonly status: 'draft' | 'curated'
  readonly terms: Array<{
    readonly canonical: string
    readonly aliases: string[]
    readonly meta: Record<string, unknown>
  }>
  readonly meta: Record<string, unknown>
  readonly source?: string | null
}

interface VocabulariesPage {
  readonly items: Array<{
    readonly id: string
    readonly name?: string | null
    readonly dimension: string
    readonly num_terms: number
    readonly status?: string | null
  }>
}

interface ValidateResponse {
  readonly summary: {
    readonly checked: number
    readonly invalid: number
    readonly offending_values: Record<string, number>
  }
  readonly dataset: ManifestResponse
}
