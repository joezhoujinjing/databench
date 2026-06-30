import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const DEFAULT_DATABASE_URL =
  'postgresql://databench:databench@localhost:55432/databench?schema=public'

export interface PrismaClientOptions {
  readonly databaseUrl?: string
}

export function createPrismaClient(options: PrismaClientOptions = {}): PrismaClient {
  const connectionString = options.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  const adapter = new PrismaPg({ connectionString })

  return new PrismaClient({ adapter })
}
