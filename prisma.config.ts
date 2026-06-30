import { defineConfig } from 'prisma/config'

const localDatabaseUrl = 'postgresql://databench:databench@localhost:55432/databench?schema=public'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? localDatabaseUrl,
  },
})
