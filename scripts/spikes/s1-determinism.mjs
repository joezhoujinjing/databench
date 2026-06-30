#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blake3 } from 'hash-wasm'
import pl from 'nodejs-polars'

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const benchRoot =
  process.env.DATABENCH_BENCH_ROOT ?? '/Users/hanlu/Desktop/databench/databench/bench'
const pythonExecutable =
  process.env.DATABENCH_PYTHON ?? '/Users/hanlu/Desktop/databench/databench/.venv/bin/python'
const outputPath = resolve(repoRoot, 'docs/spikes/s1-determinism.results.json')
const seeds = [0, 1, 7, 42]

const canonicalFixtures = [
  {
    name: 'unicode-null-nested-float',
    json: '{"z":null,"中文":"值","nested":{"b":true,"a":1.25},"items":[3,2,1]}',
  },
  {
    name: 'integer-valued-floats',
    json: '{"reward":1.0,"zero":0.0,"items":[1.0,0.5,null],"text":"中文"}',
  },
]

class NumberLexeme {
  constructor(source) {
    this.source = source
  }
}

function parseJsonWithNumberLexemes(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === 'number' && context?.source !== undefined) {
      return new NumberLexeme(context.source)
    }

    return value
  })
}

function canonicalJson(value) {
  if (value instanceof NumberLexeme) {
    return value.source
  }

  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }

  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return JSON.stringify(String(value))
    }

    return String(value)
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }

  return JSON.stringify(String(value))
}

function objectPath(version, extension) {
  return resolve(benchRoot, 'store/objects', version.slice(0, 2), `${version}.${extension}`)
}

function readManifest(version) {
  return JSON.parse(readFileSync(objectPath(version, 'manifest.json'), 'utf8'))
}

