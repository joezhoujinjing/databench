import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExportPlanV2, type ExportPlanV2 } from '@databench/schema'
import type { V2Workspace } from '@databench/workspace'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EXIT } from '../src/exit.js'
import { run } from '../src/main.js'
import { setWorkspaceForTest } from '../src/runtime.js'
import { writeCliFileAtomically, writeCliStdout } from '../src/streaming.js'

const VERSION = 'a'.repeat(64)
const NEXT_VERSION = 'b'.repeat(64)

let stdout: Uint8Array[]
let stderr: Uint8Array[]

beforeEach(() => {
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      stdout.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
      callback?.()
      return true
    },
  )
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
    return true
  })
})

afterEach(() => {
  setWorkspaceForTest(null)
  vi.restoreAllMocks()
})

describe('product command router', () => {
  test('publishes only the complete canonical command catalog', async () => {
    expect(await run(['help', '--compact'])).toBe(EXIT.ok)
    const catalog = outputJson<{
      commands: Array<{ name: string; verbs: Array<{ name: string }> }>
    }>()
    expect(catalog.commands.map(({ name }) => name)).toEqual([
      'dataset',
      'converter',
      'transform',
      'ref',
      'lineage',
    ])
    expect(
      catalog.commands.flatMap((group) => group.verbs.map((verb) => `${group.name} ${verb.name}`)),
    ).toEqual([
      'dataset ingest',
      'dataset show',
      'dataset records',
      'dataset audit',
      'dataset export',
      'converter list',
      'converter show',
      'transform list',
      'transform run',
      'ref list',
      'ref show',
      'ref move',
      'lineage show',
    ])

    expect(
      catalog.commands.some(({ name }) => ['recipe', 'vocab', 'meta', 'v2'].includes(name)),
    ).toBe(false)
  })

  test('routes dataset reads through V2Workspace with schema-coerced pagination', async () => {
    const workspace = fakeWorkspace()
    injectWorkspace(workspace)

    expect(
      await run(['dataset', 'records', 'main', '--offset', '2', '--limit', '7', '--compact']),
    ).toBe(EXIT.ok)
    expect(workspace.getRecordPage).toHaveBeenCalledWith(
      'main',
      { offset: 2, limit: 7 },
      { signal: expect.any(AbortSignal) },
    )
    expect(outputJson()).toEqual({ dataset_version: VERSION, items: [] })
  })

  test('always inspects first and exports the exact inspected version', async () => {
    const workspace = fakeWorkspace()
    injectWorkspace(workspace)

    expect(
      await run(['dataset', 'export', 'main', '--converter', 'canonical-jsonl', '--compact']),
    ).toBe(EXIT.ok)
    expect(workspace.inspectExport.mock.invocationCallOrder[0]).toBeLessThan(
      workspace.export.mock.invocationCallOrder[0] as number,
    )
    expect(workspace.export).toHaveBeenCalledWith(
      VERSION,
      { converter: 'canonical-jsonl', options: {}, accepted_fidelity_digest: null },
      { signal: expect.any(AbortSignal) },
    )
    expect(new TextDecoder().decode(joinBytes(stdout))).toBe('{"ok":true}\n')
    expect(stderr).toHaveLength(0)
  })

  test('prints inspect plan as JSON and does not create an export stream', async () => {
    const workspace = fakeWorkspace()
    injectWorkspace(workspace)
    expect(await run(['dataset', 'export', 'main', '--inspect', '--compact'])).toBe(EXIT.ok)
    expect(outputJson<{ dataset_version: string }>().dataset_version).toBe(VERSION)
    expect(workspace.export).not.toHaveBeenCalled()
  })

  test('rejects semantic export until the exact inspected fidelity digest is supplied', async () => {
    const semanticPlan = exportPlan(true)
    const workspace = fakeWorkspace({ plan: semanticPlan })
    injectWorkspace(workspace)

    expect(await run(['dataset', 'export', 'main', '--compact'])).toBe(EXIT.validation)
    expect(outputError().code).toBe('fidelity_error')
    expect(workspace.export).not.toHaveBeenCalled()

    stdout.length = 0
    stderr.length = 0
    expect(
      await run(['dataset', 'export', 'main', '--accept-fidelity', semanticPlan.fidelity_digest]),
    ).toBe(EXIT.ok)
    expect(workspace.export).toHaveBeenCalledTimes(1)
  })

  test('does not expose native paths or credential-shaped URLs in diagnostics', async () => {
    const workspace = fakeWorkspace()
    workspace.inspectExport.mockRejectedValueOnce(
      new Error(
        'dependency failed at https://alice:secret@example.invalid/object?signature=token /Users/alice/private.jsonl',
      ),
    )
    injectWorkspace(workspace)

    expect(await run(['dataset', 'export', 'main', '--inspect'])).not.toBe(EXIT.ok)
    const diagnostic = new TextDecoder().decode(joinBytes(stderr))
    expect(diagnostic).toContain('Command failed without a safe diagnostic message')
    expect(diagnostic).not.toContain('alice')
    expect(diagnostic).not.toContain('secret')
    expect(diagnostic).not.toContain('signature')
    expect(diagnostic).not.toContain('/Users/')

    stdout.length = 0
    stderr.length = 0
    workspace.addJsonl.mockImplementationOnce(async (source: AsyncIterable<Uint8Array>) => {
      for await (const _chunk of source) {
        // Consume the source so createReadStream reports its native ENOENT.
      }
      return {}
    })
    expect(await run(['dataset', 'ingest', '/Users/alice/private/missing.jsonl'])).not.toBe(EXIT.ok)
    const missingFileDiagnostic = new TextDecoder().decode(joinBytes(stderr))
    expect(missingFileDiagnostic).not.toContain('/Users/')
    expect(missingFileDiagnostic).not.toContain('missing.jsonl')
  })

  test('ref move requires CAS intent and --use-current reads before moving', async () => {
    const workspace = fakeWorkspace()
    injectWorkspace(workspace)

    expect(await run(['ref', 'move', 'main', NEXT_VERSION])).toBe(EXIT.badInput)
    expect(workspace.putRef).not.toHaveBeenCalled()

    stderr.length = 0
    expect(await run(['ref', 'move', 'main', NEXT_VERSION, '--use-current', '--compact'])).toBe(
      EXIT.ok,
    )
    expect(workspace.getRef.mock.invocationCallOrder[0]).toBeLessThan(
      workspace.putRef.mock.invocationCallOrder[0] as number,
    )
    expect(workspace.putRef).toHaveBeenCalledWith(
      'main',
      { new_version: NEXT_VERSION, expected_version: VERSION, message: null },
      { signal: expect.any(AbortSignal) },
    )
  })
})

