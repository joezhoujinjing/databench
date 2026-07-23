import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const DEFAULT_DATABASE_URL =
  'postgresql://databench:databench@localhost:55432/databench?schema=public'

export interface PrismaClientOptions {
  readonly databaseUrl?: string
}

export function createPrismaClient(options: PrismaClientOptions = {}): PrismaClient {
  const connectionString = options.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  // Honor the connection URL's `?schema=` at the driver level. Without this the
  // pg adapter ignores it and every connection queries `public`, so the
  // per-package test schemas (databench_test_*) collapse onto one shared schema
  // and parallel test runs corrupt each other. An absent schema remains
  // unchanged; every explicit schema, including `public`, is enforced below.
  const schema = schemaFromUrl(connectionString)
  // Prisma's adapter-level schema qualifies generated model queries, but raw
  // SQL still follows PostgreSQL's connection search_path. Keep both paths on
  // the same schema so TypedSQL/$queryRaw cannot accidentally touch `public`.
  const driverConnectionString = connectionStringWithSearchPath(connectionString, schema)
  const adapter = new PrismaPg(
    { connectionString: driverConnectionString },
    schema ? { schema } : undefined,
  )

  return new PrismaClient({ adapter })
}

function connectionStringWithSearchPath(
  connectionString: string,
  schema: string | undefined,
): string {
  if (schema === undefined) return connectionString
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new TypeError('DATABASE_URL schema must be a lowercase PostgreSQL identifier')
  }
  const url = new URL(connectionString)
  const existingOptions = url.searchParams.get('options')
  const searchPathOption = `-c search_path=${schema}`
  url.searchParams.set(
    'options',
    existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption,
  )
  return url.toString()
}

function schemaFromUrl(connectionString: string): string | undefined {
  try {
    return new URL(connectionString).searchParams.get('schema') ?? undefined
  } catch {
    return undefined
  }
}
