#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const DEFAULT_DATABASE_URL =
  'postgresql://databench:databench@localhost:55432/databench?schema=public'

const [schema, command, ...args] = process.argv.slice(2)

if (!schema || !command) {
  console.error('usage: with-test-db-schema.mjs <schema> <command> [...args]')
  process.exit(2)
}

const databaseUrl = new URL(
  process.env.DATABENCH_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
)
databaseUrl.searchParams.set('schema', schema)

const result = spawnSync(command, args, {
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl.toString(),
  },
  stdio: 'inherit',
})

if (result.error) {
  console.error(result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)
