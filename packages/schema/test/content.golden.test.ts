import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { canonicalJson } from '@databench/hashing'
import { describe, expect, test } from 'vitest'
import { parseSample, sampleId, toContent } from '../src/index.js'

const PYTHON = '/Users/hanlu/Desktop/databench/databench/.venv/bin/python'

const cases = [
  {
    name: 'sft-null-defaults',
    sample: {
      kind: 'sft',
      source: 'file-a',
      meta: { ignored: true },
      signals: { quality: 1 },
      messages: [
        { role: 'user', content: '你好' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ name: 'search', arguments: { q: 'x' } }],
        },
      ],
    },
    canonical:
      '{"kind":"sft","messages":[{"content":"你好","name":null,"role":"user","tool_call_id":null,"tool_calls":null},{"content":null,"name":null,"role":"assistant","tool_call_id":null,"tool_calls":[{"arguments":{"q":"x"},"id":null,"name":"search"}]}]}',
    id: 'e7875c7ae377da948f073831969eae7c533c6cf183e81da3ecf9894231705b1c',
  },
  {
    name: 'preference-candidates-null',
    sample: {
      kind: 'preference',
      prompt: [{ role: 'user', content: 'Pick one' }],
      chosen: { role: 'assistant', content: 'A' },
      rejected: [{ role: 'assistant', content: 'B' }],
    },
    canonical:
      '{"candidates":null,"chosen":{"content":"A","name":null,"role":"assistant","tool_call_id":null,"tool_calls":null},"kind":"preference","prompt":[{"content":"Pick one","name":null,"role":"user","tool_call_id":null,"tool_calls":null}],"rejected":[{"content":"B","name":null,"role":"assistant","tool_call_id":null,"tool_calls":null}]}',
    id: '72a1c5c2a86347de1b8f24d7681d33d4fc06504f949eeb1de80aa6924e2d59ec',
  },
  {
    name: 'rl-rollout-meta',
    sample: {
      kind: 'rl',
      prompt: [{ role: 'user', content: '2+2?' }],
      rollouts: [{ text: '4', reward: 1.25, meta: { judge: 'exact' } }],
    },
    canonical:
      '{"answer":null,"kind":"rl","prompt":[{"content":"2+2?","name":null,"role":"user","tool_call_id":null,"tool_calls":null}],"rollouts":[{"meta":{"judge":"exact"},"reward":1.25,"text":"4"}],"verifier":null}',
    id: 'dc74cea15e344e9b2f3188afb6ba9b021038b399568cdcb80651460c9ab40ef2',
  },
  {
    name: 'trajectory-tool-result',
    sample: {
      kind: 'trajectory',
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', name: 'lookup', arguments: '{"id":1}' }],
        },
        { role: 'tool', content: 'done', tool_call_id: 'call_1' },
      ],
    },
    canonical:
      '{"kind":"trajectory","messages":[{"content":null,"name":null,"role":"assistant","tool_call_id":null,"tool_calls":[{"arguments":"{\\"id\\":1}","id":"call_1","name":"lookup"}]},{"content":"done","name":null,"role":"tool","tool_call_id":"call_1","tool_calls":null}]}',
    id: '2fb75903373f775bfa76cb4ae7c4b8308bdd01074b00a1dfcfcb90a37f92ca42',
  },
  {
    name: 'rl-integer-reward-coerces-to-python-float',
    sample: {
      kind: 'rl',
      prompt: [{ role: 'user', content: 'prompt only' }],
      answer: 'answer ignored',
      rollouts: [{ text: 'rollout ignored too', reward: 1 }],
    },
    canonical:
      '{"answer":"answer ignored","kind":"rl","prompt":[{"content":"prompt only","name":null,"role":"user","tool_call_id":null,"tool_calls":null}],"rollouts":[{"meta":{},"reward":1.0,"text":"rollout ignored too"}],"verifier":null}',
    id: '6440ac5480d8fb1648630912be0f9e4d0633c8171ef6eff8c73dd88b44526992',
  },
] as const

describe('sample content identity', () => {
  test.each(cases)('matches Python content_dict golden: $name', ({ sample, canonical, id }) => {
    const parsed = parseSample(sample)
    const content = toContent(parsed)

    expect(canonicalJson(content)).toBe(canonical)
    expect(sampleId(parsed)).toBe(id)
  })

  test('top-level source, meta, and signals do not affect sample id', () => {
    const base = cases[0].sample
    const changed = {
      ...base,
      source: 'different-file',
      meta: { ignored: false, extra: 'not identity' },
      signals: { quality: 99, extra: true },
    }

    expect(sampleId(base)).toBe(sampleId(changed))
    expect(canonicalJson(toContent(base))).toBe(canonicalJson(toContent(changed)))
  })

  test('nested rollout meta remains identity-bearing content', () => {
    const base = cases[2].sample
    const changed = {
      ...base,
      rollouts: [{ text: '4', reward: 1.25, meta: { judge: 'changed' } }],
    }

    expect(sampleId(base)).not.toBe(sampleId(changed))
  })

  test('same messages with sft vs trajectory produce different ids', () => {
    const messages = [{ role: 'user', content: 'same' }]

    expect(sampleId({ kind: 'sft', messages })).not.toBe(sampleId({ kind: 'trajectory', messages }))
  })
})

describe.runIf(existsSync(PYTHON))('live Python schema parity', () => {
  test('content_dict canonical JSON and id match Python', () => {
    const script = `
import json
import sys
from databench.schema import parse_sample
from databench.hashing import canonical_json, hash_obj

items = json.loads(sys.stdin.read())
out = []
for item in items:
    sample = parse_sample(item["sample"])
    content = sample.content_dict()
    out.append({
        "name": item["name"],
        "canonical": canonical_json(content),
        "id": hash_obj(content),
    })
print(json.dumps(out, ensure_ascii=False))
`

    const output = spawnSync(PYTHON, ['-c', script], {
      encoding: 'utf8',
      input: JSON.stringify(cases),
    })

    expect(output.status, output.stderr).toBe(0)

    const python = JSON.parse(output.stdout) as Array<{
      name: string
      canonical: string
      id: string
    }>

    for (const item of cases) {
      const match = python.find((candidate) => candidate.name === item.name)

      expect(match?.canonical).toBe(item.canonical)
      expect(match?.id).toBe(item.id)
    }
  })
})
