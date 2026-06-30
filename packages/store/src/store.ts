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
}

export type StoreConfig = S3StoreConfig

export function createStore(config: StoreConfig): Store {
  return new S3Store(config)
}