describe('export transport', () => {
  test('writes mode 0600 in the destination directory and removes failed temp files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'databench-v2-cli-'))
    try {
      const target = join(directory, 'export.jsonl')
      const controller = new AbortController()
      await writeCliFileAtomically(target, byteSource(['first\n', 'second\n']), controller.signal)
      expect(await readFile(target, 'utf8')).toBe('first\nsecond\n')
      expect((await stat(target)).mode & 0o777).toBe(0o600)

      const failedTarget = join(directory, 'failed.jsonl')
      await expect(
        writeCliFileAtomically(failedTarget, failingByteSource(), controller.signal),
      ).rejects.toThrow('fixture stream failure')

      const cancelledTarget = join(directory, 'cancelled.jsonl')
      const cancelled = new AbortController()
      cancelled.abort(new DOMException('fixture cancellation', 'AbortError'))
      await expect(
        writeCliFileAtomically(cancelledTarget, byteSource(['unreachable']), cancelled.signal),
      ).rejects.toThrow('fixture cancellation')

      const cleanupFailedTarget = join(directory, 'cleanup-failed.jsonl')
      let cleanupFailure: unknown
      try {
        await writeCliFileAtomically(
          cleanupFailedTarget,
          cleanupSabotageSource(directory),
          controller.signal,
        )
      } catch (error) {
        cleanupFailure = error
      }
      expect(cleanupFailure).toBeInstanceOf(Error)
      expect((cleanupFailure as { cliCleanupFailed?: unknown }).cliCleanupFailed).toBe(true)
      expect((cleanupFailure as { suppressed?: unknown }).suppressed).toBeInstanceOf(Error)
      const sabotagedTemp = (await readdir(directory)).find((name) =>
        name.startsWith('.cleanup-failed.jsonl.databench-'),
      )
      expect(sabotagedTemp).toBeDefined()
      if (sabotagedTemp !== undefined) {
        await rm(join(directory, sabotagedTemp), { force: true, recursive: true })
      }
      expect(await readdir(directory)).toEqual(['export.jsonl'])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('rejects binary TTY output before consuming bytes', async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    let consumed = false
    try {
      await expect(
        writeCliStdout(
          (async function* () {
            consumed = true
            yield new Uint8Array([0])
          })(),
          'application/octet-stream',
          operation(),
        ),
      ).rejects.toThrow('refusing to write binary export data to a TTY')
      expect(consumed).toBe(false)
    } finally {
      if (previousDescriptor === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
      else Object.defineProperty(process.stdout, 'isTTY', previousDescriptor)
    }
  })

  test('propagates a broken stdout pipe into operation cancellation', async () => {
    const controller = new AbortController()
    vi.mocked(process.stdout.write).mockImplementationOnce(() => {
      const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
      process.stdout.emit('error', error)
      return false
    })
    await expect(
      writeCliStdout(byteSource(['payload']), 'application/x-ndjson', {
        signal: controller.signal,
        abort: (reason) => controller.abort(reason),
      }),
    ).rejects.toThrow()
    expect(controller.signal.aborted).toBe(true)
  })
})

function fakeWorkspace(options: { plan?: ExportPlanV2 } = {}) {
  const plan = options.plan ?? exportPlan(false)
  return {
    describeDataset: vi.fn(async () => ({ dataset_version: VERSION })),
    getRecordPage: vi.fn(async () => ({ dataset_version: VERSION, items: [] })),
    audit: vi.fn(async () => ({ dataset_version: VERSION })),
    inspectExport: vi.fn(async () => plan),
    export: vi.fn(async () => ({ plan, bytes: byteSource(['{"ok":true}\n']) })),
    listConverters: vi.fn(() => []),
    getConverter: vi.fn(() => null),
    listTransforms: vi.fn(() => []),
    runTransform: vi.fn(async () => ({})),
    listRefs: vi.fn(async () => ({ items: [], next_cursor: null })),
    getRef: vi.fn(async () => ({ name: 'main', version: VERSION, message: null })),
    putRef: vi.fn(async () => ({ name: 'main', version: NEXT_VERSION, message: null })),
    lineage: vi.fn(async () => ({})),
    addJsonl: vi.fn(async () => ({})),
  }
}

function injectWorkspace(workspace: ReturnType<typeof fakeWorkspace>): void {
  setWorkspaceForTest(workspace as unknown as V2Workspace)
}

function exportPlan(semantic: boolean): ExportPlanV2 {
  return createExportPlanV2({
    export_fidelity_profile: 'databench-export-fidelity-1',
    dataset_version: VERSION,
    converter: 'canonical-jsonl',
    converter_version: '1.0.0',
    normalized_options: {},
    media_type: 'application/x-ndjson',
    suggested_filename: 'canonical.jsonl',
    output_count: 1,
    config_hints: {},
    fidelity: {
      preserved: ['/contents'],
      changes: semantic
        ? [
            {
              path: '/extra',
              action: 'dropped',
              impact: 'semantic',
              reason: 'fixture_semantic_loss',
            },
          ]
        : [],
    },
  })
}

async function* byteSource(parts: readonly string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part)
}

async function* failingByteSource(): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode('partial')
  throw new Error('fixture stream failure')
}

async function* cleanupSabotageSource(directory: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode('partial')
  const temporary = (await readdir(directory)).find((name) =>
    name.startsWith('.cleanup-failed.jsonl.databench-'),
  )
  if (temporary === undefined) throw new Error('fixture temporary file was not created')
  const temporaryPath = join(directory, temporary)
  await rm(temporaryPath, { force: true })
  await mkdir(temporaryPath)
  await writeFile(join(temporaryPath, 'prevent-nonrecursive-remove'), 'fixture')
  throw new Error('fixture primary export failure')
}

function operation() {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
  }
}

function outputJson<T = unknown>(): T {
  return JSON.parse(new TextDecoder().decode(joinBytes(stdout))) as T
}

function outputError(): { code: string } {
  return (JSON.parse(new TextDecoder().decode(joinBytes(stderr))) as { error: { code: string } })
    .error
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const joined = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}