function sampleIds(frame, n, seed) {
  const sampled = frame.sample(n, undefined, false, seed)

  return sampled.getColumn('id').toArray()
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function runPythonReference() {
  const script = `
import json
import sys
from pathlib import Path

import polars as pl
from blake3 import blake3


def canonical_json(obj):
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )


payload = json.load(sys.stdin)
bench_root = Path(payload["benchRoot"])
seeds = payload["seeds"]
fixtures = payload["fixtures"]

versions = []
for manifest_path in sorted((bench_root / "store" / "objects").glob("*/*.manifest.json")):
    manifest = json.loads(manifest_path.read_text())
    versions.append(manifest["version"])

samples = []
for version in versions:
    parquet_path = bench_root / "store" / "objects" / version[:2] / f"{version}.parquet"
    frame = pl.read_parquet(parquet_path)
    ns = sorted(set([1, frame.height - 1]))
    for n in ns:
        if n <= 0 or n >= frame.height:
            continue
        for seed in seeds:
            selected = frame.sample(n=n, seed=seed).get_column("id").to_list()
            samples.append({"version": version, "height": frame.height, "n": n, "seed": seed, "ids": selected})

canonical = []
for fixture in fixtures:
    encoded = canonical_json(json.loads(fixture["json"]))
    canonical.append({"name": fixture["name"], "canonical": encoded, "hash": blake3(encoded.encode("utf-8")).hexdigest()})

empty_hash = blake3("empty".encode("utf-8")).hexdigest()

print(json.dumps({
    "polarsVersion": pl.__version__,
    "samples": samples,
    "canonical": canonical,
    "emptyHash": empty_hash,
}, ensure_ascii=False))
`

  const output = spawnSync(pythonExecutable, ['-c', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify({ benchRoot, seeds, fixtures: canonicalFixtures }),
  })

  if (output.status !== 0) {
    throw new Error(
      `Python reference failed with status ${output.status}\nSTDOUT:\n${output.stdout}\nSTDERR:\n${output.stderr}`,
    )
  }

  return JSON.parse(output.stdout)
}

async function hashText(text) {
  return blake3(text)
}

function renderResult(result) {
  return `${JSON.stringify(result, null, 2).replace(
    /"seeds": \[\n {6}0,\n {6}1,\n {6}7,\n {6}42\n {4}\]/,
    '"seeds": [0, 1, 7, 42]',
  )}\n`
}

async function compareCanonicalFixtures(pythonReference) {
  const fixtures = []

  for (const fixture of canonicalFixtures) {
    const parsed = parseJsonWithNumberLexemes(fixture.json)
    const canonical = canonicalJson(parsed)
    const hash = await hashText(canonical)
    const expected = pythonReference.canonical.find((item) => item.name === fixture.name)

    fixtures.push({
      name: fixture.name,
      passed: canonical === expected?.canonical && hash === expected?.hash,
      nodeCanonical: canonical,
      pythonCanonical: expected?.canonical,
      nodeHash: hash,
      pythonHash: expected?.hash,
    })
  }

  return fixtures
}

async function compareBenchRows(versions) {
  const failures = []
  let rows = 0

  for (const version of versions) {
    const manifest = readManifest(version)
    const frame = pl.readParquet(objectPath(version, 'parquet'))
    let versionRows = 0

    for (const row of frame.toRecords()) {
      rows += 1
      versionRows += 1

      const payload = canonicalJson(parseJsonWithNumberLexemes(row.payload))
      const meta = canonicalJson(parseJsonWithNumberLexemes(row.meta))
      const signals = canonicalJson(parseJsonWithNumberLexemes(row.signals))
      const id = await hashText(payload)
      const rowDigest = await hashText([payload, row.source ?? '', meta, signals].join('\u0000'))

      if (payload !== row.payload || meta !== row.meta || signals !== row.signals) {
        failures.push({
          version,
          kind: 'canonical-json',
          id: row.id,
          expectedPayload: row.payload,
          actualPayload: payload,
        })
      }

      if (id !== row.id) {
        failures.push({ version, kind: 'sample-id', expected: row.id, actual: id })
      }

      if (rowDigest !== row.row_digest) {
        failures.push({
          version,
          kind: 'row-digest',
          expected: row.row_digest,
          actual: rowDigest,
        })
      }
    }

    if (versionRows !== manifest.num_rows) {
      failures.push({
        version,
        kind: 'manifest-row-count',
        expected: manifest.num_rows,
        actual: versionRows,
      })
    }
  }

  return {
    checkedRows: rows,
    passed: failures.length === 0,
    failures,
  }
}

function compareSampling(pythonSamples) {
  const failures = []

  for (const sample of pythonSamples) {
    const frame = pl.readParquet(objectPath(sample.version, 'parquet'))
    const actual = sampleIds(frame, sample.n, sample.seed)

    if (!arraysEqual(actual, sample.ids)) {
      failures.push({
        version: sample.version,
        height: sample.height,
        n: sample.n,
        seed: sample.seed,
        expected: sample.ids,
        actual,
      })
    }
  }

  return {
    checkedCases: pythonSamples.length,
    passed: failures.length === 0,
    failures,
  }
}

function inspectObjectOverload() {
  const packageRoot = dirname(require.resolve('nodejs-polars/package.json'))
  const implementationPath = resolve(packageRoot, 'bin/dataframe.js')
  const implementation = readFileSync(implementationPath, 'utf8')
  const forwardsOuterSeed = implementation.includes(
    'return this.sample(opts.n, opts.frac, opts.withReplacement, seed);',
  )
  const forwardsOptsSeed = implementation.includes(
    'return this.sample(opts.n, opts.frac, opts.withReplacement, opts.seed);',
  )

  return {
    usableForSeededSampling: forwardsOptsSeed && !forwardsOuterSeed,
    implementationPath,
    forwardsOptsSeed,
    forwardsOuterSeed,
    conclusion: forwardsOuterSeed
      ? 'The object overload does not forward opts.seed in nodejs-polars 0.25.1, so seeded sampling must use positional arguments.'
      : 'Object overload implementation should be rechecked before use.',
  }
}

async function main() {
  const pythonReference = runPythonReference()
  const versions = [...new Set(pythonReference.samples.map((sample) => sample.version))].sort()
  const positionalSampling = compareSampling(pythonReference.samples)
  const objectOverloadSampling = inspectObjectOverload()
  const canonicalFixturesResult = await compareCanonicalFixtures(pythonReference)
  const benchRows = await compareBenchRows(versions)
  const emptyHash = await hashText('empty')

  const result = {
    reference: {
      benchRoot,
      pythonExecutable,
      pythonPolarsVersion: pythonReference.polarsVersion,
      nodejsPolarsVersion: pl.version,
      blake3Package: 'hash-wasm',
    },
    sampling: {
      seeds,
      positional: positionalSampling,
      objectOverload: objectOverloadSampling,
    },
    hashing: {
      canonicalFixtures: canonicalFixturesResult,
      benchRows,
      emptyHash: {
        passed: emptyHash === pythonReference.emptyHash,
        nodeHash: emptyHash,
        pythonHash: pythonReference.emptyHash,
      },
    },
    conclusion: {
      samplingEnginePath:
        'Use nodejs-polars DataFrame.sample(n, undefined, false, seed) through a local wrapper; do not use the object overload for seeded sampling.',
      canonicalJsonPath:
        'Use canonical JSON with sorted keys, no whitespace, ensure_ascii=false semantics, and source-aware number lexeme preservation for JSON inputs so integer-valued floats such as 1.0 remain byte-compatible with Python.',
      blake3Path: 'hash-wasm blake3 matches Python blake3 for text inputs and bench row digests.',
    },
  }

  const ok =
    positionalSampling.passed &&
    canonicalFixturesResult.every((fixture) => fixture.passed) &&
    benchRows.passed &&
    result.hashing.emptyHash.passed

  result.ok = ok
  const rendered = renderResult(result)

  if (process.argv.includes('--write')) {
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, rendered)
  }

  console.log(rendered)

  if (!ok) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
