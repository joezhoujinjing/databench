import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  deriveVocabulary,
  normalizeSamples,
  parseVocabularyInput,
  type Sample,
  sampleId,
  validateSamples,
  withVocabularyId,
} from '../src/index.js'

const PYTHON = '/Users/hanlu/Desktop/databench/databench/.venv/bin/python'
const BRAND = { source: 'assistant_json' as const, raw_key: 'raw_brand', std_key: 'std_brand' }
const UNIT = { source: 'assistant_json' as const, raw_key: 'raw_unit', std_key: 'std_unit' }

describe('vocabulary', () => {
  test('id is content-addressed and independent of name/status/meta/order', () => {
    const first = withVocabularyId(
      parseVocabularyInput({
        dimension: 'brand',
        terms: [
          { canonical: '远东电缆', aliases: ['远东'] },
          { canonical: '特变电工', aliases: ['TBEA'] },
        ],
      }),
    )
    const second = withVocabularyId(
      parseVocabularyInput({
        name: 'renamed',
        dimension: 'brand',
        status: 'draft',
        terms: [
          { canonical: '特变电工', aliases: ['TBEA'], meta: { count: 9 } },
          { canonical: '远东电缆', aliases: ['远东'] },
        ],
      }),
    )
    const unit = withVocabularyId(
      parseVocabularyInput({
        dimension: 'unit',
        terms: first.terms,
      }),
    )

    expect(second.id).toBe(first.id)
    expect(unit.id).not.toBe(first.id)
  })

  test('strict invariants reject duplicate canonicals and ambiguous aliases', () => {
    expect(() =>
      parseVocabularyInput({
        dimension: 'brand',
        terms: [
          { canonical: 'A', aliases: ['x'] },
          { canonical: 'B', aliases: ['x'] },
        ],
      }),
    ).toThrow(/maps to both/)

    expect(() =>
      parseVocabularyInput({
        dimension: 'brand',
        terms: [{ canonical: 'A' }, { canonical: 'A' }],
      }),
    ).toThrow(/duplicate canonical/)

    expect(() =>
      parseVocabularyInput({
        dimension: 'unit',
        terms: [{ canonical: '个' }, { canonical: '包', aliases: ['个'] }],
      }),
    ).toThrow(/also a canonical/)
  })

  test('derive groups labels and records extractor provenance', () => {
    const vocabulary = deriveVocabulary(fixture(), {
      dimension: 'brand',
      extractor: BRAND,
      name: 'brand',
    })
    const terms = Object.fromEntries(vocabulary.terms.map((term) => [term.canonical, term]))

    expect(vocabulary.status).toBe('draft')
    expect(vocabulary.meta.extractor).toEqual(BRAND)
    expect(Object.keys(terms).sort()).toEqual(['亚星', '特变电工', '远东电缆'])
    expect(terms.远东电缆?.aliases).toEqual(['远东'])
    expect(terms.远东电缆?.meta).toMatchObject({ count: 2, alias_counts: { 远东: 1 } })
    expect(terms.特变电工?.aliases).toEqual(['TBEA'])
  })

  test('derive resolves noisy aliases deterministically and records conflicts', () => {
    const vocabulary = deriveVocabulary(
      [sft('中超控股', '中超'), sft('中超控股', '中超'), sft('中超控股', '江苏中超控股')],
      { dimension: 'brand', extractor: BRAND },
    )
    const winner = vocabulary.terms.find((term) => term.canonical === '中超')
    const loser = vocabulary.terms.find((term) => term.canonical === '江苏中超控股')

    expect(winner?.aliases).toEqual(['中超控股'])
    expect(loser?.aliases).toEqual([])
    expect(winner?.meta.alias_conflicts).toEqual({
      中超控股: {
        chosen: '中超',
        also_seen: ['江苏中超控股'],
        counts: { 中超: 2, 江苏中超控股: 1 },
      },
    })
  })

  test('derive keeps raw values that are canonicals out of other alias lists', () => {
    const vocabulary = deriveVocabulary(
      [sft('X', 'X', '个', '个'), sft('X', 'X', '个', '包'), sft('X', 'X', '只', '包')],
      { dimension: 'unit', extractor: UNIT },
    )
    const terms = Object.fromEntries(vocabulary.terms.map((term) => [term.canonical, term]))

    expect(terms.个?.aliases).toEqual([])
    expect(terms.包?.aliases).toEqual(['只'])
    expect(terms.个?.meta.alias_conflicts).toEqual({
      个: {
        chosen: '个',
        also_seen: ['包'],
        counts: { 包: 1 },
      },
    })
  })

  test('derive always emits a valid vocabulary for dense conflicts', () => {
    const samples = ['A', 'B', 'C'].flatMap((std) =>
      Array.from({ length: 3 }, () => sft('messy', std)),
    )
    const vocabulary = deriveVocabulary(samples, { dimension: 'brand', extractor: BRAND })

    expect(vocabulary.id).toBeTruthy()
    expect(vocabulary.terms.filter((term) => term.aliases.includes('messy'))).toHaveLength(1)
  })

  test('normalize rewrites std labels and validate adds non-destructive signals', () => {
    const vocabulary = withVocabularyId(
      parseVocabularyInput({
        dimension: 'brand',
        terms: [{ canonical: '远东电缆', aliases: ['远东'] }],
      }),
    )
    const normalized = normalizeSamples([sft('远东', '远东')], vocabulary, BRAND)
    expect(JSON.parse(normalized[0]?.messages.at(-1)?.content ?? '{}')).toMatchObject({
      std_brand: '远东电缆',
    })

    const bad = sft('怪牌', '怪牌')
    bad.signals = { existing: 123 }
    const validated = validateSamples([sft('远东', '远东电缆'), bad], vocabulary, BRAND)

    expect(validated.summary).toEqual({
      checked: 2,
      invalid: 1,
      offending_values: { 怪牌: 1 },
    })
    expect(validated.samples[0]?.signals.vocab_brand_valid).toBe(true)
    expect(validated.samples[1]?.signals).toMatchObject({
      existing: 123,
      vocab_brand_valid: false,
    })
  })
})

