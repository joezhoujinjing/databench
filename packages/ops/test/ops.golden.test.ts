import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dataset } from '@databench/engine'
import { isJsonNumberLexeme, jsonNumberValue, type Sample, sampleId } from '@databench/schema'
import { describe, expect, test } from 'vitest'
import {
  BUILTIN_TRANSFORMS,
  dedup,
  enrichLength,
  filterBySignal,
  pythonWordCount,
  sampleN,
  sampleText,
} from '../src/index.js'

const PYTHON = '/Users/hanlu/Desktop/databench/databench/.venv/bin/python'

const samples = [
  {
    kind: 'sft',
    source: 'dup-a',
    signals: { quality: 0.2 },
    messages: [
      { role: 'user', content: '  leading   spaces  ' },
      { role: 'assistant', content: 'assistant text' },
    ],
  },
  {
    kind: 'sft',
    source: 'dup-b',
    signals: { quality: 0.8 },
    messages: [
      { role: 'user', content: '  leading   spaces  ' },
      { role: 'assistant', content: 'assistant text' },
    ],
  },
  {
    kind: 'preference',
    prompt: [{ role: 'user', content: 'choose' }],
    chosen: { role: 'assistant', content: 'chosen words' },
    rejected: { role: 'assistant', content: 'rejected text must be ignored' },
  },
  {
    kind: 'rl',
    prompt: [{ role: 'user', content: 'prompt only' }],
    answer: 'answer ignored',
    rollouts: [{ text: 'rollout ignored too', reward: 1 }],
  },
  {
    kind: 'trajectory',
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ name: 'search', arguments: {} }] },
      { role: 'tool', content: 'tool result' },
    ],
  },
] as const

interface OpsSnapshot {
  dedupIds: string[]
  enriched: Array<{ id: string; signals: Record<string, unknown> }>
  filteredIds: string[]
  sampledIds: string[]
}

function dataset(): Dataset {
  return Dataset.fromSamples(samples, 'ops')
}

function ids(value: Dataset): string[] {
  return value
    .toPolars()
    .toRecords()
    .map((row) => String(row.id))
}

function snapshot(): OpsSnapshot {
  const original = dataset()
  const enriched = enrichLength.fn(original) as Dataset
  const filterParams = filterBySignal.buildParams({ key: 'word_len', min: 3 }).params

  return {
    dedupIds: ids(dedup.fn(original) as Dataset),
    enriched: Array.from(enriched.toSamples()).map((sample) => ({
      id: sampleId(sample),
      signals: normalizeSignals(sample.signals),
    })),
    filteredIds: ids(filterBySignal.fn(enriched, filterParams) as Dataset),
    sampledIds: ids(sampleN.fn(original, sampleN.buildParams({ n: 3, seed: 7 }).params) as Dataset),
  }
}

function normalizeSignals(signals: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(signals).map(([key, value]) => [
      key,
      isJsonNumberLexeme(value) ? jsonNumberValue(value) : value,
    ]),
  )
}

describe('built-in transforms', () => {
  test('registry exposes the four Python-compatible built-ins', () => {
    expect(Object.keys(BUILTIN_TRANSFORMS).sort()).toEqual([
      'dedup',
      'enrich_length',
      'filter_by_signal',
      'sample_n',
    ])
    expect(Object.values(BUILTIN_TRANSFORMS).map((transform) => transform.version)).toEqual([
      '1',
      '1',
      '1',
      '1',
    ])
  })

  test('text extraction and word splitting match Python intent', () => {
    const parsed = Array.from(dataset().toSamples())

    expect(sampleText(parsed[0] as Sample)).toBe('  leading   spaces   assistant text')
    expect(sampleText(parsed[2] as Sample)).toBe('choose chosen words')
    expect(sampleText(parsed[3] as Sample)).toBe('prompt only')
    expect(sampleText(parsed[4] as Sample)).toBe('tool result')
    expect(pythonWordCount('  a \t b\n\nc  ')).toBe(3)
    expect(pythonWordCount('   ')).toBe(0)
  })

  test('dedup, enrich_length, filter_by_signal, and sample_n behavior', () => {
    const result = snapshot()

    expect(result.dedupIds).toHaveLength(4)
    expect(result.dedupIds[0]).toBe(result.enriched[0]?.id)
    expect(result.enriched[0]?.signals).toMatchObject({
      quality: 0.2,
      char_len: 35,
      word_len: 4,
    })
    expect(result.enriched[1]?.signals).toMatchObject({
      quality: 0.8,
      char_len: 35,
      word_len: 4,
    })
    expect(result.enriched[2]?.signals).toMatchObject({ char_len: 19, word_len: 3 })
    expect(result.enriched[3]?.signals).toMatchObject({ char_len: 11, word_len: 2 })
    expect(result.filteredIds).toEqual(result.enriched.slice(0, 3).map((row) => row.id))

    const noOp = sampleN.fn(dataset(), sampleN.buildParams({ n: 99 }).params) as Dataset
    expect(ids(noOp)).toEqual(ids(dataset()))
    expect(result.sampledIds).toHaveLength(3)
  })

  test('filter_by_signal defaults keep all rows', () => {
    const enriched = enrichLength.fn(dataset()) as Dataset
    const params = filterBySignal.buildParams({ key: 'missing' }).params

    expect(ids(filterBySignal.fn(enriched, params) as Dataset)).toEqual(ids(enriched))
  })
})

describe.runIf(existsSync(PYTHON))('live Python ops parity', () => {
  test('matches Python built-in ops outputs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'databench-ops-'))
    const inputPath = join(directory, 'samples.json')

    try {
      writeFileSync(inputPath, JSON.stringify(samples))

      const script = `
import json
import sys
from databench.dataset import Dataset
from databench.schema import parse_sample
from databench import ops

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    samples = [parse_sample(item) for item in json.load(fh)]

ds = Dataset.from_samples(samples, name="ops")
enriched = ops.enrich_length.fn(ds)
filtered = ops.filter_by_signal.fn(enriched, ops.SignalFilterParams(key="word_len", min=3))
sampled = ops.sample_n.fn(ds, ops.SampleNParams(n=3, seed=7))

def ids(dataset):
    return [row["id"] for row in dataset.polars().to_dicts()]

print(json.dumps({
    "dedupIds": ids(ops.dedup.fn(ds)),
    "enriched": [
        {"id": sample.id, "signals": sample.signals}
        for sample in enriched.to_samples()
    ],
    "filteredIds": ids(filtered),
    "sampledIds": ids(sampled),
}, ensure_ascii=False))
`

      const output = spawnSync(PYTHON, ['-c', script, inputPath], {
        encoding: 'utf8',
      })

      expect(output.status, output.stderr).toBe(0)
      expect(snapshot()).toEqual(JSON.parse(output.stdout) as OpsSnapshot)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
