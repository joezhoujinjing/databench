import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { V2Dataset } from '@databench/engine'
import {
  ConflictError,
  canonicalDatasetManifestV2Bytes,
  createDatasetManifestV2,
  type DatasetLayoutIdentityV2,
  IntegrityError,
  ManifestIntegrityErrorV2,
} from '@databench/schema'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  type ConditionalCreateInput,
  type ConditionalCreateResult,
  type ConditionalObjectStoreV2,
  FileBackedV2Store,
  LayoutConflictErrorV2,
  type ObjectDownloadInputV2,
  type ObjectHeadV2,
  ObjectStoreFailureErrorV2,
  type PreparedArtifactV2,
  type V2OperationContext,
  v2ObjectKeys,
} from '../src/index.js'

type ObjectKind = 'artifact' | 'manifest'
type CreateStep = 'ambiguous_absent' | 'ambiguous_created' | 'failure' | 'already_exists'

interface ConditionalCommitFixtureCase {
  readonly id: string
  readonly preload: boolean
  readonly artifact_steps: CreateStep[]
  readonly manifest_steps: CreateStep[]
  readonly outcome: 'committed' | 'failure'
  readonly artifact_create_calls: number
  readonly manifest_create_calls: number
}

const conditionalCommitFixture = JSON.parse(
  readFileSync(
    new URL('./golden/fixtures/v2/store-conditional-commit-states.fixture.json', import.meta.url),
    'utf8',
  ),
) as { readonly cases: ConditionalCommitFixtureCase[] }

interface CreateCall {
  readonly key: string
  readonly kind: ObjectKind
}

class MemoryConditionalObjectStore implements ConditionalObjectStoreV2 {
  readonly objects = new Map<string, Buffer>()
  readonly createCalls: CreateCall[] = []
  readonly headCalls: string[] = []
  readonly downloadCalls: string[] = []
  readonly #steps: Record<ObjectKind, CreateStep[]> = { artifact: [], manifest: [] }
  beforeDownload: ((input: ObjectDownloadInputV2) => Promise<void>) | null = null
  overrideCreate:
    | ((input: ConditionalCreateInput, kind: ObjectKind) => Promise<ConditionalCreateResult | null>)
    | null = null
  pingCalls = 0

  enqueue(kind: ObjectKind, ...steps: CreateStep[]): void {
    this.#steps[kind].push(...steps)
  }

  putObject(key: string, bytes: Uint8Array): void {
    this.objects.set(key, Buffer.from(bytes))
  }

  object(key: string): Buffer | undefined {
    const value = this.objects.get(key)
    return value === undefined ? undefined : Buffer.from(value)
  }

  countCreates(kind: ObjectKind): number {
    return this.createCalls.filter((call) => call.kind === kind).length
  }

  async conditionalCreate(input: ConditionalCreateInput): Promise<ConditionalCreateResult> {
    input.signal?.throwIfAborted()
    const kind = objectKind(input.key)
    this.createCalls.push({ key: input.key, kind })
    const overridden = await this.overrideCreate?.(input, kind)
    if (overridden) return overridden
    const step = this.#steps[kind].shift()

    if (step === 'failure') {
      return { status: 'failure', error: new Error(`injected ${kind} failure`) }
    }
    if (step === 'already_exists') return { status: 'already_exists' }
    if (step === 'ambiguous_absent') {
      return { status: 'ambiguous', error: new Error(`ambiguous absent ${kind}`) }
    }
    if (step === 'ambiguous_created') {
      if (!this.objects.has(input.key)) {
        this.objects.set(input.key, await readCreateBody(input))
      }
      return { status: 'ambiguous', error: new Error(`ambiguous created ${kind}`) }
    }

    if (this.objects.has(input.key)) return { status: 'already_exists' }
    this.objects.set(input.key, await readCreateBody(input))
    return { status: 'created' }
  }

  async head(
    key: string,
    context: V2OperationContext = {},
  ): Promise<Readonly<ObjectHeadV2> | null> {
    context.signal?.throwIfAborted()
    this.headCalls.push(key)
    const bytes = this.objects.get(key)
    return bytes === undefined ? null : Object.freeze({ size: bytes.byteLength })
  }

