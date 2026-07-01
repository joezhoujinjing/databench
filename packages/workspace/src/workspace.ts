import { open } from 'node:fs/promises'
import { Catalog } from '@databench/catalog'
import {
  Dataset,
  type PolarsDataFrame,
  type Transform,
  type TransformParams,
} from '@databench/engine'
import { exportRecord, type ReadJsonlOptions, readJsonl } from '@databench/io'
import {
  assertVocabularyInput,
  deriveVocabulary as deriveVocabularyFromSamples,
  type Extractor,
  NotFoundError,
  normalizeSamples,
  parseRecipe,
  type Recipe,
  type Sample,
  toRecipeJson,
  type ValidateSummary,
  type Vocabulary,
  type VocabularyInput,
  validateSamples,
  vocabularyExtractor,
  withVocabularyId,
} from '@databench/schema'
import { createStore, type Store, type StoreConfig } from '@databench/store'
import { recipeCacheKey, transformCacheKey } from './cache-key.js'
import { recipeFingerprint } from './fingerprint.js'
import { mix } from './mix.js'

export type DatasetLike = Dataset | string
export type VocabularyLike = Vocabulary | string
const VOCAB_OP_VERSION = '1'

export interface WorkspaceOpenOptions {
  readonly root?: string
  readonly databaseUrl?: string
  readonly store?: Store
  readonly catalog?: Catalog
  readonly storeConfig?: StoreConfig
}

export interface AddOptions {
  readonly name?: string | null
  readonly message?: string | null
}

export interface AddJsonlOptions extends AddOptions {
  readonly kind?: ReadJsonlOptions['kind']
  readonly source?: string | null
}

export interface RunOptions {
  readonly ref?: string | null
  readonly params?: TransformParams
}

export interface MaterializeOptions {
  readonly ref?: string | null
}

export interface DeriveVocabularyOptions {
  readonly name?: string | null
  readonly dimension: string
  readonly extractor: Extractor
}

export interface ApplyVocabularyOptions {
  readonly extractor?: Extractor | null
  readonly ref?: string | null
}

export interface LineageNode {
  version: string
  name?: string | null
  num_rows?: number
  produced_by?: {
    op: string
    op_version: string
    params: Record<string, unknown>
  }
  inputs?: LineageNode[]
  cycle?: true
}

export interface JsonlExport {
  readonly filename: string
  readonly lines: Iterable<string>
}

export class Workspace {
  readonly root: string | null
  readonly store: Store
  readonly catalog: Catalog

  constructor(options: WorkspaceOpenOptions = {}) {
    this.root = options.root ?? null
    this.store = options.store ?? createStore(defaultStoreConfig(options.storeConfig))
    this.catalog = options.catalog ?? new Catalog(catalogOptions(options.databaseUrl))
  }

  static open(rootOrOptions: string | WorkspaceOpenOptions = {}): Workspace {
    return new Workspace(
      typeof rootOrOptions === 'string' ? { root: rootOrOptions } : rootOrOptions,
    )
  }

  async close(): Promise<void> {
    await this.catalog.close()
  }

  async addSamples(
    samples: Iterable<Sample | unknown>,
    options: AddOptions = {},
  ): Promise<Dataset> {
    const dataset = Dataset.fromSamples(samples, options.name ?? null)
    await this.#persist(dataset)

    if (options.name) {
      await this.catalog.setRef(options.name, dataset.version, options.message ?? null)
    }

    return dataset
  }

  async addJsonl(path: string, options: AddJsonlOptions = {}): Promise<Dataset> {
    const samples: Sample[] = []
    const readOptions: ReadJsonlOptions = {
      ...('kind' in options ? { kind: options.kind ?? null } : {}),
      ...('source' in options ? { source: options.source ?? null } : {}),
    }

    for await (const sample of readJsonl(path, readOptions)) {
      samples.push(sample)
    }

    return this.addSamples(samples, options)
  }

  async add(dataset: Dataset, options: AddOptions = {}): Promise<Dataset> {
    await this.#persist(dataset)

    if (options.name) {
      await this.catalog.setRef(options.name, dataset.version, options.message ?? null)
    }

    return dataset
  }

  async get(refOrVersion: DatasetLike): Promise<Dataset> {
    if (refOrVersion instanceof Dataset) {
      return refOrVersion
    }

    const version = await this.catalog.resolve(refOrVersion)
    return this.store.read(version)
  }

