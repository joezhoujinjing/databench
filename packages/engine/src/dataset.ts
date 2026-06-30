import { canonicalJson, hashText, hashUnordered } from '@databench/hashing'
import {
  COLUMNS,
  type Manifest,
  ManifestSchema,
  parseSample,
  type Sample,
  toContent,
} from '@databench/schema'
import { Field, Schema, Table, Utf8, vectorFromArray } from 'apache-arrow'
import { createDatasetFrame, type DatasetColumns, type PolarsDataFrame } from './frame.js'
import { loads } from './loads.js'
import { rowDigest } from './row-digest.js'

type DatasetColumn = (typeof COLUMNS)[number]

export interface RawDatasetRow {
  readonly content: Record<string, unknown>
  readonly source?: string | null
  readonly meta?: Record<string, unknown> | null
  readonly signals?: Record<string, unknown> | null
}

interface DatasetRecord {
  readonly id: string | null
  readonly row_digest: string | null
  readonly kind: string | null
  readonly source: string | null
  readonly payload: string | null
  readonly meta: string | null
  readonly signals: string | null
}

const ARROW_SCHEMA = new Schema(COLUMNS.map((column) => new Field(column, new Utf8(), true)))

export class Dataset {
  readonly manifest: Manifest
  readonly #frame: PolarsDataFrame

  constructor(frame: PolarsDataFrame, manifest: Manifest) {
    this.#frame = frame
    this.manifest = ManifestSchema.parse(manifest)
  }

  static fromSamples(samples: Iterable<Sample | unknown>, name: string | null = null): Dataset {
    const rows: RawDatasetRow[] = []

    for (const value of samples) {
      const sample = parseSample(value)
      rows.push({
        content: toContent(sample),
        source: sample.source,
        meta: sample.meta,
        signals: sample.signals,
      })
    }

    return buildDataset(rows, name)
  }

  static fromFrame(frame: PolarsDataFrame, name: string | null = null): Dataset {
    const columns = new Set(frame.columns)
    if (!columns.has('payload')) {
      throw new Error("frame is missing required columns: {'payload'}")
    }

    const rows: RawDatasetRow[] = frame.toRecords().map((record) => {
      const row = record as Partial<DatasetRecord>
      return {
        content: loads(row.payload),
        source: columns.has('source') ? (row.source ?? null) : null,
        meta: columns.has('meta') && row.meta ? loads(row.meta) : {},
        signals: columns.has('signals') && row.signals ? loads(row.signals) : {},
      }
    })

    return buildDataset(rows, name)
  }

  get version(): string {
    return this.manifest.version
  }

  get name(): string | null {
    return this.manifest.name
  }

  get length(): number {
    return this.manifest.num_rows
  }

  toString(): string {
    return `Dataset(name=${JSON.stringify(this.manifest.name)}, version=${this.version.slice(
      0,
      12,
    )}, rows=${this.length})`
  }

  toPolars(): PolarsDataFrame {
    return this.#frame.clone()
  }

  toArrow(): Table {
    const columns = emptyArrowColumns()

    for (const record of this.#frame.toRecords()) {
      const row = record as Partial<Record<DatasetColumn, unknown>>

      for (const column of COLUMNS) {
        const value = row[column]
        columns[column].push(value == null ? null : String(value))
      }
    }

    const arrowColumns = Object.fromEntries(
      COLUMNS.map((column) => [column, vectorFromArray(columns[column], new Utf8())]),
    )

    return new Table(ARROW_SCHEMA, arrowColumns)
  }

  *toSamples(offset = 0, limit?: number): IterableIterator<Sample> {
    const frame = this.#frame.slice({
      offset,
      length: limit ?? Math.max(this.length - offset, 0),
    })

    for (const record of frame.toRecords()) {
      const row = record as unknown as DatasetRecord
      const object = loads(row.payload)
      object.source = row.source
      object.meta = row.meta ? loads(row.meta) : {}
      object.signals = row.signals ? loads(row.signals) : {}
      yield parseSample(object)
    }
  }

  head(count = 5): Sample[] {
    return [...this.toSamples(0, count)]
  }
}

export function buildDataset(rows: Iterable<RawDatasetRow>, name: string | null = null): Dataset {
  const ids: string[] = []
  const digests: string[] = []
  const kinds: string[] = []
  const sources: Array<string | null> = []
  const payloads: string[] = []
  const metas: string[] = []
  const signals: string[] = []

  for (const row of rows) {
    const content = row.content
    const source = row.source ?? null
    const meta = row.meta ?? {}
    const signalValues = row.signals ?? {}

    const payloadJson = canonicalJson(content)
    const metaJson = canonicalJson(meta)
    const signalsJson = canonicalJson(signalValues)
    const id = hashText(payloadJson)
    const digest = rowDigest(payloadJson, source, metaJson, signalsJson)
    const kind = typeof content.kind === 'string' ? content.kind : 'unknown'

    ids.push(id)
    digests.push(digest)
    kinds.push(kind)
    sources.push(source)
    payloads.push(payloadJson)
    metas.push(metaJson)
    signals.push(signalsJson)
  }

  const columns: DatasetColumns = {
    id: ids,
    row_digest: digests,
    kind: kinds,
    source: sources,
    payload: payloads,
    meta: metas,
    signals,
  }
  const frame = createDatasetFrame(columns)
  const manifest = ManifestSchema.parse({
    name,
    version: digests.length > 0 ? hashUnordered(digests) : hashText('empty'),
    num_rows: ids.length,
    kinds: countKinds(kinds),
    created_at: new Date().toISOString(),
    columns: [...COLUMNS],
  })

  return new Dataset(frame, manifest)
}

function countKinds(kinds: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const kind of kinds) {
    counts[kind] = (counts[kind] ?? 0) + 1
  }

  return counts
}

function emptyArrowColumns(): Record<DatasetColumn, Array<string | null>> {
  return Object.fromEntries(
    COLUMNS.map((column) => [column, [] as Array<string | null>]),
  ) as Record<DatasetColumn, Array<string | null>>
}
