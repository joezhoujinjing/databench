#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const MIGRATIONS = {
  '0001': '0001_catalog',
  '0002': '0002_vocabularies',
  '0003': '0003_v2_catalog',
  '0004': '0004_v2_run_lineage_sequence',
  '0005': '0005_retire_v1_catalog',
  '0006': '0006_recoverable_ref_trash',
  '0007': '0007_transform_jobs_v2',
  '0008': '0008_worker_staging_v1',
  '0009': '0009_transform_job_result_ref',
  '0010': '0010_evaluation_runs_v2',
  '0011': '0011_swift_studio_sessions_v2',
  '0012': '0012_model_artifacts_v2',
  '0013': '0013_model_deployments_v2',
  '0014': '0014_evaluation_metric_selection_v2',
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const databaseUrl = new URL(
  process.env.DATABASE_URL ??
    'postgresql://databench:databench@localhost:55432/databench?schema=databench_test_models_forward',
)
const schema = databaseUrl.searchParams.get('schema')
if (schema === null || !/^databench_test_[a-z0-9_]+$/.test(schema)) {
  throw new Error('forward migration check requires an isolated databench_test_* schema')
}
databaseUrl.searchParams.delete('schema')
databaseUrl.searchParams.delete('options')

const client = new Client({ connectionString: databaseUrl.toString() })
await client.connect()
try {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await client.query(`SET search_path TO "${schema}"`)
  for (let number = 1; number <= 14; number += 1) {
    const prefix = number.toString().padStart(4, '0')
    const directory = MIGRATIONS[prefix]
    if (directory === undefined) throw new Error(`missing migration directory for ${prefix}`)
    await applyMigration(directory)
  }

  await seedS4Rows()
  const rowsBefore = await legacyRows()
  const constraintsBefore = await legacyConstraints()

  await applyMigration('0015_model_registry_v2')

  const rowsAfter = await legacyRows()
  const constraintsAfter = await legacyConstraints()
  if (JSON.stringify(rowsAfter) !== JSON.stringify(rowsBefore)) {
    throw new Error('0015 changed pre-existing S4 rows')
  }
  if (JSON.stringify(constraintsAfter) !== JSON.stringify(constraintsBefore)) {
    throw new Error('0015 changed pre-existing S4 constraints')
  }

  const newTables = await client.query(`
    SELECT "table_name"
    FROM "information_schema"."tables"
    WHERE
      "table_schema" = current_schema() AND
      "table_name" IN (
        'models_v2',
        'model_versions_v2',
        'model_version_artifact_sources_v2',
        'model_version_repository_sources_v2',
        'model_version_service_sources_v2',
        'model_source_evidence_v2',
        'model_aliases_v2',
        'model_registration_claims_v2'
      )
    ORDER BY "table_name" COLLATE "C"
  `)
  if (newTables.rows.length !== 8) {
    throw new Error(`0015 created ${newTables.rows.length} of 8 required Model registry tables`)
  }

  const aliasConstraints = await client.query(`
    SELECT "conname"
    FROM "pg_constraint"
    WHERE
      "connamespace" = current_schema()::regnamespace AND
      "conname" = 'model_aliases_v2_version_fkey'
  `)
  const sourceTriggers = await client.query(`
    SELECT "tgname"
    FROM "pg_trigger"
    WHERE
      NOT "tgisinternal" AND
      "tgrelid" IN (
        SELECT "oid" FROM "pg_class" WHERE "relnamespace" = current_schema()::regnamespace
      ) AND
      "tgname" IN (
        'model_versions_v2_source_xor',
        'model_version_repository_sources_v2_source_xor'
      )
    ORDER BY "tgname" COLLATE "C"
  `)
  if (aliasConstraints.rows.length !== 1 || sourceTriggers.rows.length !== 2) {
    throw new Error('0015 did not create the Alias FK and deferred source XOR constraints')
  }

  console.log(
    JSON.stringify({
      status: 'ok',
      schema,
      preserved_rows: rowsAfter,
      preserved_constraints: constraintsAfter.map(({ name }) => name),
      new_tables: newTables.rows.map(({ table_name: tableName }) => tableName),
      authoritative_constraints: [
        ...aliasConstraints.rows.map(({ conname }) => conname),
        ...sourceTriggers.rows.map(({ tgname }) => tgname),
      ],
    }),
  )
} finally {
  await client.end()
}