  async run(
    transform: Transform,
    inputs: readonly DatasetLike[],
    options: RunOptions = {},
  ): Promise<Dataset> {
    const inputDatasets = await Promise.all(inputs.map((input) => this.get(input)))
    const { params, paramsDict } = transform.buildParams(options.params ?? {})
    const cacheKey = transformCacheKey({
      op: transform.name,
      opVersion: transform.version,
      inputs: inputDatasets.map((dataset) => dataset.version),
      params: paramsDict,
    })

    const cached = await this.catalog.findRun(cacheKey)
    let output: Dataset

    if (cached && (await this.store.exists(cached))) {
      output = await this.store.read(cached)
    } else {
      const result =
        params === null
          ? await Promise.resolve(transform.fn(...inputDatasets))
          : await Promise.resolve(transform.fn(...inputDatasets, params))

      output = coerceDataset(result, options.ref ?? null)
      await this.#persist(output)
      await this.catalog.recordRun(
        cacheKey,
        transform.name,
        transform.version,
        paramsDict,
        inputDatasets.map((dataset) => dataset.version),
        output.version,
      )
    }

    if (options.ref) {
      await this.catalog.setRef(options.ref, output.version)
    }

    return output
  }

  async materialize(
    recipeLike: Recipe | unknown,
    options: MaterializeOptions = {},
  ): Promise<Dataset> {
    const recipe = parseRecipe(recipeLike)
    const resolved: Record<string, string> = {}

    for (const source of recipe.sources) {
      resolved[source.dataset] = await this.catalog.resolve(source.dataset)
    }

    const frames = await Promise.all(
      recipe.sources.map(async (source) => ({
        source,
        frame: (await this.get(resolved[source.dataset] as string)).toPolars(),
      })),
    )
    const fingerprint = recipeFingerprint(recipe, resolved)
    const cacheKey = recipeCacheKey(recipe.name, fingerprint)
    const cached = await this.catalog.findRun(cacheKey)
    let output: Dataset

    if (cached && (await this.store.exists(cached))) {
      output = await this.store.read(cached)
    } else {
      output = mix(recipe, frames)
      await this.#persist(output)
      await this.catalog.recordRun(
        cacheKey,
        `recipe:${recipe.name}`,
        '1',
        toRecipeJson(recipe),
        sortedUnique(Object.values(resolved)),
        output.version,
      )
    }

    if (options.ref) {
      await this.catalog.setRef(options.ref, output.version)
    }

    return output
  }

  async listRefs(): Promise<Record<string, string>> {
    const refs = await this.catalog.listRefs()
    const existing = await Promise.all(
      Object.entries(refs).map(async ([name, version]) =>
        (await this.store.exists(version)) ? ([name, version] as const) : null,
      ),
    )

    return Object.fromEntries(
      existing.filter((row): row is readonly [string, string] => row !== null),
    )
  }

  async getRef(name: string): Promise<string | null> {
    const version = await this.catalog.getRef(name)

    if (version === null) {
      return null
    }

    return (await this.store.exists(version)) ? version : null
  }

  async deriveVocabulary(
    dataset: DatasetLike,
    options: DeriveVocabularyOptions,
  ): Promise<Vocabulary> {
    const inputDataset = await this.get(dataset)
    const params = {
      dimension: options.dimension,
      extractor: options.extractor,
    }
    const cacheKey = transformCacheKey({
      op: 'vocabulary:derive',
      opVersion: VOCAB_OP_VERSION,
      inputs: [inputDataset.version],
      params,
    })
    const cached = await this.catalog.findRun(cacheKey)
    let vocabulary: Vocabulary

    if (cached && (await this.store.vocabularyExists(cached))) {
      vocabulary = await this.store.readVocabulary(cached)
    } else {
      vocabulary = deriveVocabularyFromSamples(inputDataset.toSamples(), {
        dimension: options.dimension,
        extractor: options.extractor,
        name: options.name ?? null,
      })
      await this.#persistVocabulary(vocabulary)
      await this.catalog.recordRun(
        cacheKey,
        'vocabulary:derive',
        VOCAB_OP_VERSION,
        params,
        [inputDataset.version],
        vocabulary.id,
      )
    }

    if (options.name) {
      vocabulary = { ...vocabulary, name: options.name, status: 'draft' }
      await this.catalog.setVocabularyRef(options.name, vocabulary.id, 'draft')
    }

    return vocabulary
  }

