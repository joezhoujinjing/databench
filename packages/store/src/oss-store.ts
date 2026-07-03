import { createRequire } from 'node:module'
import { type Dataset, fromParquetBytes, toParquetBytes } from '@databench/engine'
import { ManifestSchema, NotFoundError, parseVocabulary, type Vocabulary } from '@databench/schema'
import { storeObjectKeys, vocabularyObjectKeys } from './keys.js'
import type { Store } from './store.js'

// ali-oss is CommonJS with an `export =` class; require it (bulletproof under
// ESM + verbatimModuleSyntax) and hand-type the handful of methods we use rather
// than depend on the mediocre @types/ali-oss.
export interface OssClientOptions {
  readonly bucket: string
  readonly accessKeyId: string
  readonly accessKeySecret: string
  readonly region?: string
  readonly endpoint?: string
  readonly secure?: boolean
  readonly internal?: boolean
}

interface OssGetResult {
  readonly content: Buffer
}

export interface OssClient {
  put(name: string, file: Buffer, options?: { mime?: string }): Promise<unknown>
  get(name: string): Promise<OssGetResult>
  head(name: string): Promise<unknown>
  delete(name: string): Promise<unknown>
  getBucketInfo(name?: string): Promise<unknown>
}

type OssConstructor = new (options: OssClientOptions) => OssClient

const nodeRequire = createRequire(import.meta.url)
const OSS = nodeRequire('ali-oss') as OssConstructor

export interface OssStoreConfig {
  readonly bucket: string
  readonly accessKeyId: string
  readonly accessKeySecret: string
  // Either region (ali-oss builds the endpoint) or an explicit endpoint.
  readonly region?: string
  readonly endpoint?: string
  readonly secure?: boolean
  // Use the Aliyun-internal (VPC) endpoint — no egress cost from ECS/ACK.
  readonly internal?: boolean
  // Injectable client, mainly for tests.
  readonly client?: OssClient
}

// Single source of the OSS env → config mapping, shared by workspace and (via a
// re-export) apps/api so the two adapters can't drift. Defaults to HTTPS
// (opt out with OSS_SECURE=false) and the public endpoint (OSS_INTERNAL=true for
// the VPC endpoint). Credentials are required for real use; empty defaults let
// an unconfigured Workspace.open() build lazily and fail cleanly on first use.
export function ossConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OssStoreConfig {
  return {
    bucket: env.OSS_BUCKET ?? 'databench',
    region: env.OSS_REGION ?? 'oss-cn-hangzhou',
    accessKeyId: env.OSS_ACCESS_KEY_ID ?? '',
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET ?? '',
    secure: env.OSS_SECURE !== 'false',
    internal: env.OSS_INTERNAL === 'true',
    ...(env.OSS_ENDPOINT ? { endpoint: env.OSS_ENDPOINT } : {}),
  }
}

export class OssStore implements Store {
  readonly #config: OssStoreConfig
  #client: OssClient | null

  constructor(config: OssStoreConfig) {
    this.#config = config
    // Construct the ali-oss client lazily: its constructor validates
    // credentials, so an unconfigured Workspace.open() must not throw here —
    // it should surface as a clean error (or a doctor `store: not ok`) on first
    // real use instead.
    this.#client = config.client ?? null
  }