  async download(input: ObjectDownloadInputV2): Promise<'downloaded' | 'not_found'> {
    input.signal?.throwIfAborted()
    this.downloadCalls.push(input.key)
    const bytes = this.objects.get(input.key)
    if (bytes === undefined) return 'not_found'
    await this.beforeDownload?.(input)
    input.signal?.throwIfAborted()
    await pipeline(ReadableFromBuffer(bytes), input.destination, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    return 'downloaded'
  }

  async ping(context: V2OperationContext = {}): Promise<void> {
    context.signal?.throwIfAborted()
    this.pingCalls += 1
  }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('FileBackedV2Store lifecycle', () => {
  test('prepares, conditionally commits, reads, audits, pings, and discards one immutable layout', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store, tempRoot } = await createHarness(backend)
    const dataset = makeDataset()
    const prepared = await store.prepare(dataset)
    const keys = v2ObjectKeys(prepared.identity)

    expect(await store.exists(prepared.identity)).toBe(false)
    expect(prepared.identity.dataset_version).toBe(dataset.version)
    expect(prepared.identity.num_records).toBe(dataset.length)
    expect(prepared.manifest).toEqual(createDatasetManifestV2(prepared.identity))

    const manifest = await store.commit(prepared)
    expect(manifest).toEqual(prepared.manifest)
    expect(backend.createCalls.map((call) => call.key)).toEqual([keys.artifact, keys.manifest])
    expect(await store.exists(prepared.identity)).toBe(true)

    const loaded = await store.read(prepared.identity)
    expect(loaded.identity).toEqual(dataset.identity)
    expect([...loaded.records()].map((record) => record.record_json)).toEqual(
      [...dataset.records()].map((record) => record.record_json),
    )
    await expect(store.audit(prepared.identity)).resolves.toEqual({
      ok: true,
      identity: prepared.identity,
      manifest: prepared.manifest,
    })
    await store.ping()
    expect(backend.pingCalls).toBe(1)

    await store.discard(prepared)
    await store.discard(prepared)
    expect(await parquetTempEntries(tempRoot)).toEqual([])
  })

  test('rejects forged, cross-Store, discarded, and concurrent prepared-handle states', async () => {
    const backend = new MemoryConditionalObjectStore()
    const first = await createHarness(backend)
    const second = await createHarness(backend)
    const prepared = await first.store.prepare(makeDataset())
    const forged = {
      identity: prepared.identity,
      manifest: prepared.manifest,
    } as PreparedArtifactV2

    await expect(first.store.commit(forged)).rejects.toBeInstanceOf(TypeError)
    await expect(first.store.discard(forged)).rejects.toBeInstanceOf(TypeError)
    await expect(second.store.commit(prepared)).rejects.toBeInstanceOf(TypeError)
    await expect(second.store.discard(prepared)).rejects.toBeInstanceOf(TypeError)

    const firstCommit = first.store.commit(prepared)
    await expect(first.store.commit(prepared)).rejects.toBeInstanceOf(ConflictError)
    await firstCommit

    const createCount = backend.createCalls.length
    await expect(first.store.commit(prepared)).resolves.toEqual(prepared.manifest)
    expect(backend.createCalls).toHaveLength(createCount)

    await first.store.discard(prepared)
    await expect(first.store.commit(prepared)).rejects.toBeInstanceOf(ConflictError)
  })

  test('recovers an artifact-only crash without replacing the existing artifact', async () => {
    const backend = new MemoryConditionalObjectStore()
    backend.enqueue('manifest', 'failure')
    const { store } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())
    const keys = v2ObjectKeys(prepared.identity)

    await expect(store.commit(prepared)).rejects.toBeInstanceOf(ObjectStoreFailureErrorV2)
    expect(backend.object(keys.artifact)).toBeDefined()
    expect(backend.object(keys.manifest)).toBeUndefined()

    await expect(store.commit(prepared)).resolves.toEqual(prepared.manifest)
    expect(backend.countCreates('artifact')).toBe(2)
    expect(backend.countCreates('manifest')).toBe(2)
    expect(backend.downloadCalls).toContain(keys.artifact)
    await store.discard(prepared)
  })

