import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterEach, describe, expect, test } from 'vitest'
import { RetirementDatabase } from '../src/database.js'

const DEFAULT_DATABASE_URL =
  'postgresql://databench:databench@localhost:55432/databench?schema=public'
const migrationPaths = [
  '../../../prisma/migrations/0001_catalog/migration.sql',
  '../../../prisma/migrations/0002_vocabularies/migration.sql',
  '../../../prisma/migrations/0003_v2_catalog/migration.sql',
  '../../../prisma/migrations/0004_v2_run_lineage_sequence/migration.sql',
] as const
const retirementMigrationPath = '../../../prisma/migrations/0005_retire_v1_catalog/migration.sql'

const schemas: string[] = []

afterEach(async () => {
  const pool = new Pool({ connectionString: driverUrl() })
  try {
    for (const schema of schemas.splice(0)) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
  } finally {
    await pool.end()
  }
})

describe('R4 forward migration', () => {
  test('refuses non-empty v1 tables until the exact preflight is approved', async () => {
    const schema = `r4_${randomBytes(8).toString('hex')}`
    schemas.push(schema)
    const pool = new Pool({ connectionString: driverUrl() })
    const client = await pool.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      for (const path of migrationPaths) {
        await client.query(await readFile(new URL(path, import.meta.url), 'utf8'))
      }
      await client.query(
        `INSERT INTO identity_namespaces_v2 (id, scope)
         VALUES ('00000000-0000-4000-8000-000000000001', 'default')`,
      )
      await client.query(
        `INSERT INTO datasets (version, name, num_rows, kinds_json)
         VALUES ('legacy-dataset', 'legacy', 1, '["sft"]'::jsonb);
         INSERT INTO runs (cache_key, op, op_version, params_json, inputs_json, output_version)
         VALUES ('legacy-run', 'sample', '1', '{}'::jsonb, '[]'::jsonb, 'legacy-dataset');
         INSERT INTO refs (name, version) VALUES ('legacy', 'legacy-dataset');
         INSERT INTO vocabularies (id, name, dimension, num_terms)
         VALUES ('legacy-vocab', 'legacy', 'label', 1);
         INSERT INTO vocab_refs (name, vocab_id, status)
         VALUES ('legacy-vocab-ref', 'legacy-vocab', 'curated')`,
      )

      const retirementSql = await readFile(
        new URL(retirementMigrationPath, import.meta.url),
        'utf8',
      )
      await expect(client.query(retirementSql)).rejects.toThrow(/without an operator-confirmed/)

      const databaseUrl = databaseUrlForSchema(schema)
      const database = new RetirementDatabase(databaseUrl)
      try {
        const plan = await database.scanV1()
        expect(plan.total_rows).toBe('5')
        await database.approveV1Retirement(plan, plan.digest)
      } finally {
        await database.close()
      }

      await client.query(`UPDATE datasets SET name = 'changed-after-approval'`)
      await expect(client.query(retirementSql)).rejects.toThrow(
        /contents changed after R4 approval/,
      )

      const updatedDatabase = new RetirementDatabase(databaseUrl)
      try {
        const updatedPlan = await updatedDatabase.scanV1()
        await updatedDatabase.approveV1Retirement(updatedPlan, updatedPlan.digest)
      } finally {
        await updatedDatabase.close()
      }

      await client.query(retirementSql)
      const tables = await client.query<{ relation: string | null }>(
        `SELECT to_regclass('datasets')::text AS relation
         UNION ALL SELECT to_regclass('runs')::text
         UNION ALL SELECT to_regclass('refs')::text
         UNION ALL SELECT to_regclass('vocabularies')::text
         UNION ALL SELECT to_regclass('vocab_refs')::text`,
      )
      expect(tables.rows.every((row) => row.relation === null)).toBe(true)
      const sentinel = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM identity_namespaces_v2',
      )
      expect(sentinel.rows[0]?.count).toBe('1')
    } finally {
      client.release()
      await pool.end()
    }
  })
})

function databaseUrlForSchema(schema: string): string {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL)
  url.searchParams.set('schema', schema)
  return url.toString()
}

function driverUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL)
  url.searchParams.delete('schema')
  url.searchParams.delete('options')
  return url.toString()
}