  #oss(): OssClient {
    this.#client ??= new OSS(buildOssOptions(this.#config))
    return this.#client
  }

  // Connectivity + bucket-existence probe for health checks. Throws a
  // distinguishable OSS error (NoSuchBucket / auth / network) when unhealthy.
  // Pass the bucket explicitly — ali-oss's getBucketInfo runs a bucket-name check
  // before its own default-bucket fallback.
  async ping(): Promise<void> {
    await this.#oss().getBucketInfo(this.#config.bucket)
  }

  async exists(version: string): Promise<boolean> {
    const keys = storeObjectKeys(version)
    const hasParquet = await this.#objectExists(keys.parquet)

    if (!hasParquet) {
      return false
    }

    return this.#objectExists(keys.manifest)
  }

  async write(dataset: Dataset): Promise<string> {
    const { version } = dataset

    if (await this.exists(version)) {
      return version
    }

    const keys = storeObjectKeys(version)

    // Parquet BEFORE manifest, and `exists` checks parquet first: a crash
    // between the two writes leaves `exists` false, so retries self-heal.
    await this.#oss().put(keys.parquet, Buffer.from(toParquetBytes(dataset)), {
      mime: 'application/vnd.apache.parquet',
    })
    await this.#oss().put(
      keys.manifest,
      Buffer.from(formatManifestJson(dataset.manifest), 'utf8'),
      {
        mime: 'application/json',
      },
    )

    return version
  }

  async read(version: string): Promise<Dataset> {
    if (!(await this.exists(version))) {
      throw datasetNotFound(version)
    }

    const keys = storeObjectKeys(version)

    try {
      const [parquet, manifestBytes] = await Promise.all([
        this.#getObjectBytes(keys.parquet),
        this.#getObjectBytes(keys.manifest),
      ])
      const manifest = ManifestSchema.parse(
        JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown,
      )

      return fromParquetBytes(parquet, manifest)
    } catch (error) {
      if (isMissingOssError(error)) {
        throw datasetNotFound(version)
      }

      throw error
    }
  }

  async vocabularyExists(id: string): Promise<boolean> {
    return this.#objectExists(vocabularyObjectKeys(id).json)
  }

  async writeVocabulary(vocabulary: Vocabulary): Promise<string> {
    if (await this.vocabularyExists(vocabulary.id)) {
      return vocabulary.id
    }

    await this.#oss().put(
      vocabularyObjectKeys(vocabulary.id).json,
      Buffer.from(formatVocabularyJson(vocabulary), 'utf8'),
      { mime: 'application/json' },
    )

    return vocabulary.id
  }

  async readVocabulary(id: string): Promise<Vocabulary> {
    if (!(await this.vocabularyExists(id))) {
      throw vocabularyNotFound(id)
    }

    try {
      const bytes = await this.#getObjectBytes(vocabularyObjectKeys(id).json)
      return parseVocabulary(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
    } catch (error) {
      if (isMissingOssError(error)) {
        throw vocabularyNotFound(id)
      }

      throw error
    }
  }

  async #objectExists(key: string): Promise<boolean> {
    try {
      await this.#oss().head(key)
      return true
    } catch (error) {
      if (isMissingOssError(error)) {
        return false
      }

      throw error
    }
  }

  async #getObjectBytes(key: string): Promise<Uint8Array> {
    const result = await this.#oss().get(key)
    return result.content
  }
}

function buildOssOptions(config: OssStoreConfig): OssClientOptions {
  return {
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.secure !== undefined ? { secure: config.secure } : {}),
    ...(config.internal !== undefined ? { internal: config.internal } : {}),
  }
}

function formatManifestJson(manifest: unknown): string {
  return JSON.stringify(ManifestSchema.parse(manifest), null, 2)
}

function formatVocabularyJson(vocabulary: Vocabulary): string {
  return JSON.stringify(vocabulary, null, 2)
}

function datasetNotFound(version: string): NotFoundError {
  return new NotFoundError(`dataset version not found in store: ${version}`, { version })
}

function vocabularyNotFound(id: string): NotFoundError {
  return new NotFoundError(`vocabulary not found in store: ${id}`, { id })
}

// ali-oss raises errors with an OSS `code` and/or an HTTP `status`; a missing
// object/bucket is 404 / NoSuchKey / NoSuchBucket.
function isMissingOssError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const { status, code } = error as { status?: number; code?: string }
  return status === 404 || code === 'NoSuchKey' || code === 'NoSuchBucket'
}
