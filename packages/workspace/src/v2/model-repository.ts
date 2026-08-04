import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { hashArtifactBytes } from '@databench/hashing'
import { type ModelSourceEvidenceV2, ModelSourceEvidenceV2Schema } from '@databench/schema'
import { z } from 'zod'

const MODEL_SCOPE_ORIGIN = 'https://www.modelscope.cn'
const MODEL_SCOPE_ADAPTER = 'modelscope'
const OPERATOR_ADAPTER = 'operator-managed'
const ADAPTER_VERSION = '1'
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_PROVIDER_BODY_BYTES = 256 * 1024
const MAX_PROVIDER_HEADER_BYTES = 16 * 1024
const MAX_PROVIDER_JSON_DEPTH = 16
const MAX_PROVIDER_JSON_NODES = 10_000
const MAX_OPERATOR_CONFIG_BYTES = 64 * 1024
const MAX_OPERATOR_METADATA_BYTES = 64 * 1024
const OPERATOR_METADATA_FILE = '.databench-model-repository.json'
const SAFE_ALIAS = /^[a-z][a-z0-9._-]{0,127}$/
const HEX_64 = /^[0-9a-f]{64}$/

export type ModelRepositoryRuntimeModeV2 = 'offline' | 'connected'

export interface ModelRepositoryReferenceV2 {
  readonly provider: 'hugging_face' | 'modelscope' | 'operator_managed'
  readonly repositoryId: string
  readonly revision: string
  readonly revisionKind: 'commit' | 'digest' | 'tag' | 'opaque'
}

export interface V2ModelRepositoryRuntime {
  readonly mode: ModelRepositoryRuntimeModeV2
  resolve(
    reference: ModelRepositoryReferenceV2,
    signal?: AbortSignal,
  ): Promise<ModelSourceEvidenceV2 | null>
}

export interface V2ModelRepositoryOpenOptions {
  readonly mode?: ModelRepositoryRuntimeModeV2
  readonly operatorConfigPath?: string
  readonly modelScopeFetch?: typeof fetch
  readonly timeoutMs?: number
  readonly clock?: () => Date
  /** Test-only race hook; production callers must not set it. */
  readonly operatorAfterOpen?: () => void | Promise<void>
}

export const DECLARED_ONLY_MODEL_REPOSITORY_RUNTIME_V2: V2ModelRepositoryRuntime = Object.freeze({
  mode: 'offline',
  async resolve() {
    return null
  },
})

const OperatorConfigSchema = z.strictObject({
  profile: z.literal('model-repository-providers-v1'),
  allowed_roots: z.array(z.string().min(1).max(4_096)).min(1).max(32),
  repositories: z
    .array(
      z.strictObject({
        alias: z.string().regex(SAFE_ALIAS),
        root: z.string().min(1).max(4_096),
      }),
    )
    .max(1_000),
})

const OperatorMetadataSchema = z.strictObject({
  profile: z.literal('operator-managed-model-repository-v1'),
  repository_id: z.string().regex(SAFE_ALIAS),
  revision: z.string().min(1).max(256),
  revision_kind: z.enum(['commit', 'digest', 'tag', 'opaque']),
  snapshot_digest: z.string().regex(HEX_64),
  license: z.string().trim().min(1).max(256).nullable(),
})

interface OperatorRepositoryEntry {
  readonly alias: string
  readonly root: string
  readonly allowedRoot: string
  readonly rootDevice: bigint
  readonly rootInode: bigint
}

export async function openModelRepositoryRuntimeV2(
  options: V2ModelRepositoryOpenOptions = {},
): Promise<V2ModelRepositoryRuntime> {
  const mode = options.mode ?? 'offline'
  if (mode !== 'offline' && mode !== 'connected') {
    throw new TypeError('Model Repository mode must be offline or connected')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new TypeError('Model Repository timeout must be between 100 and 30000 milliseconds')
  }
  const operatorRepositories =
    options.operatorConfigPath === undefined
      ? new Map<string, OperatorRepositoryEntry>()
      : await loadOperatorRepositories(options.operatorConfigPath)
  const modelScopeFetch = options.modelScopeFetch ?? globalThis.fetch
  const clock = options.clock ?? (() => new Date())

  return Object.freeze({
    mode,
    async resolve(reference: ModelRepositoryReferenceV2, signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (reference.provider === 'hugging_face') return null
      if (reference.provider === 'modelscope') {
        if (mode === 'offline') return null
        return await resolveModelScope(reference, modelScopeFetch, timeoutMs, clock, signal)
      }
      return await resolveOperatorManaged(
        reference,
        operatorRepositories,
        clock,
        options.operatorAfterOpen,
        signal,
      )
    },
  })
}

