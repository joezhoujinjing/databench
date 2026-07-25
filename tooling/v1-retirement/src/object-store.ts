import { createRequire } from 'node:module'
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { type V2ObjectStoreConfig, v2ObjectStoreConfigFromEnv } from '@databench/store'
import { assertExactLegacyDeletionKey, parseLegacyObjectTarget } from './legacy-keys.js'
import { createObjectRetirementPlan } from './manifest.js'
import type {
  LegacyObjectTarget,
  ObjectMetadata,
  ObjectRetirementPlan,
  ObjectStoreProvider,
} from './types.js'

const LIST_PREFIXES = ['objects/', 'vocabularies/'] as const
const V2_PREFIX = 'objects/v2/'
const MAX_DELETE_BATCH = 1000
const OSS_REQUEST_TIMEOUT_MS = 30_000

export interface RetirementObjectStore {
  readonly provider: ObjectStoreProvider
  readonly bucket: string
  list(prefix: string): Promise<readonly ObjectMetadata[]>
  delete(keys: readonly string[]): Promise<void>
}

export class RetirementObjectService {
  readonly #store: RetirementObjectStore

  constructor(store: RetirementObjectStore) {
    this.#store = store
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RetirementObjectService {
    return new RetirementObjectService(createRetirementObjectStore(v2ObjectStoreConfigFromEnv(env)))
  }

  async scanV1(): Promise<Readonly<ObjectRetirementPlan>> {
    const all = new Map<string, ObjectMetadata>()
    for (const prefix of LIST_PREFIXES) {
      for (const object of await this.#store.list(prefix)) {
        const existing = all.get(object.key)
        if (
          existing &&
          (existing.size !== object.size ||
            normalizeEtag(existing.etag) !== normalizeEtag(object.etag))
        ) {
          throw new Error(`object listing returned conflicting metadata for key: ${object.key}`)
        }
        all.set(object.key, normalizeObject(object))
      }
    }

    const targets: LegacyObjectTarget[] = []
    const unrecognized: ObjectMetadata[] = []
    let protectedV2ObjectCount = 0
    for (const object of all.values()) {
      if (object.key.startsWith(V2_PREFIX)) {
        protectedV2ObjectCount += 1
        continue
      }
      const target = parseLegacyObjectTarget(object)
      if (target) {
        targets.push(target)
      } else {
        unrecognized.push(object)
      }
    }

    return createObjectRetirementPlan({
      provider: this.#store.provider,
      bucket: this.#store.bucket,
      targets,
      unrecognizedLegacyPrefixObjects: unrecognized,
      protectedV2ObjectCount,
    })
  }

  async listV2Objects(): Promise<readonly ObjectMetadata[]> {
    return (await this.#store.list(V2_PREFIX)).map(normalizeObject).sort(compareObjects)
  }

  async deleteV1(
    expectedPlan: Readonly<ObjectRetirementPlan>,
    confirmedDigest: string,
  ): Promise<number> {
    if (
      expectedPlan.provider !== this.#store.provider ||
      expectedPlan.bucket !== this.#store.bucket
    ) {
      throw new Error('object-store provider or bucket differs from the preflight manifest')
    }
    if (confirmedDigest !== expectedPlan.digest) {
      throw new TypeError('object confirmation digest does not match the preflight manifest')
    }

    const current = await this.scanV1()
    if (current.digest !== expectedPlan.digest) {
      throw new Error(
        `object retirement plan drifted: expected ${expectedPlan.digest}, current ${current.digest}`,
      )
    }
    if (current.unrecognized_legacy_prefix_objects.length > 0) {
      throw new Error('refusing to delete while unrecognized objects remain under a legacy prefix')
    }
    if (current.targets.length === 0) return 0

    const keys = current.targets.map((target) => target.key)
    for (const key of keys) assertExactLegacyDeletionKey(key)
    await this.#store.delete(keys)

    const after = await this.scanV1()
    if (after.targets.length > 0) {
      throw new Error(
        `legacy object deletion was incomplete: ${after.targets.length} recognized keys remain`,
      )
    }
    return keys.length
  }
}

export function createRetirementObjectStore(config: V2ObjectStoreConfig): RetirementObjectStore {
  if (config.kind === 's3') return new S3RetirementObjectStore(config)
  return new OssRetirementObjectStore(config)
}

class S3RetirementObjectStore implements RetirementObjectStore {
  readonly provider = 's3' as const
  readonly bucket: string
  readonly #client: S3Client

  constructor(config: Extract<V2ObjectStoreConfig, { kind: 's3' }>) {
    this.bucket = requiredString(config.bucket, 'S3 bucket')
    this.#client = config.client ?? new S3Client(buildS3Config(config))
  }

  async list(prefix: string): Promise<readonly ObjectMetadata[]> {
    const objects: ObjectMetadata[] = []
    let continuationToken: string | null | undefined
    const seenTokens = new Set<string>()
    while (continuationToken !== null) {
      const result = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(typeof continuationToken !== 'string'
            ? {}
            : { ContinuationToken: continuationToken }),
        }),
      )
      for (const item of result.Contents ?? []) {
        if (typeof item.Key !== 'string')
          throw new Error('S3 listing returned an object without a key')
        objects.push(
          normalizeObject({
            key: item.Key,
            size: requireSafeSize(item.Size, item.Key),
            etag: normalizeEtag(item.ETag ?? null),
          }),
        )
      }
      if (!result.IsTruncated) {
        continuationToken = null
        continue
      }
      const next = result.NextContinuationToken
      if (!next || seenTokens.has(next)) {
        throw new Error('S3 listing returned an invalid continuation token')
      }
      seenTokens.add(next)
      continuationToken = next
    }
    return objects
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += MAX_DELETE_BATCH) {
      const batch = keys.slice(offset, offset + MAX_DELETE_BATCH)
      const result = await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: false,
          },
        }),
      )
      if ((result.Errors?.length ?? 0) > 0) {
        const failed = result.Errors?.map((error) => error.Key ?? '<unknown>').join(', ')
        throw new Error(`S3 failed to delete exact legacy keys: ${failed}`)
      }
    }
  }
}