describe.runIf(existsSync(PYTHON))('live Python vocabulary parity', () => {
  test('normalize writes assistant JSON and sample ids the same way as Python', () => {
    const input = sft('远东', '远东')
    const vocabulary = withVocabularyId(
      parseVocabularyInput({
        dimension: 'brand',
        terms: [{ canonical: '远东电缆', aliases: ['远东'] }],
      }),
    )
    const [normalized] = normalizeSamples([input], vocabulary, BRAND)
    expect(normalized).toBeDefined()

    const script = `
import json
import sys
import databench as db
from databench import Extractor, Term, Vocabulary
from databench.vocabulary import normalize_samples, validate_samples

payload = json.loads(sys.stdin.read())
sample = db.SFTSample(**payload["sample"])
vocab = Vocabulary(**payload["vocabulary"])
extractor = Extractor(**payload["extractor"])
out, = normalize_samples([sample], vocab, extractor)
_, summary = validate_samples([out], vocab, extractor)
print(json.dumps({
    "content": out.messages[-1].content,
    "id": out.id,
    "summary": summary,
}, ensure_ascii=False))
`

    const output = spawnSync(PYTHON, ['-c', script], {
      encoding: 'utf8',
      input: JSON.stringify({
        sample: input,
        vocabulary,
        extractor: BRAND,
      }),
    })

    expect(output.status, output.stderr).toBe(0)
    const python = JSON.parse(output.stdout) as {
      content: string
      id: string
      summary: { checked: number; invalid: number; offending_values: Record<string, number> }
    }

    expect(normalized?.messages.at(-1)?.content).toBe(python.content)
    expect(sampleId(normalized as Sample)).toBe(python.id)
    expect(validateSamples([normalized as Sample], vocabulary, BRAND).summary).toEqual(
      python.summary,
    )
  })
})

function fixture(): Sample[] {
  return [
    sft('远东', '远东电缆'),
    sft('远东电缆', '远东电缆'),
    sft('TBEA', '特变电工'),
    sft('特变电工', '特变电工'),
    sft('YX亚星', '亚星'),
  ]
}

function sft(rawBrand: string, stdBrand: string, rawUnit = 'm', stdUnit = '米'): Sample {
  return {
    kind: 'sft',
    source: null,
    meta: {},
    signals: {},
    messages: [
      { role: 'user', content: 'normalize this', name: null, tool_calls: null, tool_call_id: null },
      {
        role: 'assistant',
        content: JSON.stringify({
          raw_brand: rawBrand,
          std_brand: stdBrand,
          raw_unit: rawUnit,
          std_unit: stdUnit,
          params: {},
        }),
        name: null,
        tool_calls: null,
        tool_call_id: null,
      },
    ],
  }
}
