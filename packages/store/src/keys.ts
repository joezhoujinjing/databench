export interface StoreObjectKeys {
  readonly parquet: string
  readonly manifest: string
}

export interface VocabularyObjectKeys {
  readonly json: string
}

export function storeObjectKeys(version: string): StoreObjectKeys {
  const shard = version.slice(0, 2)
  const base = `objects/${shard}/${version}`

  return {
    parquet: `${base}.parquet`,
    manifest: `${base}.manifest.json`,
  }
}

export function vocabularyObjectKeys(id: string): VocabularyObjectKeys {
  const shard = id.slice(0, 2)
  return {
    json: `vocabularies/${shard}/${id}.json`,
  }
}