interface OssListResult {
  readonly objects?: readonly {
    readonly name?: unknown
    readonly size?: unknown
    readonly etag?: unknown
  }[]
  readonly isTruncated?: unknown
  readonly nextContinuationToken?: unknown
}

interface OssDeleteResult {
  readonly deleted?: readonly { readonly Key?: unknown }[]
}

interface OssMaintenanceClient {
  listV2(
    query: Readonly<Record<string, string | number>>,
    options: { readonly timeout: number },
  ): Promise<OssListResult>
  deleteMulti(
    names: readonly string[],
    options: { readonly quiet: boolean; readonly timeout: number },
  ): Promise<OssDeleteResult>
}

interface OssClientOptions {
  readonly bucket: string
  readonly accessKeyId: string
  readonly accessKeySecret: string
  readonly region?: string
  readonly endpoint?: string
  readonly secure?: boolean
  readonly internal?: boolean
  readonly retryMax: 0
  readonly timeout: number
}

type OssConstructor = new (options: OssClientOptions) => OssMaintenanceClient
const nodeRequire = createRequire(import.meta.url)
const OSS = nodeRequire('ali-oss') as OssConstructor

class OssRetirementObjectStore implements RetirementObjectStore {
  readonly provider = 'oss' as const
  readonly bucket: string
  readonly #client: OssMaintenanceClient

  constructor(config: Exclude<V2ObjectStoreConfig, { kind: 's3' }>) {
    this.bucket = requiredString(config.bucket, 'OSS bucket')
    this.#client = new OSS({
      bucket: this.bucket,
      accessKeyId: requiredString(config.accessKeyId, 'OSS access key ID'),
      accessKeySecret: requiredString(config.accessKeySecret, 'OSS access key secret'),
      retryMax: 0,
      timeout: OSS_REQUEST_TIMEOUT_MS,
      ...(config.region === undefined ? {} : { region: config.region }),
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.secure === undefined ? {} : { secure: config.secure }),
      ...(config.internal === undefined ? {} : { internal: config.internal }),
    })
  }

  async list(prefix: string): Promise<readonly ObjectMetadata[]> {
    const objects: ObjectMetadata[] = []
    let continuationToken: string | null | undefined
    const seenTokens = new Set<string>()
    while (continuationToken !== null) {
      const result = await this.#client.listV2(
        {
          prefix,
          'max-keys': 1000,
          ...(typeof continuationToken !== 'string'
            ? {}
            : { 'continuation-token': continuationToken }),
        },
        { timeout: OSS_REQUEST_TIMEOUT_MS },
      )
      for (const item of result.objects ?? []) {
        if (typeof item.name !== 'string')
          throw new Error('OSS listing returned an object without a key')
        objects.push(
          normalizeObject({
            key: item.name,
            size: requireSafeSize(item.size, item.name),
            etag: typeof item.etag === 'string' ? normalizeEtag(item.etag) : null,
          }),
        )
      }
      if (result.isTruncated !== true) {
        continuationToken = null
        continue
      }
      const next = result.nextContinuationToken
      if (typeof next !== 'string' || next.length === 0 || seenTokens.has(next)) {
        throw new Error('OSS listing returned an invalid continuation token')
      }
      seenTokens.add(next)
      continuationToken = next
    }
    return objects
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += MAX_DELETE_BATCH) {
      const batch = keys.slice(offset, offset + MAX_DELETE_BATCH)
      const result = await this.#client.deleteMulti(batch, {
        quiet: false,
        timeout: OSS_REQUEST_TIMEOUT_MS,
      })
      const deleted = new Set(
        (result.deleted ?? [])
          .map((item) => item.Key)
          .filter((key): key is string => typeof key === 'string'),
      )
      if (deleted.size > 0 && batch.some((key) => !deleted.has(key))) {
        throw new Error('OSS did not acknowledge every exact legacy key deletion')
      }
    }
  }
}

function buildS3Config(config: Extract<V2ObjectStoreConfig, { kind: 's3' }>): S3ClientConfig {
  const result: S3ClientConfig = {
    forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
    maxAttempts: 1,
    region: config.region,
  }
  if (config.endpoint) result.endpoint = config.endpoint
  if (config.accessKeyId && config.secretAccessKey) {
    result.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    }
  }
  return result
}

function normalizeObject(object: Readonly<ObjectMetadata>): ObjectMetadata {
  return {
    key: object.key,
    size: requireSafeSize(object.size, object.key),
    etag: normalizeEtag(object.etag),
  }
}

function normalizeEtag(etag: string | null): string | null {
  if (etag === null) return null
  const trimmed = etag.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function requireSafeSize(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`object listing returned an invalid size for key: ${key}`)
  }
  return value
}

function requiredString(value: string, label: string): string {
  if (value.trim().length === 0) throw new TypeError(`${label} must be non-empty`)
  return value
}

function compareObjects(left: ObjectMetadata, right: ObjectMetadata): number {
  return left.key.localeCompare(right.key)
}
