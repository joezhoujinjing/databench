import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonNumberValue, type Sample, sampleId } from '@databench/schema'
import { describe, expect, test } from 'vitest'
import { detectKind, exportRecord, readJsonl, recordToSample } from '../src/index.js'

const PYTHON = '/Users/hanlu/Desktop/databench/databench/.venv/bin/python'
const DEMO = '/Users/hanlu/Desktop/databench/databench/examples/demo'

async function collectJsonl(path: string) {
  const samples: Sample[] = []

  for await (const sample of readJsonl(path)) {
    samples.push(sample)
  }

  return samples
}

describe('kind detection', () => {
  test('matches Python short-circuit order and trajectory detection', () => {
    expect(detectKind({ messages: [{ role: 'user', content: 'hi' }] })).toBe('sft')
    expect(detectKind({ prompt: 'q', chosen: 'a', rejected: 'b' })).toBe('preference')
    expect(detectKind({ prompt: 'q', rollouts: [{ text: 'x', reward: 1.0 }] })).toBe('rl')
    expect(
      detectKind({ messages: [{ role: 'assistant', tool_calls: [{ name: 'search' }] }] }),
    ).toBe('trajectory')
    expect(detectKind({ messages: [], chosen: 'a', rejected: 'b' })).toBe('preference')
    expect(detectKind({ messages: [], rollouts: [] })).toBe('rl')
    expect(() => detectKind({ foo: 'bar' })).toThrow('could not detect sample kind')
  })
})

describe('record normalization', () => {
  test('normalizes preference string shorthand', () => {
    const sample = recordToSample({ prompt: 'q', chosen: 'good', rejected: 'bad' })

    expect(sample.kind).toBe('preference')
    expect(sample.prompt[0]).toMatchObject({ role: 'user', content: 'q' })
    expect(sample.chosen).toMatchObject({ role: 'assistant', content: 'good' })
  })

  test('normalizes rl prompt shorthand and preserves rollouts', () => {
    const sample = recordToSample({
      prompt: '2+2?',
      answer: '4',
      rollouts: [{ text: '4', reward: 1.0 }],
    })

    expect(sample.kind).toBe('rl')
    expect(sample.prompt[0]).toMatchObject({ role: 'user', content: '2+2?' })
    expect(sample.answer).toBe('4')
    expect(jsonNumberValue(sample.rollouts[0]?.reward ?? 0)).toBe(1)
  })

  test('source option tags provenance without overwriting record source', () => {
    expect(
      recordToSample({ messages: [{ role: 'user', content: 'hi' }] }, { source: 'seed' }).source,
    ).toBe('seed')
    expect(
      recordToSample(
        { source: 'record', messages: [{ role: 'user', content: 'hi' }] },
        { source: 'seed' },
      ).source,
    ).toBe('record')
  })
})

describe('jsonl ingestion', () => {
  test('reads demo jsonl files and applies filename stem as source', async () => {
    const sft = await collectJsonl(join(DEMO, 'sft.jsonl'))
    expect(sft).toHaveLength(5)
    expect(sft.every((sample) => sample.kind === 'sft')).toBe(true)
    expect(sft.every((sample) => sample.source === 'sft')).toBe(true)

    const preference = await collectJsonl(join(DEMO, 'preference.jsonl'))
    expect(preference).toHaveLength(3)
    expect(preference.every((sample) => sample.kind === 'preference')).toBe(true)
    expect(preference.every((sample) => sample.source === 'preference')).toBe(true)
  })

  test('skips blank lines and reports invalid JSON with one-based line number', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'databench-io-'))
    const path = join(directory, 'bad.jsonl')

    try {
      writeFileSync(path, '\n{"messages":[{"role":"user","content":"ok"}]}\n{bad}\n')

      await expect(collectJsonl(path)).rejects.toThrow(`${path}:3: invalid JSON`)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})

describe('export records', () => {
  test('matches kind-specific exclude-none export shape and ignores fmt', () => {
    const sft = recordToSample({ messages: [{ role: 'user', content: 'hi' }] })
    expect(exportRecord(sft)).toEqual({ messages: [{ role: 'user', content: 'hi' }] })

    const preference = recordToSample({ prompt: 'q', chosen: 'good', rejected: 'bad' })
    const expectedPreference = {
      prompt: [{ role: 'user', content: 'q' }],
      chosen: { role: 'assistant', content: 'good' },
      rejected: { role: 'assistant', content: 'bad' },
    }
    expect(exportRecord(preference)).toEqual(expectedPreference)
    expect(exportRecord(preference, 'trl')).toEqual(expectedPreference)

    const rl = recordToSample({ prompt: '2+2?', rollouts: [{ text: '4', reward: 1.0 }] })
    expect(exportRecord(rl)).toEqual({
      prompt: [{ role: 'user', content: '2+2?' }],
      rollouts: [{ text: '4', reward: 1, meta: {} }],
    })
  })

  test('converts parsed number lexemes to plain JSON numbers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'databench-io-export-'))
    const path = join(directory, 'rl.jsonl')

    try {
      writeFileSync(path, '{"prompt":"2+2?","rollouts":[{"text":"4","reward":1.0}]}\n')
      const [sample] = await collectJsonl(path)
      const exported = exportRecord(sample)

      expect(exported).toEqual({
        prompt: [{ role: 'user', content: '2+2?' }],
        rollouts: [{ text: '4', reward: 1, meta: {} }],
      })
      expect(JSON.stringify(exported)).not.toContain('"source"')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})

describe.runIf(existsSync(PYTHON))('live Python JSONL parity', () => {
  test('preserves JSON number lexemes from JSONL for sample identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'databench-io-'))
    const path = join(directory, 'rl.jsonl')
    const line =
      '{"prompt":"Compute 17 * 23.","answer":"391","verifier":"exact_match","rollouts":[{"text":"17 * 23 = 391","reward":1.0},{"text":"17 * 23 = 380","reward":0.0}]}\n'

    try {
      writeFileSync(path, line)

      const [sample] = await collectJsonl(path)
      expect(sample).toBeDefined()

      const script = `
from databench.io import read_jsonl
import sys
sample = next(read_jsonl(sys.argv[1]))
print(sample.id)
`
      const output = spawnSync(PYTHON, ['-c', script, path], {
        encoding: 'utf8',
      })

      expect(output.status, output.stderr).toBe(0)
      expect(sampleId(sample as Sample)).toBe(output.stdout.trim())
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
