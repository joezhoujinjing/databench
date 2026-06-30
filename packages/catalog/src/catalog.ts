import type { Prisma, PrismaClient } from '@prisma/client'
import { createPrismaClient } from './client.js'

export interface DatasetMetadata {
  readonly version: string
  readonly name: string | null
  readonly num_rows: number
  readonly kinds: Record<string, number>
  readonly created_at: string
}

export interface RunMetadata {
  readonly cache_key: string
  readonly op: string
  readonly op_version: string
  readonly params: Record<string, unknown>
  readonly inputs: string[]
  readonly output_version: string
  readonly created_at: string
}

export interface VocabularyMetadata {
  readonly id: string
  readonly name: string | null
  readonly dimension: string
  readonly num_terms: number
  readonly status: string | null
}

export interface VocabularyRefMetadata {
  readonly vocab_id: string
  readonly status: string | null
}

export interface CatalogOptions {
  readonly databaseUrl?: string
  readonly prisma?: PrismaClient
}

export class Catalog {
  readonly #client: PrismaClient
  readonly #ownsClient: boolean

  constructor(options: CatalogOptions = {}) {
    this.#client =
      options.prisma ??
      createPrismaClient(
        options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl },
      )
    this.#ownsClient = options.prisma === undefined
  }

  async close(): Promise<void> {
    if (this.#ownsClient) {
      await this.#client.$disconnect()
    }
  }

  async registerDataset(
    version: string,
    name: string | null,
    numRows: number,
    kinds: Record<string, number>,
  ): Promise<void> {
    await this.#client.datasetRecord.createMany({
      data: [
        {
          version,
          name,
          numRows,
          kinds: kinds as Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    })
  }

  async getDataset(version: string): Promise<DatasetMetadata | null> {
    const row = await this.#client.datasetRecord.findUnique({ where: { version } })

    return row ? rowToDataset(row) : null
  }

  async recordRun(
    cacheKey: string,
    op: string,
    opVersion: string,
    params: Record<string, unknown>,
    inputs: readonly string[],
    outputVersion: string,
  ): Promise<void> {
    const data = {
      op,
      opVersion,
      params: params as Prisma.InputJsonObject,
      inputs: [...inputs] as Prisma.InputJsonArray,
      outputVersion,
      createdAt: new Date(),
    }

    await this.#client.runRecord.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        ...data,
      },
      update: data,
    })
  }

  async findRun(cacheKey: string): Promise<string | null> {
    const row = await this.#client.runRecord.findUnique({
      where: { cacheKey },
      select: { outputVersion: true },
    })

    return row?.outputVersion ?? null
  }

  async runsProducing(version: string): Promise<RunMetadata[]> {
    const rows = await this.#client.runRecord.findMany({
      where: { outputVersion: version },
      orderBy: [{ createdAt: 'asc' }, { cacheKey: 'asc' }],
    })

    return rows.map(rowToRun)
  }

  async setRef(name: string, version: string, message: string | null = null): Promise<void> {
    const data = {
      version,
      message,
      updatedAt: new Date(),
    }

    await this.#client.refRecord.upsert({
      where: { name },
      create: {
        name,
        ...data,
      },
      update: data,
    })
  }

  async getRef(name: string): Promise<string | null> {
    const row = await this.#client.refRecord.findUnique({
      where: { name },
      select: { version: true },
    })

    return row?.version ?? null
  }

  async listRefs(): Promise<Record<string, string>> {
    const rows = await this.#client.refRecord.findMany({
      orderBy: { name: 'asc' },
      select: { name: true, version: true },
    })

    return Object.fromEntries(rows.map((row) => [row.name, row.version]))
  }

  async registerVocabulary(
    id: string,
    name: string | null,
    dimension: string,
    numTerms: number,
  ): Promise<void> {
    await this.#client.vocabularyRecord.createMany({
      data: [
        {
          id,
          name,
          dimension,
          numTerms,
        },
      ],
      skipDuplicates: true,
    })
  }

  async setVocabularyRef(
    name: string,
    vocabId: string,
    status: string | null = null,
  ): Promise<void> {
    const data = {
      vocabId,
      status,
      updatedAt: new Date(),
    }

    await this.#client.vocabularyRefRecord.upsert({
      where: { name },
      create: {
        name,
        ...data,
      },
      update: data,
    })
  }

  async getVocabularyRef(name: string): Promise<string | null> {
    const row = await this.#client.vocabularyRefRecord.findUnique({
      where: { name },
      select: { vocabId: true },
    })

    return row?.vocabId ?? null
  }

  async getVocabularyRefRow(name: string): Promise<VocabularyRefMetadata | null> {
    const row = await this.#client.vocabularyRefRecord.findUnique({
      where: { name },
      select: { vocabId: true, status: true },
    })

    return row ? { vocab_id: row.vocabId, status: row.status } : null
  }

  async listVocabularies(): Promise<VocabularyMetadata[]> {
    const rows = await this.#client.vocabularyRefRecord.findMany({
      include: { vocabulary: true },
      orderBy: { name: 'asc' },
    })

    return rows.map((row) => ({
      id: row.vocabId,
      name: row.name,
      dimension: row.vocabulary.dimension,
      num_terms: row.vocabulary.numTerms,
      status: row.status,
    }))
  }

  async resolve(refOrVersion: string): Promise<string> {
    if ((await this.getDataset(refOrVersion)) !== null) {
      return refOrVersion
    }

    return (await this.getRef(refOrVersion)) ?? refOrVersion
  }
}

function rowToDataset(row: {
  version: string
  name: string | null
  numRows: number
  kinds: Prisma.JsonValue
  createdAt: Date
}): DatasetMetadata {
  return {
    version: row.version,
    name: row.name,
    num_rows: row.numRows,
    kinds: jsonRecordOfNumbers(row.kinds),
    created_at: row.createdAt.toISOString(),
  }
}

function rowToRun(row: {
  cacheKey: string
  op: string
  opVersion: string
  params: Prisma.JsonValue
  inputs: Prisma.JsonValue
  outputVersion: string
  createdAt: Date
}): RunMetadata {
  return {
    cache_key: row.cacheKey,
    op: row.op,
    op_version: row.opVersion,
    params: jsonRecord(row.params),
    inputs: jsonStringArray(row.inputs),
    output_version: row.outputVersion,
    created_at: row.createdAt.toISOString(),
  }
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return {}
}

function jsonRecordOfNumbers(value: Prisma.JsonValue): Record<string, number> {
  const record = jsonRecord(value)
  const result: Record<string, number> = {}

  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'number') {
      result[key] = item
    }
  }

  return result
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === 'string')
}