  async saveVocabulary(input: VocabularyInput | Vocabulary): Promise<Vocabulary> {
    // Enforce the three vocabulary invariants (unique canonicals / one canonical
    // per alias / aliases disjoint from canonicals) at the domain boundary —
    // `withVocabularyId` alone skips `superRefine`, so a non-HTTP caller could
    // otherwise persist an illegal blob (Python enforces these in the ctor).
    let vocabulary = withVocabularyId(assertVocabularyInput(input))
    const parent = vocabulary.name ? await this.catalog.getVocabularyRef(vocabulary.name) : null

    if (vocabulary.status !== 'curated') {
      vocabulary = { ...vocabulary, status: 'curated' }
    }

    await this.#persistVocabulary(vocabulary)

    if (parent && parent !== vocabulary.id) {
      const cacheKey = transformCacheKey({
        op: 'vocabulary:curate',
        opVersion: VOCAB_OP_VERSION,
        inputs: [parent],
        params: {},
      })
      await this.catalog.recordRun(
        cacheKey,
        'vocabulary:curate',
        VOCAB_OP_VERSION,
        {},
        [parent],
        vocabulary.id,
      )
    }

    if (vocabulary.name) {
      await this.catalog.setVocabularyRef(vocabulary.name, vocabulary.id, 'curated')
    }

    return vocabulary
  }

  async getVocabulary(nameOrId: string): Promise<Vocabulary> {
    const ref = await this.catalog.getVocabularyRefRow(nameOrId)
    const id = ref?.vocab_id ?? nameOrId

    if (!(await this.store.vocabularyExists(id))) {
      throw new NotFoundError(`vocabulary not found: ${nameOrId}`, { vocabulary: nameOrId })
    }

    let vocabulary = await this.store.readVocabulary(id)

    if (ref) {
      vocabulary = {
        ...vocabulary,
        name: nameOrId,
        status: ref.status === 'draft' || ref.status === 'curated' ? ref.status : vocabulary.status,
      }
    }

    return vocabulary
  }

  async listVocabularies(): Promise<Awaited<ReturnType<Catalog['listVocabularies']>>> {
    const rows = await this.catalog.listVocabularies()
    const existing = await Promise.all(
      rows.map(async (row) => ((await this.store.vocabularyExists(row.id)) ? row : null)),
    )

    return existing.filter((row): row is (typeof rows)[number] => row !== null)
  }

  async normalizeVocabulary(
    dataset: DatasetLike,
    vocabularyLike: VocabularyLike,
    options: ApplyVocabularyOptions = {},
  ): Promise<Dataset> {
    const inputDataset = await this.get(dataset)
    const vocabulary =
      typeof vocabularyLike === 'string' ? await this.getVocabulary(vocabularyLike) : vocabularyLike
    const extractor = resolveVocabularyExtractor(vocabulary, options.extractor ?? null)
    const params = {
      dimension: vocabulary.dimension,
      extractor,
    }
    const cacheKey = transformCacheKey({
      op: 'vocabulary:normalize',
      opVersion: VOCAB_OP_VERSION,
      inputs: [inputDataset.version, vocabulary.id],
      params,
    })
    const cached = await this.catalog.findRun(cacheKey)
    let output: Dataset

    if (cached && (await this.store.exists(cached))) {
      output = await this.store.read(cached)
    } else {
      output = Dataset.fromSamples(
        normalizeSamples(inputDataset.toSamples(), vocabulary, extractor),
        options.ref ?? inputDataset.name,
      )
      await this.#persist(output)
      await this.catalog.recordRun(
        cacheKey,
        'vocabulary:normalize',
        VOCAB_OP_VERSION,
        params,
        [inputDataset.version, vocabulary.id],
        output.version,
      )
    }

    if (options.ref) {
      await this.catalog.setRef(options.ref, output.version)
    }

    return output
  }

  async validateVocabulary(
    dataset: DatasetLike,
    vocabularyLike: VocabularyLike,
    options: ApplyVocabularyOptions = {},
  ): Promise<{ readonly dataset: Dataset; readonly summary: ValidateSummary }> {
    const inputDataset = await this.get(dataset)
    const vocabulary =
      typeof vocabularyLike === 'string' ? await this.getVocabulary(vocabularyLike) : vocabularyLike
    const extractor = resolveVocabularyExtractor(vocabulary, options.extractor ?? null)
    const result = validateSamples(inputDataset.toSamples(), vocabulary, extractor)
    const output = Dataset.fromSamples(result.samples, options.ref ?? inputDataset.name)
    await this.#persist(output)

    const params = {
      dimension: vocabulary.dimension,
      extractor,
    }
    const cacheKey = transformCacheKey({
      op: 'vocabulary:validate',
      opVersion: VOCAB_OP_VERSION,
      inputs: [inputDataset.version, vocabulary.id],
      params,
    })
    await this.catalog.recordRun(
      cacheKey,
      'vocabulary:validate',
      VOCAB_OP_VERSION,
      params,
      [inputDataset.version, vocabulary.id],
      output.version,
    )

    if (options.ref) {
      await this.catalog.setRef(options.ref, output.version)
    }

    return { dataset: output, summary: result.summary }
  }

