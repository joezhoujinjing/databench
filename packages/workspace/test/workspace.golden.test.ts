import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog, createPrismaClient } from '@databench/catalog'
import { Dataset } from '@databench/engine'
import { dedup, enrichLength, filterBySignal } from '@databench/ops'
import type { Extractor, SFTSample } from '@databench/schema'
import { ValidationError } from '@databench/schema'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { mix, Workspace } from '../src/index.js'
import { createMemoryStore } from './memory-store.js'

const DEMO = '/Users/hanlu/Desktop/databench/databench/examples/demo'

const prisma = createPrismaClient()

beforeEach(async () => {
  await prisma.vocabularyRefRecord.deleteMany()
  await prisma.vocabularyRecord.deleteMany()
  await prisma.refRecord.deleteMany()
  await prisma.runRecord.deleteMany()
  await prisma.datasetRecord.deleteMany()
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('Workspace', () => {
  test('adds samples, resolves refs, and round-trips through store', async () => {
    const workspace = openWorkspace()
    const dataset = await workspace.addSamples([sft('a', 'b'), sft('c', 'd')], { name: 'raw' })
    const loaded = await workspace.get('raw')

    expect(loaded.version).toBe(dataset.version)
    expect(loaded.length).toBe(2)
    expect((await workspace.catalog.getDataset(dataset.version))?.num_rows).toBe(2)
  })

  test('hides refs whose dataset object is missing from the store', async () => {
    const workspace = openWorkspace()
    const dataset = await workspace.addSamples([sft('a', 'b')], { name: 'raw' })
    await workspace.catalog.setRef('stale', 'missing-version')

    expect(await workspace.listRefs()).toEqual({ raw: dataset.version })
    expect(await workspace.getRef('raw')).toBe(dataset.version)
    expect(await workspace.getRef('stale')).toBeNull()
  })

  test('adds JSONL and transform cache hits do not add producer rows', async () => {
    const workspace = openWorkspace()
    const dataset = await workspace.addJsonl(join(DEMO, 'sft.jsonl'), { name: 'sft' })
    expect(dataset.length).toBe(5)
    expect((await workspace.get('sft')).version).toBe(dataset.version)

    const first = await workspace.run(dedup, [dataset])
    const before = await workspace.catalog.runsProducing(first.version)
    const second = await workspace.run(dedup, [dataset])

    expect(first.version).toBe(second.version)
    expect(before).toHaveLength(1)
    expect(await workspace.catalog.runsProducing(first.version)).toHaveLength(before.length)
    expect(second.length).toBe(4)
  })

  test('records lineage across chained transforms', async () => {
    const workspace = openWorkspace()
    const raw = await workspace.addSamples([sft('a', 'b'), sft('a', 'b')], { name: 'raw' })
    const enriched = await workspace.run(enrichLength, [raw])
    const clean = await workspace.run(dedup, [enriched], { ref: 'clean' })
    const tree = await workspace.lineage('clean')

    expect(clean.length).toBe(1)
    expect(tree.produced_by?.op).toBe('dedup')
    expect(tree.inputs?.[0]?.produced_by?.op).toBe('enrich_length')
    expect(tree.inputs?.[0]?.inputs?.[0]?.version).toBe(raw.version)
  })

  test('enriches, filters, and materializes recipes reproducibly', async () => {
    const workspace = openWorkspace()
    await workspace.addSamples(
      [sft('hi', 'x'), sft('a longer user turn here', 'a much longer assistant answer here')],
      { name: 'raw' },
    )
    const enriched = await workspace.run(enrichLength, ['raw'], { ref: 'enriched' })
    const kept = await workspace.run(filterBySignal, [enriched], {
      params: { key: 'word_len', min: 5.0 },
    })
    expect(kept.length).toBe(1)

    await workspace.addSamples(
      Array.from({ length: 10 }, (_, index) => sft(`u${index}`, `a${index}`)),
      { name: 'sft' },
    )
    await workspace.addSamples(
      Array.from({ length: 10 }, (_, index) => preference(`q${index}`)),
      { name: 'pref' },
    )

    const recipe = {
      name: 'mix-v1',
      sources: [
        { dataset: 'sft', weight: 3, max_samples: 6 },
        { dataset: 'pref', weight: 1, max_samples: 6 },
      ],
      target_size: 8,
      seed: 42,
    }
    const first = await workspace.materialize(recipe, { ref: 'train' })
    const second = await workspace.materialize(recipe)
    const lineage = await workspace.lineage('train')

    expect(first.version).toBe(second.version)
    expect(lineage.produced_by?.op).toBe('recipe:mix-v1')
  })

  test("mix uses banker's rounding and treats zero weight as 1.0", () => {
    const left = Dataset.fromSamples(
      Array.from({ length: 10 }, (_, index) => sft(`left-${index}`, 'x', 'left')),
      'left',
    )
    const right = Dataset.fromSamples(
      Array.from({ length: 10 }, (_, index) => sft(`right-${index}`, 'x', 'right')),
      'right',
    )

    const halfEven = mix(
      {
        name: 'half-even',
        sources: [
          { dataset: 'left', weight: 1 },
          { dataset: 'right', weight: 1 },
        ],
        target_size: 5,
        seed: 0,
      },
      [
        { source: { dataset: 'left', weight: 1, max_samples: null }, frame: left.toPolars() },
        { source: { dataset: 'right', weight: 1, max_samples: null }, frame: right.toPolars() },
      ],
    )
    expect(halfEven.length).toBe(4)

    const zeroWeight = mix(
      {
        name: 'zero-weight',
        sources: [
          { dataset: 'left', weight: 0 },
          { dataset: 'right', weight: 1 },
        ],
        target_size: 4,
        seed: 0,
      },
      [
        { source: { dataset: 'left', weight: 0, max_samples: null }, frame: left.toPolars() },
        { source: { dataset: 'right', weight: 1, max_samples: null }, frame: right.toPolars() },
      ],
    )
    const sourceCounts = countSources(zeroWeight)

    expect(zeroWeight.length).toBe(4)
    expect(sourceCounts).toEqual({ left: 2, right: 2 })
  })

  test('exports JSONL with Python-compatible kind-specific records', async () => {
    const workspace = openWorkspace()
    const directory = mkdtempSync(join(tmpdir(), 'databench-workspace-'))
    const output = join(directory, 'train.jsonl')

    try {
      await workspace.addSamples([sft('hi', 'hello'), preference('q')], { name: 'raw' })
      const path = await workspace.export('raw', output, 'trl')
      const lines = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(lines).toHaveLength(2)
      expect(lines.some((line) => 'messages' in line)).toBe(true)
      expect(lines.some((line) => 'chosen' in line)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('derives, curates, normalizes, and validates vocabularies with lineage', async () => {
    const workspace = openWorkspace()
    await workspace.addSamples(
      [
        labeledSft('远东', '远东电缆'),
        labeledSft('远东电缆', '远东电缆'),
        labeledSft('TBEA', '特变电工'),
        labeledSft('怪牌', '怪牌'),
      ],
      { name: 'raw' },
    )

    const draft = await workspace.deriveVocabulary('raw', {
      name: 'brand',
      dimension: 'brand',
      extractor: BRAND,
    })
    expect(draft.status).toBe('draft')
    expect(draft.meta.extractor).toEqual(BRAND)
    expect((await workspace.listVocabularies())[0]).toMatchObject({
      name: 'brand',
      id: draft.id,
      status: 'draft',
    })

    const curated = await workspace.saveVocabulary({
      ...draft,
      terms: [...draft.terms, { canonical: '新牌', aliases: [], meta: {} }],
    })
    expect(curated.status).toBe('curated')
    expect(curated.id).not.toBe(draft.id)
    expect((await workspace.getVocabulary('brand')).id).toBe(curated.id)

    const normalized = await workspace.normalizeVocabulary('raw', curated, { ref: 'raw-norm' })
    const normalizedPayloads = [...normalized.toSamples()].map(
      (sample) => JSON.parse(sample.messages.at(-1)?.content ?? '{}') as Record<string, unknown>,
    )
    expect(normalizedPayloads.map((payload) => payload.std_brand)).toContain('远东电缆')
    expect((await workspace.lineage('raw-norm')).produced_by?.op).toBe('vocabulary:normalize')

    const validation = await workspace.validateVocabulary('raw', curated, { ref: 'raw-checked' })
    expect(validation.summary).toEqual({
      checked: 4,
      invalid: 0,
      offending_values: {},
    })
    expect(
      [...validation.dataset.toSamples()].every((sample) => sample.signals.vocab_brand_valid),
    ).toBe(true)
  })

  test('saveVocabulary enforces the invariants at the domain boundary (not just via HTTP)', async () => {
    const workspace = openWorkspace()

    // An alias mapping to two canonicals — illegal. `withVocabularyId` alone
    // would happily persist this; the domain method must reject it like Python.
    await expect(
      workspace.saveVocabulary({
        name: null,
        dimension: 'brand',
        status: 'curated',
        terms: [
          { canonical: 'A', aliases: ['x'], meta: {} },
          { canonical: 'B', aliases: ['x'], meta: {} },
        ],
        meta: {},
        source: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // The rejected write left nothing behind.
    expect(await workspace.listVocabularies()).toEqual([])
  })
})

const BRAND: Extractor = {
  source: 'assistant_json',
  raw_key: 'raw_brand',
  std_key: 'std_brand',
}

function openWorkspace(): Workspace {
  return Workspace.open({ catalog: new Catalog({ prisma }), store: createMemoryStore() })
}

function sft(user: string, assistant: string, source = 'seed'): SFTSample {
  return {
    kind: 'sft',
    source,
    messages: [
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ],
  }
}

function labeledSft(rawBrand: string, stdBrand: string): SFTSample {
  return sft(
    'normalize this',
    JSON.stringify({
      raw_brand: rawBrand,
      std_brand: stdBrand,
      params: {},
    }),
  )
}

function preference(prompt: string) {
  return {
    kind: 'preference',
    prompt: [{ role: 'user', content: prompt }],
    chosen: { role: 'assistant', content: 'good' },
    rejected: { role: 'assistant', content: 'bad' },
  }
}

function countSources(dataset: Dataset): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const sample of dataset.toSamples()) {
    if (sample.source) {
      counts[sample.source] = (counts[sample.source] ?? 0) + 1
    }
  }

  return counts
}