  test('allows two admitted cold downloads to run before serializing eager decode', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store } = await createHarness(backend, { readConcurrency: 2 })
    const prepared = await store.prepare(makeDataset())
    const artifactKey = v2ObjectKeys(prepared.identity).artifact
    await store.commit(prepared)
    await store.discard(prepared)

    const firstEntered = deferred<void>()
    const releaseDownloads = deferred<void>()
    let enteredDownloads = 0
    backend.beforeDownload = async (input) => {
      if (input.key !== artifactKey) return
      enteredDownloads += 1
      firstEntered.resolve()
      if (enteredDownloads === 2) releaseDownloads.resolve()
      await releaseDownloads.promise
    }

    const reads = [store.read(prepared.identity), store.read(prepared.identity)] as const
    try {
      await firstEntered.promise
      await vi.waitFor(() => expect(enteredDownloads).toBe(2), {
        interval: 10,
        timeout: 500,
      })
    } finally {
      releaseDownloads.resolve()
      await Promise.allSettled(reads)
    }
  })
})

describe('FileBackedV2Store conditional-create recovery', () => {
  test.each(conditionalCommitFixture.cases)('matches the fixed $id transition', async (fixture) => {
    const backend = new MemoryConditionalObjectStore()
    if (fixture.preload) {
      const initial = await createHarness(backend)
      const initialPrepared = await initial.store.prepare(makeDataset())
      await initial.store.commit(initialPrepared)
      await initial.store.discard(initialPrepared)
      backend.createCalls.splice(0)
    }
    backend.enqueue('artifact', ...fixture.artifact_steps)
    backend.enqueue('manifest', ...fixture.manifest_steps)
    const { store } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())

    if (fixture.outcome === 'committed') {
      await expect(store.commit(prepared)).resolves.toEqual(prepared.manifest)
    } else {
      await expect(store.commit(prepared)).rejects.toBeInstanceOf(ObjectStoreFailureErrorV2)
    }
    expect(backend.countCreates('artifact')).toBe(fixture.artifact_create_calls)
    expect(backend.countCreates('manifest')).toBe(fixture.manifest_create_calls)
    await store.discard(prepared)
  })

  test('probes an ambiguous success and retries an ambiguous absence exactly once', async () => {
    const backend = new MemoryConditionalObjectStore()
    backend.enqueue('artifact', 'ambiguous_absent')
    backend.enqueue('manifest', 'ambiguous_created')
    const { store } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())

    await expect(store.commit(prepared)).resolves.toEqual(prepared.manifest)
    expect(backend.countCreates('artifact')).toBe(2)
    expect(backend.countCreates('manifest')).toBe(1)
    await store.discard(prepared)
  })

  test('fails closed after one retry when conditional creation remains ambiguous', async () => {
    const backend = new MemoryConditionalObjectStore()
    backend.enqueue('artifact', 'ambiguous_absent', 'ambiguous_absent')
    const { store } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())

    await expect(store.commit(prepared)).rejects.toBeInstanceOf(ObjectStoreFailureErrorV2)
    expect(backend.countCreates('artifact')).toBe(2)
    expect(backend.countCreates('manifest')).toBe(0)
    await store.discard(prepared)
  })

  test('destroys an upload body that a conditional provider returns without consuming', async () => {
    const backend = new MemoryConditionalObjectStore()
    const first = await createHarness(backend)
    const firstPrepared = await first.store.prepare(makeDataset())
    await first.store.commit(firstPrepared)
    await first.store.discard(firstPrepared)

    const second = await createHarness(backend)
    const secondPrepared = await second.store.prepare(makeDataset())
    let unconsumedBody: Readable | undefined
    backend.overrideCreate = async (input, kind) => {
      if (kind !== 'artifact') return null
      unconsumedBody = input.body()
      return { status: 'already_exists' }
    }

    await expect(second.store.commit(secondPrepared)).resolves.toEqual(secondPrepared.manifest)
    expect(unconsumedBody).toBeDefined()
    expect(unconsumedBody?.destroyed).toBe(true)
    await second.store.discard(secondPrepared)
  })

  test('probes a caller-aborted ambiguous manifest without reusing the aborted signal', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())
    const controller = new AbortController()
    backend.overrideCreate = async (input, kind) => {
      if (kind !== 'manifest') return null
      backend.putObject(input.key, await readCreateBody(input))
      controller.abort()
      controller.signal.throwIfAborted()
      return null
    }

    await expect(store.commit(prepared, { signal: controller.signal })).resolves.toEqual(
      prepared.manifest,
    )
    expect(backend.countCreates('artifact')).toBe(1)
    expect(backend.countCreates('manifest')).toBe(1)
    await store.discard(prepared)
  })
})

