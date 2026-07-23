import type { Dataset } from '@databench/engine'
import type { Vocabulary } from '@databench/schema'
import { OssStore, type OssStoreConfig, ossConfigFromEnv } from './oss-store.js'
import { S3Store, type S3StoreConfig, s3ConfigFromEnv } from './s3-store.js'

export interface Store {
  exists(version: string): Promise<boolean>
  write(dataset: Dataset): Promise<string>
  read(version: string): Promise<Dataset>
  vocabularyExists(id: string): Promise<boolean>
  writeVocabulary(vocabulary: Vocabulary): Promise<string>
  readVocabulary(id: string): Promise<Vocabulary>
  // Optional connectivity probe (OSS getBucketInfo): resolves if the backing
  // store is reachable and the bucket exists, rejects otherwise. Used by health
  // checks; implementations without a remote backend may omit it.
  ping?(): Promise<void>
}

export type ObjectStoreKind = 'oss' | 's3'

export type StoreConfig =
  | ({ readonly kind?: 'oss' } & OssStoreConfig)
  | ({ readonly kind: 's3' } & S3StoreConfig)

export function storeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const kind = objectStoreKindFromEnv(env)

  if (kind === 's3') {
    return { ...s3ConfigFromEnv(env), kind }
  }

  return { ...ossConfigFromEnv(env), kind }
}

export function createStore(config: StoreConfig): Store {
  if (config.kind === 's3') {
    return new S3Store(config)
  }

  return new OssStore(config)
}

function objectStoreKindFromEnv(env: NodeJS.ProcessEnv): ObjectStoreKind {
  const raw = (env.DATABENCH_OBJECT_STORE ?? 'oss').trim().toLowerCase()

  if (raw === 'oss' || raw === 's3') {
    return raw
  }

  throw new Error(`unsupported DATABENCH_OBJECT_STORE: ${env.DATABENCH_OBJECT_STORE}`)
}
