import { NotFoundError } from '@databench/schema'
import type { WorkspaceOpenOptions } from '@databench/workspace'

type WorkspaceStore = NonNullable<WorkspaceOpenOptions['store']>
type StoredDataset = Awaited<ReturnType<WorkspaceStore['read']>>
type StoredVocabulary = Awaited<ReturnType<WorkspaceStore['readVocabulary']>>

export function createMemoryStore(): WorkspaceStore {
  const datasets = new Map<string, StoredDataset>()
  const vocabularies = new Map<string, StoredVocabulary>()

  return {
    async exists(version) {
      return datasets.has(version)
    },
    async read(version) {
      const dataset = datasets.get(version)

      if (dataset === undefined) {
        throw new NotFoundError(`dataset version not found in memory store: ${version}`, {
          version,
        })
      }

      return dataset
    },
    async write(dataset) {
      datasets.set(dataset.version, dataset)
      return dataset.version
    },
    async vocabularyExists(id) {
      return vocabularies.has(id)
    },
    async readVocabulary(id) {
      const vocabulary = vocabularies.get(id)

      if (vocabulary === undefined) {
        throw new NotFoundError(`vocabulary not found in memory store: ${id}`, { id })
      }

      return vocabulary
    },
    async writeVocabulary(vocabulary) {
      vocabularies.set(vocabulary.id, vocabulary)
      return vocabulary.id
    },
  }
}
