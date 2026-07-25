#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { Pool } from 'pg'

const DEFAULT_DATABASE_URL =
  'postgresql://databench:databench@localhost:55432/databench?schema=public'

const rawArgs = process.argv.slice(2)
const reset = rawArgs[0] === '--reset'
const [schema, command, ...args] = reset ? rawArgs.slice(1) : rawArgs

if (!schema || !command) {
  console.error('usage: with-test-db-schema.mjs [--reset] <schema> <command> [...args]')
  process.exit(2)
}

const databaseUrl = new URL(
  process.env.DATABENCH_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
)
databaseUrl.searchParams.set('schema', schema)

if (reset) {
  if (!/^databench_test_[a-z0-9_]+$/.test(schema)) {
    console.error(`refusing to reset a non-test schema: ${schema}`)
    process.exit(2)
  }
  const driverUrl = new URL(databaseUrl)
  driverUrl.searchParams.delete('schema')
  driverUrl.searchParams.delete('options')
  const pool = new Pool({ connectionString: driverUrl.toString() })
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await pool.end()
  }
}

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
