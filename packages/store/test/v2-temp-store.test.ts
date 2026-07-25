import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, parse } from 'node:path'
import { CapacityExceededError, type IntegrityError } from '@databench/schema'
import { afterEach, describe, expect, test } from 'vitest'
import { V2_TEMP_OWNER_MARKER, V2TempStore } from '../src/v2/temp-store.js'

const cleanupRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...cleanupRoots].map((path) => rm(path, { force: true, recursive: true })))
  cleanupRoots.clear()
})

describe('V2TempStore root and ownership safety', () => {
  test('requires an absolute path that is not the filesystem root', () => {
    expect(() => new V2TempStore({ tempRoot: 'relative/temp' })).toThrow(TypeError)
    expect(() => new V2TempStore({ tempRoot: parse(process.cwd()).root })).toThrow(TypeError)
    expect(() => new V2TempStore({ tempRoot: '' })).toThrow(TypeError)
  })

  test('pins root, owner marker and artifact permissions to 0700/0600', async () => {
    const { root } = await tempRoot()
    await mkdir(root, { mode: 0o777 })
    await chmod(root, 0o777)
    const store = new V2TempStore({ tempRoot: root })

    await store.initialize()
    expect(permissionBits((await lstat(root)).mode)).toBe(0o700)

    const markerPath = join(root, '.databench-v2-owner')
    const marker = await lstat(markerPath)
    expect(marker.isFile()).toBe(true)
    expect(marker.isSymbolicLink()).toBe(false)
    expect(permissionBits(marker.mode)).toBe(0o600)
    expect(await readFile(markerPath, 'utf8')).toBe(V2_TEMP_OWNER_MARKER)

    const file = await store.create('prepare')
    try {
      const stats = await file.handle.stat()
      expect(stats.isFile()).toBe(true)
      expect(permissionBits(stats.mode)).toBe(0o600)
      expect(file.path.startsWith(`${root}/databench-v2-prepare-`)).toBe(true)
    } finally {
      await store.remove(file)
    }
    const draft = await store.create('draft-output')
    try {
      expect(permissionBits((await draft.handle.stat()).mode)).toBe(0o600)
      expect(draft.path.startsWith(`${root}/databench-v2-draft-output-`)).toBe(true)
      expect(draft.path.endsWith('.jsonl')).toBe(true)
    } finally {
      await store.remove(draft)
    }
  })

  test('allows two store instances to initialize the same root concurrently', async () => {
    const { root } = await tempRoot()
    const first = new V2TempStore({ tempRoot: root })
    const second = new V2TempStore({ tempRoot: root })

    await Promise.all([first.initialize(), second.initialize()])
    await Promise.all([first.initialize(), second.initialize()])

    expect(await readFile(join(root, '.databench-v2-owner'), 'utf8')).toBe(V2_TEMP_OWNER_MARKER)
    expect((await readdir(root)).filter((name) => name.startsWith('.databench-v2-owner-'))).toEqual(
      [],
    )
  })

  test('refuses to unlink a replacement at an owned temporary pathname', async () => {
    const { root } = await tempRoot()
    const store = new V2TempStore({ tempRoot: root })
    const file = await store.create('prepare')
    const original = `${file.path}.original`
    await rename(file.path, original)
    await writeFile(file.path, 'replacement')

    await expect(store.remove(file)).rejects.toMatchObject({
      name: 'IntegrityError',
      detail: { reason: 'temp_file_replaced' },
    })
    expect(await readFile(file.path, 'utf8')).toBe('replacement')

    await unlink(file.path)
    await rename(original, file.path)
    await store.remove(file)
  })

  test('rejects an owner marker symlink', async () => {
    const { parent, root } = await tempRoot()
    await mkdir(root)
    const target = join(parent, 'marker-target')
    await writeFile(target, V2_TEMP_OWNER_MARKER, { mode: 0o600 })
    await symlink(target, join(root, '.databench-v2-owner'))

    await expect(new V2TempStore({ tempRoot: root }).initialize()).rejects.toBeInstanceOf(Error)
    expect((await lstat(join(root, '.databench-v2-owner'))).isSymbolicLink()).toBe(true)
  })

  test('rejects an owner marker with the wrong contents', async () => {
    const { root } = await tempRoot()
    await mkdir(root)
    await writeFile(join(root, '.databench-v2-owner'), 'not-owned-by-databench\n', {
      mode: 0o600,
    })

    await expect(new V2TempStore({ tempRoot: root }).initialize()).rejects.toMatchObject({
      name: 'IntegrityError',
      detail: { reason: 'temp_owner_marker_mismatch' },
    } satisfies Partial<IntegrityError>)
  })

  test('cleans only stale regular files with owned prefixes', async () => {
    const { root } = await tempRoot()
    await new V2TempStore({ tempRoot: root }).initialize()

    const stalePrepare = join(
      root,
      'databench-v2-prepare-00000000-0000-4000-8000-000000000001.parquet',
    )
    const staleRead = join(root, 'databench-v2-read-00000000-0000-4000-8000-000000000002.parquet')
    const staleCandidate = join(
      root,
      '.databench-v2-owner-00000000-0000-4000-8000-000000000003.tmp',
    )
    const staleDraftRaw = join(
      root,
      'databench-v2-draft-raw-00000000-0000-4000-8000-000000000007.jsonl',
    )
    const staleDraftOutput = join(
      root,
      'databench-v2-draft-output-00000000-0000-4000-8000-000000000008.jsonl',
    )
    const recentOwned = join(root, 'databench-v2-read-00000000-0000-4000-8000-000000000004.parquet')
    const unrelated = join(root, 'unrelated.txt')
    const lookalike = join(root, 'databench-v2-prepare-not-a-uuid.parquet')
    const matchingDirectory = join(
      root,
      'databench-v2-read-00000000-0000-4000-8000-000000000005.parquet',
    )
    const matchingSymlink = join(
      root,
      'databench-v2-read-00000000-0000-4000-8000-000000000006.parquet',
    )

    await Promise.all([
      writeFile(stalePrepare, 'stale'),
      writeFile(staleRead, 'stale'),
      writeFile(staleCandidate, 'stale'),
      writeFile(staleDraftRaw, 'stale'),
      writeFile(staleDraftOutput, 'stale'),
      writeFile(recentOwned, 'recent'),
      writeFile(unrelated, 'keep'),
      writeFile(lookalike, 'keep'),
      mkdir(matchingDirectory),
      symlink(unrelated, matchingSymlink),
    ])
    const old = new Date(Date.now() - 60_000)
    await Promise.all([
      utimes(stalePrepare, old, old),
      utimes(staleRead, old, old),
      utimes(staleCandidate, old, old),
      utimes(staleDraftRaw, old, old),
      utimes(staleDraftOutput, old, old),
    ])

    await new V2TempStore({ tempRoot: root, staleAgeMs: 1_000 }).initialize()

    expect((await readdir(root)).sort()).toEqual(
      [
        '.databench-v2-owner',
        basename(recentOwned),
        basename(unrelated),
        basename(lookalike),
        basename(matchingDirectory),
        basename(matchingSymlink),
      ].sort(),
    )
  })
})