async function resolveModelScope(
  reference: ModelRepositoryReferenceV2,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  clock: () => Date,
  signal?: AbortSignal,
): Promise<ModelSourceEvidenceV2> {
  const observedAt = checkedClock(clock)
  const repositorySegments = reference.repositoryId.split('/')
  if (repositorySegments.length !== 2 || repositorySegments.some((part) => part.length === 0)) {
    return evidence({
      adapter: MODEL_SCOPE_ADAPTER,
      observedAt,
      result: 'invalid',
      cacheStatus: 'not_cached',
    })
  }
  const encodedRepository = repositorySegments.map(encodeURIComponent).join('/')
  const metadataUrl = new URL(`/api/v1/models/${encodedRepository}`, MODEL_SCOPE_ORIGIN)
  const resolutionUrl = new URL(
    `/api/v1/models/${encodedRepository}/repo/files`,
    MODEL_SCOPE_ORIGIN,
  )
  resolutionUrl.searchParams.set('Revision', reference.revision)
  resolutionUrl.searchParams.set('Recursive', 'false')

  try {
    const metadata = await fetchBoundedJson(metadataUrl, fetchImplementation, timeoutMs, signal)
    if (metadata.status === 404) {
      return evidence({
        adapter: MODEL_SCOPE_ADAPTER,
        observedAt,
        result: 'not_found',
        responseDigest: metadata.digest,
        cacheStatus: 'not_cached',
      })
    }
    if (metadata.status !== 200 || !providerSuccess(metadata.value)) {
      return evidence({
        adapter: MODEL_SCOPE_ADAPTER,
        observedAt,
        result: metadata.status >= 500 ? 'unavailable' : 'invalid',
        responseDigest: metadata.digest,
        cacheStatus: 'not_cached',
      })
    }
    const resolution = await fetchBoundedJson(resolutionUrl, fetchImplementation, timeoutMs, signal)
    const combinedDigest = hashArtifactBytes(
      new TextEncoder().encode(`${metadata.digest}\0${resolution.digest}`),
    )
    if (resolution.status === 404) {
      return evidence({
        adapter: MODEL_SCOPE_ADAPTER,
        observedAt,
        result: 'not_found',
        responseDigest: combinedDigest,
        license: providerLicense(metadata.value),
        cacheStatus: 'not_cached',
      })
    }
    if (resolution.status !== 200 || !providerSuccess(resolution.value)) {
      return evidence({
        adapter: MODEL_SCOPE_ADAPTER,
        observedAt,
        result: resolution.status >= 500 ? 'unavailable' : 'invalid',
        responseDigest: combinedDigest,
        license: providerLicense(metadata.value),
        cacheStatus: 'not_cached',
      })
    }
    return evidence({
      adapter: MODEL_SCOPE_ADAPTER,
      observedAt,
      observedRevision: observedModelScopeRevision(reference, metadata.value, resolution.value),
      result: 'verified',
      responseDigest: combinedDigest,
      license: providerLicense(metadata.value),
      cacheStatus: 'not_cached',
    })
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return evidence({
      adapter: MODEL_SCOPE_ADAPTER,
      observedAt,
      result: 'unavailable',
      cacheStatus: 'not_cached',
    })
  }
}

