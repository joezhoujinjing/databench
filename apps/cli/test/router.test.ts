import { BadInputError, ConflictError, NotFoundError, ValidationError } from '@databench/schema'
import type { Workspace } from '@databench/workspace'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ZodError } from 'zod'
import { EXIT, exitCodeFor } from '../src/exit.js'
import { run } from '../src/main.js'
import { parseGlobal } from '../src/router.js'
import { setWorkspaceForTest } from '../src/runtime.js'

const manifest = {
  name: 'demo',
  version: 'v-demo',
  schema_version: '1',
  hash_algo: 'blake3',
  num_rows: 2,
  kinds: { sft: 2 },
  columns: [],
  created_at: '2026-07-02T00:00:00Z',
}

function fakeWorkspace(): Workspace {
  return {
    get: vi.fn(async () => ({ manifest, length: 2, toSamples: () => [].values() })),
    lineage: vi.fn(async (ref: string) => ({ version: ref, name: 'demo' })),
    check: vi.fn(async () => ({ database: { ok: true }, store: { ok: false, error: 'boom' } })),
    close: vi.fn(async () => {}),
  } as unknown as Workspace
}

let stdout: string[]
let stderr: string[]

beforeEach(() => {
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  setWorkspaceForTest(null)
})

describe('parseGlobal', () => {
  test('extracts global flags before the noun and leaves the rest verbatim', () => {
    const { flags, rest } = parseGlobal([
      '--database-url',
      'postgres://x',
      '--compact',
      'dataset',
      'show',
      'demo',
    ])
    expect(flags).toEqual({ databaseUrl: 'postgres://x', compact: true })
    expect(rest).toEqual(['dataset', 'show', 'demo'])
  })

  test('supports --key=value form and defaults compact to false', () => {
    const { flags, rest } = parseGlobal(['--database-url=postgres://x', 'transform', 'list'])
    expect(flags).toEqual({ databaseUrl: 'postgres://x', compact: false })
    expect(rest).toEqual(['transform', 'list'])
  })

  test('leaves command flags in place but consumes globals wherever they appear', () => {
    const { flags, rest } = parseGlobal(['transform', 'run', 'x', '--input', 'a', '--compact'])
    expect(flags).toEqual({ compact: true })
    expect(rest).toEqual(['transform', 'run', 'x', '--input', 'a'])
  })

  test('passes tokens after -- through untouched', () => {
    const { rest } = parseGlobal(['dataset', 'add', '--', '--compact'])
    expect(rest).toEqual(['dataset', 'add', '--', '--compact'])
  })
})

