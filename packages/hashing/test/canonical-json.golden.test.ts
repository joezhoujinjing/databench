import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  canonicalJson,
  HASH_ALGO,
  hashBytes,
  hashObj,
  hashText,
  hashUnordered,
  jsonNumberLexeme,
  parseCanonicalJson,
} from '../src/index.js'

const PYTHON = '/Users/hanlu/Desktop/databench/databench/.venv/bin/python'

const canonicalCases = [
  {
    name: 'unicode-null-nested-float',
    value: {
      z: null,
      中文: '值',
      nested: { b: true, a: 1.25 },
      items: [3, 2, 1],
    },
    canonical: '{"items":[3,2,1],"nested":{"a":1.25,"b":true},"z":null,"中文":"值"}',
    hash: 'b0faca1656f78383ac26aee1eb72965c78da69a837b7d586875dae09442d5aa7',
  },
  {
    name: 'integer-valued-floats-from-json',
    value: parseCanonicalJson('{"reward":1.0,"zero":0.0,"items":[1.0,0.5,null],"text":"中文"}'),
    canonical: '{"items":[1.0,0.5,null],"reward":1.0,"text":"中文","zero":0.0}',
    hash: '7a61c0d6f1ac2487b2dae5d6b1b7da67f19444dae4ccd11eefca9c83eb00c966',
  },
  {
    name: 'non-json-values-use-string-fallback',
    value: {
      bigint: 10n,
      missing: undefined,
      symbol: Symbol.for('databench'),
    },
    canonical: '{"bigint":"10","missing":"undefined","symbol":"Symbol(databench)"}',
    hash: '980926e74b4028d57088ee28c776343765ba496c0c8d228f830cb3116f431fca',
  },
] as const

describe('canonicalJson', () => {
  test.each(canonicalCases)('matches Python golden: $name', ({ value, canonical, hash }) => {
    expect(canonicalJson(value)).toBe(canonical)
    expect(hashObj(value)).toBe(hash)
    expect(hashObj(value)).toBe(hashText(canonical))
  })

  test('preserves JSON number lexemes when requested explicitly', () => {
    expect(canonicalJson({ reward: jsonNumberLexeme('1.0') })).toBe('{"reward":1.0}')
  })

  test('sorts nested object keys and does not drop undefined properties', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: undefined } })).toBe(
      '{"a":{"c":"undefined","d":4},"b":2}',
    )
  })
})

describe('digest helpers', () => {
  test('uses fixed BLAKE3 algorithm', () => {
    expect(HASH_ALGO).toBe('blake3')
  })

  test('hashText and hashUnordered match Python golden values', () => {
    expect(hashText('empty')).toBe(
      '6bdf3fe55052831d222fc6b82b2ba03f32b3599410fafd317642e21925c38f16',
    )
    expect(hashBytes(new TextEncoder().encode('empty'))).toBe(hashText('empty'))
    expect(hashText('')).toBe('af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262')
    expect(hashUnordered(['b', 'a', 'b'])).toBe(
      '87e9d6ac86e660496b7c770a33da6317ccd56cc856d4c799e055db136831171a',
    )
  })
})

describe.runIf(existsSync(PYTHON))('live Python parity', () => {
  test('canonicalJson and hashObj match Python hashing.py', () => {
    const payload = canonicalCases.map(({ name, canonical }) => ({
      name,
      canonical,
    }))

    const script = `
import json
import sys
from blake3 import blake3

items = json.loads(sys.stdin.read())
out = []
for item in items:
    canonical = item["canonical"]
    out.append({
        "name": item["name"],
        "hash": blake3(canonical.encode("utf-8")).hexdigest(),
    })
print(json.dumps(out, ensure_ascii=False))
`

    const output = spawnSync(PYTHON, ['-c', script], {
      encoding: 'utf8',
      input: JSON.stringify(payload),
    })

    expect(output.status, output.stderr).toBe(0)
    const python = JSON.parse(output.stdout) as Array<{ name: string; hash: string }>

    for (const item of canonicalCases) {
      expect(python.find((candidate) => candidate.name === item.name)?.hash).toBe(item.hash)
    }
  })
})
