import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { Catalog, createPrismaClient } from '../src/index.js'

let prisma: ReturnType<typeof createPrismaClient>
let catalog: Catalog

beforeAll(() => {
  prisma = createPrismaClient()
  catalog = new Catalog({ prisma })
})

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

describe('Catalog', () => {
  test('registerDataset is first-write-wins', async () => {
    await catalog.registerDataset('version-a', 'first', 2, { sft: 2 })
    const first = await catalog.getDataset('version-a')

    await catalog.registerDataset('version-a', 'second', 9, { rl: 9 })
    const second = await catalog.getDataset('version-a')

    expect(second).toEqual(first)
    expect(second).toMatchObject({
      version: 'version-a',
      name: 'first',
      num_rows: 2,
      kinds: { sft: 2 },
    })
  })

  test('recordRun replaces rows by cache key and runsProducing is deterministic', async () => {
    await catalog.recordRun('cache-b', 'dedup', '1', { keep: 'first' }, ['input-a'], 'out-1')
    await catalog.recordRun('cache-b', 'sample_n', '1', { n: 1, seed: 0 }, ['input-b'], 'out-2')
    await catalog.recordRun('cache-a', 'enrich_length', '1', {}, ['input-a'], 'out-2')

    const sameCreatedAt = new Date('2026-01-01T00:00:00.000Z')
    await prisma.runRecord.updateMany({
      where: { outputVersion: 'out-2' },
      data: { createdAt: sameCreatedAt },
    })

    expect(await catalog.findRun('cache-b')).toBe('out-2')
    expect(await catalog.findRun('missing')).toBeNull()
    expect(await catalog.runsProducing('out-1')).toEqual([])
    expect(await catalog.runsProducing('out-2')).toMatchObject([
      {
        cache_key: 'cache-a',
        op: 'enrich_length',
        op_version: '1',
        params: {},
        inputs: ['input-a'],
        output_version: 'out-2',
      },
      {
        cache_key: 'cache-b',
        op: 'sample_n',
        op_version: '1',
        params: { n: 1, seed: 0 },
        inputs: ['input-b'],
        output_version: 'out-2',
      },
    ])
  })

  test('setRef moves pointers and listRefs is sorted by name', async () => {
    await catalog.setRef('z-ref', 'version-1', 'old')
    await catalog.setRef('a-ref', 'version-0')
    await catalog.setRef('z-ref', 'version-2', 'new')

    expect(await catalog.getRef('z-ref')).toBe('version-2')
    expect(await catalog.getRef('missing')).toBeNull()
    expect(await catalog.listRefs()).toEqual({
      'a-ref': 'version-0',
      'z-ref': 'version-2',
    })

    const row = await prisma.refRecord.findUniqueOrThrow({ where: { name: 'z-ref' } })
    expect(row.message).toBe('new')
  })

  test('resolve prefers known dataset versions, then refs, then returns unknown strings', async () => {
    await catalog.registerDataset('same', 'dataset', 1, { sft: 1 })
    await catalog.setRef('same', 'ref-version')
    await catalog.setRef('named', 'resolved-version')

    expect(await catalog.resolve('same')).toBe('same')
    expect(await catalog.resolve('named')).toBe('resolved-version')
    expect(await catalog.resolve('unknown-version')).toBe('unknown-version')
  })

  test('vocabulary refs track latest content id and per-ref status', async () => {
    await catalog.registerVocabulary('vocab-a', 'brand', 'brand', 2)
    await catalog.registerVocabulary('vocab-b', 'brand', 'brand', 3)
    await catalog.setVocabularyRef('brand', 'vocab-a', 'draft')
    await catalog.setVocabularyRef('brand-copy', 'vocab-a', 'curated')
    await catalog.setVocabularyRef('brand', 'vocab-b', 'curated')

    expect(await catalog.getVocabularyRef('brand')).toBe('vocab-b')
    expect(await catalog.getVocabularyRefRow('brand')).toEqual({
      vocab_id: 'vocab-b',
      status: 'curated',
    })
    expect(await catalog.listVocabularies()).toEqual([
      {
        id: 'vocab-b',
        name: 'brand',
        dimension: 'brand',
        num_terms: 3,
        status: 'curated',
      },
      {
        id: 'vocab-a',
        name: 'brand-copy',
        dimension: 'brand',
        num_terms: 2,
        status: 'curated',
      },
    ])
  })
})