describe('FileBackedV2Store integrity boundaries', () => {
  test('reports a different canonical manifest at the fixed commit point as a layout conflict', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())
    const keys = v2ObjectKeys(prepared.identity)
    const conflictingIdentity: DatasetLayoutIdentityV2 = {
      ...prepared.identity,
      artifact_digest: 'f'.repeat(64),
    }
    backend.putObject(
      keys.manifest,
      canonicalDatasetManifestV2Bytes(createDatasetManifestV2(conflictingIdentity)),
    )

    await expect(store.commit(prepared)).rejects.toBeInstanceOf(LayoutConflictErrorV2)
    expect(backend.object(keys.manifest)).toEqual(
      Buffer.from(canonicalDatasetManifestV2Bytes(createDatasetManifestV2(conflictingIdentity))),
    )
    await store.discard(prepared)
  })

  test('rejects noncanonical committed manifest bytes as integrity corruption', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())
    const keys = v2ObjectKeys(prepared.identity)
    const canonical = canonicalDatasetManifestV2Bytes(prepared.manifest)
    backend.putObject(keys.manifest, Buffer.concat([canonical, Buffer.from('\n')]))

    await expect(store.read(prepared.identity)).rejects.toBeInstanceOf(ManifestIntegrityErrorV2)
    await expect(store.exists(prepared.identity)).rejects.toBeInstanceOf(ManifestIntegrityErrorV2)
    await store.discard(prepared)
  })

  test('detects same-size artifact corruption before decode while exists remains a shallow probe', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())
    const keys = v2ObjectKeys(prepared.identity)
    await store.commit(prepared)
    await store.discard(prepared)

    const corrupted = backend.object(keys.artifact)
    if (!corrupted || corrupted.byteLength < 8)
      throw new Error('Expected a non-empty Parquet object')
    corrupted[4] = (corrupted[4] ?? 0) ^ 0xff
    backend.putObject(keys.artifact, corrupted)

    await expect(store.exists(prepared.identity)).resolves.toBe(true)
    await expect(store.read(prepared.identity)).rejects.toBeInstanceOf(IntegrityError)
    await expect(store.audit(prepared.identity)).rejects.toBeInstanceOf(IntegrityError)
  })

  test('fails cleanly when an artifact grows after HEAD without leaking a nested stream error', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store, tempRoot } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())
    const artifactKey = v2ObjectKeys(prepared.identity).artifact
    await store.commit(prepared)
    await store.discard(prepared)

    backend.beforeDownload = async (input) => {
      if (input.key !== artifactKey) return
      await new Promise<void>((resolve, reject) => {
        input.destination.write(Buffer.from([0]), (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }

    await expect(store.read(prepared.identity)).rejects.toBeInstanceOf(IntegrityError)
    expect(await parquetTempEntries(tempRoot)).toEqual([])
  })

  test('rejects bytes changed only during upload and never commits their manifest', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store, tempRoot } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())
    const keys = v2ObjectKeys(prepared.identity)
    backend.overrideCreate = async (input, kind) => {
      if (kind !== 'artifact') return null
      const [entry] = await parquetTempEntries(tempRoot)
      if (!entry) throw new Error('Expected the prepared Parquet temp file')
      const path = join(tempRoot, entry)
      const original = await readFile(path)
      const changed = Buffer.from(original)
      changed[4] = (changed[4] ?? 0) ^ 0xff
      await writeFile(path, changed)
      try {
        backend.putObject(input.key, await readCreateBody(input))
      } finally {
        await writeFile(path, original)
      }
      return { status: 'created' }
    }

    try {
      await expect(store.commit(prepared)).rejects.toBeInstanceOf(IntegrityError)
      expect(backend.object(keys.manifest)).toBeUndefined()
    } finally {
      await store.discard(prepared)
    }
  })
})