describe('V2TempStore cancellation and admission', () => {
  test('does not leave a file when create is already aborted', async () => {
    const { root } = await tempRoot()
    const store = new V2TempStore({ tempRoot: root })
    await store.initialize()
    const controller = new AbortController()
    controller.abort('stop')

    await expect(store.create('read', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    })
    expect(await parquetEntries(root)).toEqual([])
  })

  test('closes and unlinks a file when aborted after it has been created', async () => {
    const { root } = await tempRoot()
    const store = new V2TempStore({ tempRoot: root })
    await store.initialize()
    const probePath = join(root, '.file-handle-probe')
    const probe = await open(probePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR)
    const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype
    await probe.close()
    await unlink(probePath)

    const originalChmod = prototype.chmod
    const reachedPostOpen = deferred<void>()
    const continueChmod = deferred<void>()
    prototype.chmod = async function (this: FileHandle, mode: number): Promise<void> {
      await originalChmod.call(this, mode)
      reachedPostOpen.resolve()
      await continueChmod.promise
    }

    const controller = new AbortController()
    try {
      const pending = store.create('prepare', controller.signal)
      await reachedPostOpen.promise
      controller.abort('stop')
      continueChmod.resolve()

      await expect(pending).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ABORT_ERR',
      })
      expect(await parquetEntries(root)).toEqual([])
    } finally {
      continueChmod.resolve()
      prototype.chmod = originalChmod
    }
  })

  test('enforces aggregate capacity and makes reservation release idempotent', async () => {
    const { root } = await tempRoot()
    const store = new V2TempStore({ tempRoot: root, safetyMarginBytes: 0 })
    await store.initialize()
    const stats = await statfs(root, { bigint: true })
    const available = stats.bavail * stats.bsize
    const requestedBigInt = (available * 3n) / 5n
    expect(requestedBigInt).toBeGreaterThan(0n)
    expect(requestedBigInt).toBeLessThanOrEqual(BigInt(Number.MAX_SAFE_INTEGER))
    const requested = Number(requestedBigInt)

    const first = await store.reserve(requested)
    expect(first.bytes).toBe(requested)
    await expect(store.reserve(requested)).rejects.toBeInstanceOf(CapacityExceededError)

    first.release()
    first.release()
    const second = await store.reserve(requested)
    await expect(store.reserve(requested)).rejects.toBeInstanceOf(CapacityExceededError)
    second.release()
  })

  test('resizes reservations atomically and preserves the prior size on failed growth', async () => {
    const { root } = await tempRoot()
    const store = new V2TempStore({ tempRoot: root, safetyMarginBytes: 0 })
    await store.initialize()
    const stats = await statfs(root, { bigint: true })
    const available = stats.bavail * stats.bsize
    const requested = Number(available / 2n)
    const first = await store.reserve(requested)

    await first.resize(Math.floor(requested / 4))
    expect(first.bytes).toBe(Math.floor(requested / 4))
    const second = await store.reserve(requested)
    await expect(first.resize(requested + Math.floor(requested / 2))).rejects.toBeInstanceOf(
      CapacityExceededError,
    )
    expect(first.bytes).toBe(Math.floor(requested / 4))

    first.release()
    second.release()
    await expect(first.resize(1)).rejects.toThrow(/released/)

    const racing = await store.reserve(1)
    const resizeAfterRelease = racing.resize(2)
    racing.release()
    await expect(resizeAfterRelease).rejects.toThrow(/released/)
  })
})

interface FileHandlePrototype {
  chmod(this: FileHandle, mode: number): Promise<void>
}

function permissionBits(mode: number): number {
  return mode & 0o777
}

async function tempRoot(): Promise<{ readonly parent: string; readonly root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'databench-v2-temp-test-'))
  cleanupRoots.add(parent)
  return { parent, root: join(parent, 'root') }
}

async function parquetEntries(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.endsWith('.parquet')).sort()
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value?: T): void
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  }
}