async function applyMigration(directory) {
  const sql = await readFile(
    resolve(repositoryRoot, 'prisma', 'migrations', directory, 'migration.sql'),
    'utf8',
  )
  await client.query(sql)
}

async function seedS4Rows() {
  const namespaceId = '11111111-1111-4111-8111-111111111111'
  const datasetVersion = 'a'.repeat(64)
  await client.query(
    `INSERT INTO "identity_namespaces_v2" ("id", "scope") VALUES ($1::uuid, 'default')`,
    [namespaceId],
  )
  await client.query(
    `
      INSERT INTO "dataset_snapshots_v2" (
        "version", "identity_profile", "record_schema_version", "num_records"
      ) VALUES ($1, 'databench-v2-jcs-1', '2.0.0', 0)
    `,
    [datasetVersion],
  )
  await client.query(
    `
      INSERT INTO "dataset_layouts_v2" (
        "dataset_version", "layout_version", "artifact_digest", "artifact_size_bytes",
        "manifest_key", "columns_json"
      ) VALUES ($1, 'record-json-v1', $1, 1, $2, $3::jsonb)
    `,
    [
      datasetVersion,
      `objects/v2/record-json-v1/aa/${datasetVersion}/manifest.json`,
      JSON.stringify(['record_id', 'record_digest', 'record_json']),
    ],
  )
  await client.query(
    `INSERT INTO "refs_v2" ("namespace_id", "name", "version", "message") VALUES ($1, 'main', $2, 'S4 preserved')`,
    [namespaceId, datasetVersion],
  )
  await client.query(
    `
      INSERT INTO "evaluation_runs_v2" (
        "id", "namespace_id", "provider", "provider_task_id", "create_request_digest",
        "dataset_version", "source_ref", "converter", "converter_version",
        "converter_options_json", "fidelity_digest", "benchmark", "model_name",
        "evalscope_commit", "status", "create_profile"
      ) VALUES (
        '22222222-2222-4222-8222-222222222222'::uuid, $1::uuid, 'evalscope',
        'forward-fixture', $2, $3, 'main', 'evalscope-general-qa', '1.0.0',
        '{}'::jsonb, $4, 'general_qa', NULL, NULL, 'prepared', 'evaluation-run-create-v1'
      )
    `,
    [namespaceId, 'b'.repeat(64), datasetVersion, 'c'.repeat(64)],
  )
}

async function legacyRows() {
  const result = await client.query(`
    SELECT 'namespace' AS "kind", "id"::text AS "id", "scope" AS "value"
    FROM "identity_namespaces_v2"
    UNION ALL
    SELECT 'dataset', "version"::text, "identity_profile"
    FROM "dataset_snapshots_v2"
    UNION ALL
    SELECT 'ref', "namespace_id"::text || '/' || "name", "version"::text
    FROM "refs_v2"
    UNION ALL
    SELECT 'evaluation', "id"::text, "create_profile" || '/' || "create_request_digest"::text
    FROM "evaluation_runs_v2"
    ORDER BY "kind", "id"
  `)
  return result.rows
}

async function legacyConstraints() {
  const result = await client.query(`
    SELECT "conname" AS "name", pg_get_constraintdef("oid") AS "definition"
    FROM "pg_constraint"
    WHERE
      "connamespace" = current_schema()::regnamespace AND
      "conname" IN (
        'dataset_snapshots_v2_pkey',
        'refs_v2_namespace_id_fkey',
        'evaluation_runs_v2_create_profile_check',
        'evaluation_runs_v2_deployment_shape_check',
        'evaluation_runs_v2_model_deployment_fkey'
      )
    ORDER BY "conname" COLLATE "C"
  `)
  return result.rows
}
