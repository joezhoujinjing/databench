import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import { type Dataset, fromParquetBytes, toParquetBytes } from '@databench/engine'
import { ManifestSchema, NotFoundError, parseVocabulary, type Vocabulary } from '@databench/schema'
import { storeObjectKeys, vocabularyObjectKeys } from './keys.js'
import type { Store } from './store.js'

export interface S3StoreConfig {
  readonly bucket: string
  readonly region: string
  readonly endpoint?: string
  readonly accessKeyId?: string
  readonly secretAccessKey?: string
  readonly forcePathStyle?: boolean
  readonly client?: S3Client
}

export class S3Store implements Store {
  readonly #bucket: string
  readonly #client: S3Client

  constructor(config: S3StoreConfig) {
    this.#bucket = config.bucket
    this.#client = config.client ?? new S3Client(buildS3ClientConfig(config))
  }

  // Connectivity + bucket-existence probe for health checks. Throws a
  // distinguishable S3 error (NoSuchBucket / connection refused) when unhealthy.
  async ping(): Promise<void> {
    await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }))
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

    await this.#putObject(keys.parquet, toParquetBytes(dataset), 'application/vnd.apache.parquet')
    await this.#putObject(
      keys.manifest,
      Buffer.from(formatManifestJson(dataset.manifest), 'utf8'),
      'application/json',
    )

    return version
  }

  async read(version: string): Promise<Dataset> {
    if (!(await this.exists(version))) {
      throw datasetNotFound(version)
    }

    const keys = storeObjectKeys(version)

    try {
      const [parquetBytes, manifestBytes] = await Promise.all([
        this.#getObjectBytes(keys.parquet),
        this.#getObjectBytes(keys.manifest),
      ])
      const manifest = ManifestSchema.parse(
        JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown,
      )

      return fromParquetBytes(parquetBytes, manifest)
    } catch (error) {
      if (isMissingS3Error(error)) {
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

    await this.#putObject(
      vocabularyObjectKeys(vocabulary.id).json,
      Buffer.from(formatVocabularyJson(vocabulary), 'utf8'),
      'application/json',
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
      if (isMissingS3Error(error)) {
        throw vocabularyNotFound(id)
      }

      throw error
    }
  }

  async #objectExists(key: string): Promise<boolean> {
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }))
      return true
    } catch (error) {
      if (isMissingS3Error(error)) {
        return false
      }

      throw error
    }
  }

  async #putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    )
  }

  async #getObjectBytes(key: string): Promise<Uint8Array> {
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
    )

    return objectBodyToBytes(response.Body)
  }
}

function buildS3ClientConfig(config: S3StoreConfig): S3ClientConfig {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
  }

  if (config.endpoint) {
    clientConfig.endpoint = config.endpoint
  }

  if (config.accessKeyId && config.secretAccessKey) {
    clientConfig.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    }
  }

  return clientConfig
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

function isMissingS3Error(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return error.$metadata.httpStatusCode === 404 || error.name === 'NotFound'
  }

  return false
}

async function objectBodyToBytes(body: GetObjectCommandOutput['Body']): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array()
  }

  if (typeof body.transformToByteArray === 'function') {
    return body.transformToByteArray()
  }

  const chunks: Buffer[] = []

  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk))
    } else {
      chunks.push(Buffer.from(chunk))
    }
  }

  return Buffer.concat(chunks)
}