describe('FileBackedV2Store cancellation cleanup', () => {
  test('removes a cold-read temp file when cancellation interrupts the artifact download', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store, tempRoot } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())
    const artifactKey = v2ObjectKeys(prepared.identity).artifact
    await store.commit(prepared)
    await store.discard(prepared)

    const entered = deferred<void>()
    backend.beforeDownload = async (input) => {
      if (input.key !== artifactKey) return
      entered.resolve()
      await waitUntilAborted(input.signal)
    }
    const controller = new AbortController()
    const read = store.read(prepared.identity, { signal: controller.signal })
    await entered.promise
    controller.abort()

    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(await parquetTempEntries(tempRoot)).toEqual([])
  })

  test('requires a fresh cleanup signal and then removes the prepared file idempotently', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store, tempRoot } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())
    const controller = new AbortController()
    controller.abort()

    await expect(store.discard(prepared, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(await parquetTempEntries(tempRoot)).toHaveLength(1)

    await store.discard(prepared)
    await store.discard(prepared)
    expect(await parquetTempEntries(tempRoot)).toEqual([])
  })

  test('retries local cleanup after a transient unlink failure', async () => {
    const backend = new MemoryConditionalObjectStore()
    const { store, tempRoot } = await createHarness(backend)
    const prepared = await store.prepare(makeDataset())

    await chmod(tempRoot, 0o500)
    try {
      await expect(store.discard(prepared)).rejects.toBeDefined()
    } finally {
      await chmod(tempRoot, 0o700)
    }
    expect(await parquetTempEntries(tempRoot)).toHaveLength(1)

    await store.discard(prepared)
    await store.discard(prepared)
    expect(await parquetTempEntries(tempRoot)).toEqual([])
  })
})

async function createHarness(
  backend: MemoryConditionalObjectStore,
  options: { readonly readConcurrency?: number } = {},
): Promise<{ readonly store: FileBackedV2Store; readonly tempRoot: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'databench-v2-store-test-'))
  temporaryDirectories.push(parent)
  const tempRoot = join(parent, 'store-temp')
  return {
    store: new FileBackedV2Store({
      objectStore: backend,
      tempRoot,
      safetyMarginBytes: 0,
      prepareConcurrency: 1,
      readConcurrency: options.readConcurrency ?? 1,
    }),
    tempRoot,
  }
}

function makeDataset(): V2Dataset {
  return V2Dataset.fromRecords([
    {
      schema_version: '2.0.0',
      id: `rec_${'a'.repeat(64)}`,
      system_instruction: null,
      contents: [],
      candidates: [],
      preference_relations: [],
      tools: [],
      verification: null,
      source: null,
      lang: null,
      lineage: null,
      tags: ['store-test'],
      extra: { fixture: 'memory-conditional-store' },
    },
  ])
}

async function readCreateBody(input: ConditionalCreateInput): Promise<Buffer> {
  const stream = input.body()
  const chunks: Buffer[] = []
  try {
    for await (const chunk of stream) {
      input.signal?.throwIfAborted()
      chunks.push(Buffer.from(chunk as Buffer | Uint8Array | string))
    }
  } finally {
    stream.destroy()
  }
  const bytes = Buffer.concat(chunks)
  if (bytes.byteLength !== input.contentLength) {
    throw new Error(
      `conditional body length ${bytes.byteLength} did not match ${input.contentLength}`,
    )
  }
  return bytes
}

function objectKind(key: string): ObjectKind {
  return key.endsWith('/manifest.json') ? 'manifest' : 'artifact'
}

function ReadableFromBuffer(bytes: Uint8Array): NodeJS.ReadableStream & AsyncIterable<Uint8Array> {
  return Readable.from([Buffer.from(bytes)])
}

async function parquetTempEntries(root: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry.endsWith('.parquet')).sort()
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value)
    },
  }
}

async function waitUntilAborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) throw new Error('Expected an AbortSignal')
  if (signal.aborted) return
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  )
}