async function resolveOperatorManaged(
  reference: ModelRepositoryReferenceV2,
  repositories: ReadonlyMap<string, OperatorRepositoryEntry>,
  clock: () => Date,
  afterOpen: (() => void | Promise<void>) | undefined,
  signal?: AbortSignal,
): Promise<ModelSourceEvidenceV2> {
  const observedAt = checkedClock(clock)
  const entry = repositories.get(reference.repositoryId)
  if (entry === undefined) {
    return evidence({
      adapter: OPERATOR_ADAPTER,
      observedAt,
      result: 'not_found',
      cacheStatus: 'not_cached',
    })
  }
  try {
    signal?.throwIfAborted()
    await assertOperatorRootSnapshot(entry)
    const metadataPath = resolve(entry.root, OPERATOR_METADATA_FILE)
    const bytes = await readRegularFileNoFollow(
      metadataPath,
      MAX_OPERATOR_METADATA_BYTES,
      afterOpen,
    )
    signal?.throwIfAborted()
    await assertOperatorRootSnapshot(entry)
    const metadata = OperatorMetadataSchema.parse(parseBoundedJson(bytes))
    const responseDigest = hashArtifactBytes(bytes)
    if (
      metadata.repository_id !== reference.repositoryId ||
      metadata.revision_kind !== reference.revisionKind ||
      (reference.revisionKind === 'digest' &&
        reference.revision !== metadata.snapshot_digest &&
        reference.revision !== `blake3:${metadata.snapshot_digest}`)
    ) {
      return evidence({
        adapter: OPERATOR_ADAPTER,
        observedAt,
        observedRevision: metadata.revision,
        result: 'revision_mismatch',
        responseDigest,
        license: metadata.license,
        cacheStatus: 'cached',
      })
    }
    if (metadata.revision !== reference.revision) {
      return evidence({
        adapter: OPERATOR_ADAPTER,
        observedAt,
        observedRevision: metadata.revision,
        result: 'revision_mismatch',
        responseDigest,
        license: metadata.license,
        cacheStatus: 'cached',
      })
    }
    return evidence({
      adapter: OPERATOR_ADAPTER,
      observedAt,
      observedRevision: metadata.revision,
      result: 'verified',
      responseDigest,
      license: metadata.license,
      cacheStatus: 'cached',
    })
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return evidence({
      adapter: OPERATOR_ADAPTER,
      observedAt,
      result: 'invalid',
      cacheStatus: 'unknown',
    })
  }
}

async function loadOperatorRepositories(
  configPath: string,
): Promise<ReadonlyMap<string, OperatorRepositoryEntry>> {
  if (!isAbsolute(configPath)) {
    throw new TypeError('Operator-managed Model Repository config path must be absolute')
  }
  const bytes = await readBoundedFile(configPath, MAX_OPERATOR_CONFIG_BYTES)
  const config = OperatorConfigSchema.parse(parseBoundedJson(bytes))
  const allowedRoots = await Promise.all(
    config.allowed_roots.map(async (configuredRoot) => {
      if (!isAbsolute(configuredRoot)) {
        throw new TypeError('Operator-managed allowlisted roots must be absolute')
      }
      const absolute = resolve(configuredRoot)
      const configuredStatus = await lstat(absolute)
      if (configuredStatus.isSymbolicLink()) {
        throw new TypeError('Operator-managed allowlisted roots cannot be symlinks')
      }
      const canonical = await realpath(absolute)
      const status = await lstat(canonical, { bigint: true })
      if (!status.isDirectory())
        throw new TypeError('Operator-managed allowlisted root is not a directory')
      return Object.freeze({ absolute, canonical })
    }),
  )
  const entries = new Map<string, OperatorRepositoryEntry>()
  for (const configured of config.repositories) {
    if (entries.has(configured.alias)) {
      throw new TypeError('Operator-managed Model Repository aliases must be unique')
    }
    if (!isAbsolute(configured.root)) {
      throw new TypeError('Operator-managed Model Repository roots must be absolute')
    }
    const absoluteRoot = resolve(configured.root)
    const configuredAllowedRoot = allowedRoots.find((candidate) =>
      isContained(candidate.absolute, absoluteRoot),
    )
    if (configuredAllowedRoot === undefined) {
      throw new TypeError('Operator-managed Model Repository root escapes its allowlist')
    }
    await assertPathHasNoSymlinkWithin(configuredAllowedRoot.absolute, absoluteRoot)
    const canonicalRoot = await realpath(absoluteRoot)
    if (!isContained(configuredAllowedRoot.canonical, canonicalRoot)) {
      throw new TypeError('Operator-managed Model Repository root escapes its allowlist')
    }
    const rootStatus = await lstat(canonicalRoot, { bigint: true })
    if (!rootStatus.isDirectory()) {
      throw new TypeError('Operator-managed Model Repository root is not a directory')
    }
    const entry = Object.freeze({
      alias: configured.alias,
      root: canonicalRoot,
      allowedRoot: configuredAllowedRoot.canonical,
      rootDevice: rootStatus.dev,
      rootInode: rootStatus.ino,
    })
    await assertOperatorRootSnapshot(entry)
    const initialMetadataBytes = await readRegularFileNoFollow(
      resolve(canonicalRoot, OPERATOR_METADATA_FILE),
      MAX_OPERATOR_METADATA_BYTES,
    )
    const initialMetadata = OperatorMetadataSchema.parse(parseBoundedJson(initialMetadataBytes))
    if (initialMetadata.repository_id !== configured.alias) {
      throw new TypeError('Operator-managed metadata repository ID does not match its alias')
    }
    entries.set(configured.alias, entry)
  }
  return entries
}

