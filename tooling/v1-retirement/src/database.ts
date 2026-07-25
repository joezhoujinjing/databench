import { TextEncoder } from 'node:util'
import { hashArtifactBytes } from '@databench/hashing'
import { Pool, type PoolClient } from 'pg'
import { createDatabaseRetirementPlan } from './manifest.js'
import {
  type DatabaseRetirementPlan,
  type DatabaseTablePlan,
  type ForeignKey,
  V1_TABLE_NAMES,
  type V1TableName,
  V2_TABLE_NAMES,
  type V2CatalogFingerprint,
} from './types.js'

const DEFAULT_DATABASE_URL =
  'postgresql://databench:databench@localhost:55432/databench?schema=public'
const APPROVAL_TABLE = '_databench_v1_retirement_approval'
const textEncoder = new TextEncoder()

interface CountAndRows {
  readonly row_count: string
  readonly rows_json: string
  readonly rows_md5: string
}

interface ForeignKeyRow {
  readonly name: string
  readonly source_table: string
  readonly target_table: string
  readonly definition: string
}

export interface RegisteredLayout {
  readonly datasetVersion: string
  readonly layoutVersion: string
}

export class RetirementDatabase {
  readonly schema: string
  readonly #pool: Pool

  constructor(databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
    this.schema = schemaFromUrl(databaseUrl)
    this.#pool = new Pool({
      connectionString: connectionStringWithSearchPath(databaseUrl, this.schema),
      max: 2,
    })
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }

  async scanV1(): Promise<Readonly<DatabaseRetirementPlan>> {
    return this.#readTransaction((client) => scanV1WithClient(client, this.schema))
  }

  async v2CatalogFingerprint(): Promise<readonly V2CatalogFingerprint[]> {
    return this.#readTransaction(async (client) => {
      const fingerprints: V2CatalogFingerprint[] = []
      for (const table of V2_TABLE_NAMES) {
        if (!(await tableExists(client, this.schema, table))) {
          throw new Error(`required v2 catalog table is missing: ${this.schema}.${table}`)
        }
        const rows = await countAndRows(client, this.schema, table)
        fingerprints.push({
          table,
          row_count: rows.row_count,
          rows_digest: digestText(rows.rows_json),
        })
      }
      return fingerprints
    })
  }

  async registeredLayouts(): Promise<readonly RegisteredLayout[]> {
    return this.#readTransaction(async (client) => {
      if (!(await tableExists(client, this.schema, 'dataset_layouts_v2'))) return []
      const result = await client.query<{
        dataset_version: string
        layout_version: string
      }>(
        `SELECT dataset_version, layout_version
         FROM ${qualified(this.schema, 'dataset_layouts_v2')}
         ORDER BY dataset_version COLLATE "C", layout_version COLLATE "C"`,
      )
      return result.rows.map((row) => ({
        datasetVersion: row.dataset_version,
        layoutVersion: row.layout_version,
      }))
    })
  }

  async approveV1Retirement(
    expectedPlan: Readonly<DatabaseRetirementPlan>,
    confirmedDigest: string,
  ): Promise<void> {
    if (confirmedDigest !== expectedPlan.digest) {
      throw new TypeError('database confirmation digest does not match the preflight manifest')
    }

    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE')
      for (const table of V1_TABLE_NAMES) {
        if (await tableExists(client, this.schema, table)) {
          await client.query(`LOCK TABLE ${qualified(this.schema, table)} IN SHARE MODE`)
        }
      }
      const current = await scanV1WithClient(client, this.schema)
      if (current.digest !== expectedPlan.digest) {
        throw new Error(
          `database retirement plan drifted: expected ${expectedPlan.digest}, current ${current.digest}`,
        )
      }
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${qualified(this.schema, APPROVAL_TABLE)} (
          singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
          database_digest CHAR(64) NOT NULL CHECK (database_digest ~ '^[0-9a-f]{64}$'),
          table_counts JSONB NOT NULL,
          approved_at TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp()
        )`,
      )
      const tableCounts = Object.fromEntries(
        current.tables.map((table) => [
          table.name,
          {
            row_count: table.row_count,
            rows_digest: table.rows_digest,
            rows_md5: table.rows_md5,
          },
        ]),
      )
      await client.query(
        `INSERT INTO ${qualified(this.schema, APPROVAL_TABLE)}
          (singleton, database_digest, table_counts)
         VALUES (TRUE, $1, $2::jsonb)
         ON CONFLICT (singleton) DO UPDATE SET
           database_digest = EXCLUDED.database_digest,
           table_counts = EXCLUDED.table_counts,
           approved_at = transaction_timestamp()`,
        [current.digest, JSON.stringify(tableCounts)],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async assertV1TablesAbsent(): Promise<void> {
    const remaining = await this.#readTransaction(async (client) => {
      const names: V1TableName[] = []
      for (const table of V1_TABLE_NAMES) {
        if (await tableExists(client, this.schema, table)) names.push(table)
      }
      return names
    })
    if (remaining.length > 0) {
      throw new Error(`v1 catalog tables still exist: ${remaining.join(', ')}`)
    }
  }

  async #readTransaction<T>(read: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const result = await read(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

async function scanV1WithClient(
  client: PoolClient,
  schema: string,
): Promise<Readonly<DatabaseRetirementPlan>> {
  const foreignKeys = await v1ForeignKeys(client, schema)
  const tables: DatabaseTablePlan[] = []
  for (const table of V1_TABLE_NAMES) {
    const exists = await tableExists(client, schema, table)
    if (!exists) {
      tables.push({
        name: table,
        exists: false,
        row_count: '0',
        rows_digest: digestText('[]'),
        rows_md5: md5EmptyArray(),
        total_bytes: '0',
        foreign_keys: [],
      })
      continue
    }
    const [rows, size] = await Promise.all([
      countAndRows(client, schema, table),
      relationSize(client, schema, table),
    ])
    tables.push({
      name: table,
      exists: true,
      row_count: rows.row_count,
      rows_digest: digestText(rows.rows_json),
      rows_md5: rows.rows_md5,
      total_bytes: size,
      foreign_keys: foreignKeys.filter(
        (key) => key.source_table === table || key.target_table === table,
      ),
    })
  }
  return createDatabaseRetirementPlan(schema, tables)
}

async function countAndRows(
  client: PoolClient,
  schema: string,
  table: string,
): Promise<CountAndRows> {
  const result = await client.query<CountAndRows>(
    `WITH rows AS (
       SELECT to_jsonb(value) AS row_json
       FROM ${qualified(schema, table)} AS value
     ),
     summary AS (
       SELECT
         count(*)::text AS row_count,
         COALESCE(jsonb_agg(row_json ORDER BY row_json::text), '[]'::jsonb) AS rows_json
       FROM rows
     )
     SELECT row_count, rows_json::text, md5(rows_json::text) AS rows_md5
     FROM summary`,
  )
  const row = result.rows[0]
  if (!row) throw new Error(`unable to inspect database table: ${schema}.${table}`)
  return row
}

async function relationSize(client: PoolClient, schema: string, table: string): Promise<string> {
  const result = await client.query<{ total_bytes: string }>(
    'SELECT pg_total_relation_size($1::regclass)::text AS total_bytes',
    [`${schema}.${table}`],
  )
  const value = result.rows[0]?.total_bytes
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`database returned an invalid relation size for ${schema}.${table}`)
  }
  return value
}

async function tableExists(client: PoolClient, schema: string, table: string): Promise<boolean> {
  const result = await client.query<{ relation: string | null }>(
    'SELECT to_regclass($1)::text AS relation',
    [`${schema}.${table}`],
  )
  const relation = result.rows[0]?.relation
  if (relation === undefined) {
    throw new Error(`database did not return relation metadata for ${schema}.${table}`)
  }
  return relation !== null
}

async function v1ForeignKeys(client: PoolClient, schema: string): Promise<ForeignKey[]> {
  const result = await client.query<ForeignKeyRow>(
    `SELECT
       constraint_row.conname AS name,
       source_table.relname AS source_table,
       target_table.relname AS target_table,
       pg_get_constraintdef(constraint_row.oid, TRUE) AS definition
     FROM pg_constraint AS constraint_row
     JOIN pg_class AS source_table ON source_table.oid = constraint_row.conrelid
     JOIN pg_namespace AS source_namespace ON source_namespace.oid = source_table.relnamespace
     JOIN pg_class AS target_table ON target_table.oid = constraint_row.confrelid
     JOIN pg_namespace AS target_namespace ON target_namespace.oid = target_table.relnamespace
     WHERE constraint_row.contype = 'f'
       AND source_namespace.nspname = $1
       AND target_namespace.nspname = $1
       AND (
         source_table.relname = ANY($2::text[])
         OR target_table.relname = ANY($2::text[])
       )
     ORDER BY source_table.relname COLLATE "C",
              target_table.relname COLLATE "C",
              constraint_row.conname COLLATE "C"`,
    [schema, [...V1_TABLE_NAMES]],
  )
  return result.rows
}

function schemaFromUrl(databaseUrl: string): string {
  let schema = 'public'
  try {
    schema = new URL(databaseUrl).searchParams.get('schema') ?? 'public'
  } catch {
    throw new TypeError('DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new TypeError('DATABASE_URL schema must be a lowercase PostgreSQL identifier')
  }
  return schema
}

function connectionStringWithSearchPath(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl)
  const existingOptions = url.searchParams.get('options')
  const searchPathOption = `-c search_path=${schema}`
  url.searchParams.set(
    'options',
    existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption,
  )
  return url.toString()
}

function qualified(schema: string, table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || !/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new TypeError('unsafe PostgreSQL identifier')
  }
  return `"${schema}"."${table}"`
}

function digestText(value: string): string {
  return hashArtifactBytes(textEncoder.encode(value))
}

function md5EmptyArray(): string {
  return 'd751713988987e9331980363e24189ce'
}