describe('dispatch / run', () => {
  test('dataset show prints the manifest as JSON on stdout', async () => {
    setWorkspaceForTest(fakeWorkspace())
    const code = await run(['dataset', 'show', 'demo'])
    expect(code).toBe(EXIT.ok)
    expect(JSON.parse(stdout.join(''))).toMatchObject({ name: 'demo', version: 'v-demo' })
    expect(stderr).toHaveLength(0)
  })

  test('lineage routes through the default verb and passes the ref through', async () => {
    setWorkspaceForTest(fakeWorkspace())
    const code = await run(['lineage', 'demo'])
    expect(code).toBe(EXIT.ok)
    expect(JSON.parse(stdout.join(''))).toEqual({ version: 'demo', name: 'demo' })
  })

  test('transform list returns the built-in registry without a workspace', async () => {
    const code = await run(['transform', 'list'])
    expect(code).toBe(EXIT.ok)
    const payload = JSON.parse(stdout.join('')) as { total: number; items: { name: string }[] }
    expect(payload.items.map((item) => item.name)).toContain('sample_n')
    expect(payload.total).toBeGreaterThan(0)
  })

  test('help emits an executable contract: names, option types, positionals, output kind', async () => {
    const code = await run(['help'])
    expect(code).toBe(EXIT.ok)
    type Verb = {
      name: string
      output: string
      positionals: { name: string; required?: boolean }[]
      options: { name: string; type: string; short?: string; multiple?: boolean }[]
    }
    const payload = JSON.parse(stdout.join('')) as {
      commands: { name: string; default_verb?: string; verbs: Verb[] }[]
    }
    expect(payload.commands.map((command) => command.name)).toEqual([
      'dataset',
      'transform',
      'lineage',
      'meta',
    ])

    const dataset = payload.commands.find((command) => command.name === 'dataset')
    const add = dataset?.verbs.find((verb) => verb.name === 'add')
    expect(add?.positionals).toEqual([{ name: 'file', required: true }])
    expect(add?.options).toContainEqual({ name: 'samples', type: 'boolean' })
    // export is the documented raw-stream exception to JSON-everywhere.
    expect(dataset?.verbs.find((verb) => verb.name === 'export')?.output).toBe('ndjson')

    const transform = payload.commands.find((command) => command.name === 'transform')
    const runVerb = transform?.verbs.find((verb) => verb.name === 'run')
    expect(runVerb?.options).toContainEqual({ name: 'input', type: 'string', multiple: true })

    // lineage exposes its default verb so `lineage <ref>` is discoverable.
    expect(payload.commands.find((command) => command.name === 'lineage')?.default_verb).toBe(
      'show',
    )
  })

  test('meta doctor reports backend health and exits 0', async () => {
    setWorkspaceForTest(fakeWorkspace())
    const code = await run(['meta', 'doctor'])
    expect(code).toBe(EXIT.ok)
    expect(JSON.parse(stdout.join(''))).toEqual({
      database: { ok: true },
      store: { ok: false, error: 'boom' },
    })
  })

  test('unknown command exits 2 with a bad_request envelope on stderr', async () => {
    const code = await run(['frobnicate'])
    expect(code).toBe(EXIT.badInput)
    expect(JSON.parse(stderr.join('')).error.code).toBe('bad_request')
    expect(stdout).toHaveLength(0)
  })

  test('missing required positional exits 2 without touching stdout', async () => {
    setWorkspaceForTest(fakeWorkspace())
    const code = await run(['dataset', 'show'])
    expect(code).toBe(EXIT.badInput)
    expect(JSON.parse(stderr.join('')).error.code).toBe('bad_request')
    expect(stdout).toHaveLength(0)
  })

  test('unknown flag on a known verb exits 2', async () => {
    const code = await run(['transform', 'list', '--bogus'])
    expect(code).toBe(EXIT.badInput)
  })

  test('a global value flag missing its value yields an envelope, not a crash', async () => {
    const code = await run(['--database-url'])
    expect(code).toBe(EXIT.badInput)
    expect(JSON.parse(stderr.join('')).error.code).toBe('bad_request')
  })

  test('--compact=<value> is rejected (boolean flags take no value)', async () => {
    const code = await run(['--compact=false', 'help'])
    expect(code).toBe(EXIT.badInput)
    expect(JSON.parse(stderr.join('')).error.code).toBe('bad_request')
  })

  test('<cmd> --help prints scoped help for that command', async () => {
    const code = await run(['dataset', '--help'])
    expect(code).toBe(EXIT.ok)
    const payload = JSON.parse(stdout.join('')) as { commands: { name: string }[] }
    expect(payload.commands.map((command) => command.name)).toEqual(['dataset'])
  })

  test('help for an unknown topic errors instead of dumping the whole catalog', async () => {
    const code = await run(['help', 'frobnicate'])
    expect(code).toBe(EXIT.badInput)
    expect(JSON.parse(stderr.join('')).error.code).toBe('bad_request')
    expect(stdout).toHaveLength(0)
  })

  test('out-of-range pagination is rejected like the API (validation)', async () => {
    const code = await run(['transform', 'list', '--limit', '0'])
    expect(code).toBe(EXIT.validation)
    expect(JSON.parse(stderr.join('')).error.code).toBe('validation_error')
  })

  test('garbage pagination value is rejected (not silently truncated)', async () => {
    const code = await run(['transform', 'list', '--limit', '20x'])
    expect(code).toBe(EXIT.validation)
  })
})

describe('exitCodeFor', () => {
  test('maps each error class to its distinct code, mirroring the API taxonomy', () => {
    expect(exitCodeFor(new NotFoundError('x'))).toBe(EXIT.notFound)
    expect(exitCodeFor(new ConflictError('x'))).toBe(EXIT.conflict)
    expect(exitCodeFor(new ValidationError('x'))).toBe(EXIT.validation)
    expect(exitCodeFor(new ZodError([]))).toBe(EXIT.validation)
    expect(exitCodeFor(new BadInputError('x'))).toBe(EXIT.badInput)
    expect(exitCodeFor(new TypeError('x'))).toBe(EXIT.badInput)
    // plain Error → bad_request (like the API), other Error subclasses → internal
    expect(exitCodeFor(new Error('x'))).toBe(EXIT.badInput)
    expect(exitCodeFor(new RangeError('x'))).toBe(EXIT.internal)
  })
})