async function assertOperatorRootSnapshot(entry: OperatorRepositoryEntry): Promise<void> {
  await assertPathHasNoSymlinkWithin(entry.allowedRoot, entry.root)
  const canonical = await realpath(entry.root)
  if (canonical !== entry.root || !isContained(entry.allowedRoot, canonical)) {
    throw new TypeError('Operator-managed Model Repository root changed identity')
  }
  const status = await lstat(canonical, { bigint: true })
  if (!status.isDirectory() || status.dev !== entry.rootDevice || status.ino !== entry.rootInode) {
    throw new TypeError('Operator-managed Model Repository root changed snapshot')
  }
}

async function readRegularFileNoFollow(
  filePath: string,
  maximumBytes: number,
  afterOpen?: () => void | Promise<void>,
  label = 'Operator-managed metadata',
): Promise<Uint8Array> {
  const pathBefore = await lstat(filePath, { bigint: true })
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular file`)
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.size > BigInt(maximumBytes)) {
      throw new TypeError(`${label} file is invalid or too large`)
    }
    await afterOpen?.()
    const bytes = await handle.readFile()
    const openedAfter = await handle.stat({ bigint: true })
    const pathAfter = await lstat(filePath, { bigint: true })
    if (
      bytes.byteLength > maximumBytes ||
      opened.dev !== openedAfter.dev ||
      opened.ino !== openedAfter.ino ||
      opened.size !== openedAfter.size ||
      opened.mtimeNs !== openedAfter.mtimeNs ||
      opened.dev !== pathBefore.dev ||
      opened.ino !== pathBefore.ino ||
      opened.dev !== pathAfter.dev ||
      opened.ino !== pathAfter.ino
    ) {
      throw new TypeError(`${label} changed during snapshot read`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function assertPathHasNoSymlinkWithin(
  rootPath: string,
  candidatePath: string,
): Promise<void> {
  const root = resolve(rootPath)
  const candidate = resolve(candidatePath)
  if (!isContained(root, candidate)) {
    throw new TypeError('Operator-managed Model Repository root escapes its allowlist')
  }
  const relation = relative(root, candidate)
  const segments = relation === '' ? [] : relation.split(sep)
  let current = root
  const rootStatus = await lstat(current)
  if (rootStatus.isSymbolicLink()) {
    throw new TypeError('Operator-managed paths cannot contain symlinks')
  }
  for (const segment of segments) {
    current = resolve(current, segment)
    const status = await lstat(current)
    if (status.isSymbolicLink())
      throw new TypeError('Operator-managed paths cannot contain symlinks')
  }
}

function isContained(allowedRoot: string, candidate: string): boolean {
  const relation = relative(allowedRoot, candidate)
  return (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  )
}

async function readBoundedFile(filePath: string, maximumBytes: number): Promise<Uint8Array> {
  return await readRegularFileNoFollow(filePath, maximumBytes, undefined, 'Operator-managed config')
}

interface BoundedProviderResponse {
  readonly status: number
  readonly value: unknown
  readonly digest: string
}

async function fetchBoundedJson(
  url: URL,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BoundedProviderResponse> {
  if (url.origin !== MODEL_SCOPE_ORIGIN || !url.pathname.startsWith('/api/v1/models/')) {
    throw new TypeError('ModelScope adapter URL escaped its exact allowlist')
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal =
    signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
  const response = await fetchImplementation(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: requestSignal,
  })
  let headerBytes = 0
  const encoder = new TextEncoder()
  for (const [name, value] of response.headers) {
    headerBytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4
  }
  if (headerBytes > MAX_PROVIDER_HEADER_BYTES)
    throw new TypeError('Provider response headers are too large')
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json' && contentType?.endsWith('+json') !== true) {
    throw new TypeError('Provider response media type must be JSON')
  }
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > MAX_PROVIDER_BODY_BYTES) {
    throw new TypeError('Provider response body is too large')
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  if (reader !== undefined) {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new TypeError('Provider response body is too large')
      }
      chunks.push(next.value)
    }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const value = parseBoundedJson(bytes)
  assertJsonShape(value)
  return { status: response.status, value, digest: hashArtifactBytes(bytes) }
}

function parseBoundedJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

function assertJsonShape(value: unknown): void {
  let nodes = 0
  const visit = (current: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_PROVIDER_JSON_NODES || depth > MAX_PROVIDER_JSON_DEPTH) {
      throw new TypeError('Provider JSON exceeds its structural bounds')
    }
    if (Array.isArray(current)) {
      for (const child of current) visit(child, depth + 1)
    } else if (current !== null && typeof current === 'object') {
      for (const child of Object.values(current)) visit(child, depth + 1)
    }
  }
  visit(value, 0)
}

function providerSuccess(value: unknown): boolean {
  const record = jsonRecord(value)
  return record?.Code === 200 && record.Success === true && jsonRecord(record.Data) !== null
}

function providerLicense(value: unknown): string | null {
  const data = jsonRecord(jsonRecord(value)?.Data)
  const license = data?.License
  if (typeof license !== 'string') return null
  const normalized = license.trim().normalize('NFC')
  const parsed = ModelSourceEvidenceV2Schema.shape.license.safeParse(normalized)
  return parsed.success ? parsed.data : null
}

function observedModelScopeRevision(
  reference: ModelRepositoryReferenceV2,
  metadataValue: unknown,
  resolutionValue: unknown,
): string {
  if (reference.revisionKind === 'commit' || reference.revisionKind === 'digest') {
    return reference.revision
  }
  const resolutionData = jsonRecord(jsonRecord(resolutionValue)?.Data)
  const latestCommitter = jsonRecord(resolutionData?.LatestCommitter)
  const shortId = latestCommitter?.ShortId
  if (typeof shortId === 'string' && /^[0-9a-f]{7,64}$/.test(shortId)) return shortId
  const metadataRevision = jsonRecord(jsonRecord(metadataValue)?.Data)?.Revision
  return typeof metadataRevision === 'string' && metadataRevision.length <= 256
    ? metadataRevision
    : reference.revision
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function evidence(input: {
  readonly adapter: typeof MODEL_SCOPE_ADAPTER | typeof OPERATOR_ADAPTER
  readonly observedAt: string
  readonly observedRevision?: string
  readonly result: ModelSourceEvidenceV2['result']
  readonly responseDigest?: string
  readonly license?: string | null
  readonly cacheStatus: ModelSourceEvidenceV2['cache_status']
}): ModelSourceEvidenceV2 {
  return ModelSourceEvidenceV2Schema.parse({
    evidence_kind: 'provider_resolution',
    adapter: input.adapter,
    adapter_version: ADAPTER_VERSION,
    observed_revision: input.observedRevision ?? null,
    observed_at: input.observedAt,
    result: input.result,
    response_digest: input.responseDigest ?? null,
    license: input.license ?? null,
    cache_status: input.cacheStatus,
  })
}

function checkedClock(clock: () => Date): string {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Model Repository clock returned an invalid Date')
  }
  return value.toISOString()
}
