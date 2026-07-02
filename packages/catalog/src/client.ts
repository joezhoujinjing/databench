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
  // and parallel test runs corrupt each other. Absent/`public` → unchanged.
  const schema = schemaFromUrl(connectionString)
  const adapter = new PrismaPg({ connectionString }, schema ? { schema } : undefined)

  return new PrismaClient({ adapter })
}

function schemaFromUrl(connectionString: string): string | undefined {
  try {
    return new URL(connectionString).searchParams.get('schema') ?? undefined
  } catch {
    return undefined
  }
}