  async lineage(refOrVersion: DatasetLike): Promise<LineageNode> {
    const version =
      refOrVersion instanceof Dataset
        ? refOrVersion.version
        : await this.catalog.resolve(refOrVersion)

    return this.#lineage(version, new Set())
  }

  async export(
    refOrVersion: DatasetLike,
    path: string,
    format = 'messages-jsonl',
  ): Promise<string> {
    const { lines } = await this.exportJsonl(refOrVersion, format)
    const handle = await open(path, 'w')

    try {
      for (const line of lines) {
        await handle.write(line)
      }
    } finally {
      await handle.close()
    }

    return path
  }

  async exportJsonl(refOrVersion: DatasetLike, format = 'messages-jsonl'): Promise<JsonlExport> {
    const dataset = await this.get(refOrVersion)

    return {
      filename: `${dataset.name || dataset.version.slice(0, 12)}.jsonl`,
      lines: exportLines(dataset, format),
    }
  }

  async #lineage(version: string, seen: ReadonlySet<string>): Promise<LineageNode> {
    const node: LineageNode = { version }
    const metadata = await this.catalog.getDataset(version)

    if (metadata) {
      node.name = metadata.name
      node.num_rows = metadata.num_rows
    }

    if (seen.has(version)) {
      node.cycle = true
      return node
    }

    const nextSeen = new Set(seen)
    nextSeen.add(version)

    const producers = await this.catalog.runsProducing(version)
    const run = producers[0]

    if (run) {
      node.produced_by = {
        op: run.op,
        op_version: run.op_version,
        params: run.params,
      }
      node.inputs = await Promise.all(run.inputs.map((input) => this.#lineage(input, nextSeen)))
    }

    return node
  }

  async #persist(dataset: Dataset): Promise<void> {
    await this.store.write(dataset)
    await this.catalog.registerDataset(
      dataset.version,
      dataset.manifest.name,
      dataset.length,
      dataset.manifest.kinds,
    )
  }

  async #persistVocabulary(vocabulary: Vocabulary): Promise<void> {
    await this.store.writeVocabulary(vocabulary)
    await this.catalog.registerVocabulary(
      vocabulary.id,
      vocabulary.name,
      vocabulary.dimension,
      vocabulary.terms.length,
    )
  }
}

export function resolveVocabularyExtractor(
  vocabulary: Vocabulary,
  extractor: Extractor | null,
): Extractor {
  const resolved = extractor ?? vocabularyExtractor(vocabulary)

  if (resolved === null) {
    throw new Error(
      'no extractor: pass one explicitly or use a vocabulary that records its derive extractor in meta',
    )
  }

  return resolved
}

export function coerceDataset(result: unknown, name: string | null): Dataset {
  if (result instanceof Dataset) {
    return result
  }

  if (isPolarsDataFrame(result)) {
    return Dataset.fromFrame(result, name)
  }

  throw new TypeError(`transform must return Dataset or polars.DataFrame, got ${typeof result}`)
}

function isPolarsDataFrame(value: unknown): value is PolarsDataFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    'height' in value &&
    'columns' in value &&
    'toRecords' in value &&
    'clone' in value
  )
}

function defaultStoreConfig(config: StoreConfig | undefined): StoreConfig {
  if (config) {
    return config
  }

  return {
    bucket: process.env.S3_BUCKET ?? 'databench',
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'databench',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'databench-secret',
    forcePathStyle: true,
  }
}

function catalogOptions(databaseUrl: string | undefined): { databaseUrl?: string } {
  return databaseUrl === undefined ? {} : { databaseUrl }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function* exportLines(dataset: Dataset, format: string): IterableIterator<string> {
  for (const sample of dataset.toSamples()) {
    yield `${JSON.stringify(exportRecord(sample, format))}\n`
  }
}
