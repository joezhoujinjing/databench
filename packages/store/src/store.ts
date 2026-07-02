import type { Dataset } from '@databench/engine'
import type { Vocabulary } from '@databench/schema'
import { S3Store, type S3StoreConfig } from './s3-store.js'

export interface Store {
  exists(version: string): Promise<boolean>
  write(dataset: Dataset): Promise<string>
  read(version: string): Promise<Dataset>
  vocabularyExists(id: string): Promise<boolean>
  writeVocabulary(vocabulary: Vocabulary): Promise<string>
  readVocabulary(id: string): Promise<Vocabulary>
  // Optional connectivity probe (e.g. HeadBucket): resolves if the backing store
  // is reachable and the bucket exists, rejects otherwise. Used by health checks;
  // implementations without a remote backend may omit it.
  ping?(): Promise<void>
}

export type StoreConfig = S3StoreConfig

export function createStore(config: StoreConfig): Store {
  return new S3Store(config)
}
