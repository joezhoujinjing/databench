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

  await applyMigration('0016_model_registry_artifact_product_v2')

  const rowsAfterMr2 = await legacyRows()
  const constraintsAfterMr2 = await legacyConstraints()
  if (JSON.stringify(rowsAfterMr2) !== JSON.stringify(rowsBefore)) {
    throw new Error('0016 changed pre-existing S4 rows')
  }
  if (JSON.stringify(constraintsAfterMr2) !== JSON.stringify(constraintsBefore)) {
    throw new Error('0016 changed pre-existing S4 constraints')
  }

  const adoptionTables = await client.query(`
    SELECT "table_name"
    FROM "information_schema"."tables"
    WHERE
      "table_schema" = current_schema() AND
      "table_name" = 'model_version_deployment_adoptions_v2'
  `)
  const adoptionConstraints = await client.query(`
    SELECT "conname", pg_get_constraintdef("oid") AS "definition"
    FROM "pg_constraint"
    WHERE
      "connamespace" = current_schema()::regnamespace AND
      "conname" IN (
        'model_version_deployment_adoptions_v2_version_fkey',
        'model_version_deployment_adoptions_v2_artifact_source_fkey',
        'model_version_deployment_adoptions_v2_deployment_fkey'
      )
    ORDER BY "conname" COLLATE "C"
  `)
  const adoptionTriggers = await client.query(`
    SELECT "tgname"
    FROM "pg_trigger"
    WHERE
      NOT "tgisinternal" AND
      "tgrelid" = 'model_version_deployment_adoptions_v2'::regclass AND
      "tgname" = 'model_version_deployment_adoptions_v2_append_only'
  `)
  if (
    adoptionTables.rows.length !== 1 ||
    adoptionConstraints.rows.length !== 3 ||
    adoptionTriggers.rows.length !== 1
  ) {
    throw new Error('0016 did not create the adoption table, exact FKs, and append-only trigger')
  }

  const adoptionDefinitions = adoptionConstraints.rows.map(({ definition }) => definition)
  if (
    !adoptionDefinitions.some((definition) =>
      definition.includes('FOREIGN KEY (namespace_id, model_id, model_version_id)'),
    ) ||
    !adoptionDefinitions.some((definition) =>
      definition.includes('FOREIGN KEY (namespace_id, model_version_id, artifact_id)'),
    ) ||
    !adoptionDefinitions.some((definition) =>
      definition.includes(
        'FOREIGN KEY (namespace_id, deployment_id, artifact_id, deployment_digest)',
      ),
    )
  ) {
    throw new Error('0016 adoption composite FK columns do not match the accepted design')
  }

  await seedMr2Evidence()
  await applyMigration('0017_model_repository_evidence_v2')

  const rowsAfterMr3 = await legacyRows()
  const constraintsAfterMr3 = await legacyConstraints()
  if (JSON.stringify(rowsAfterMr3) !== JSON.stringify(rowsBefore)) {
    throw new Error('0017 changed pre-existing S4 rows')
  }
  if (JSON.stringify(constraintsAfterMr3) !== JSON.stringify(constraintsBefore)) {
    throw new Error('0017 changed pre-existing S4 constraints')
  }
  const evidenceShape = await client.query(`
    SELECT pg_get_constraintdef("oid") AS "definition"
    FROM "pg_constraint"
    WHERE
      "connamespace" = current_schema()::regnamespace AND
      "conname" = 'model_source_evidence_v2_shape_check'
  `)
  const evidenceColumns = await client.query(`
    SELECT "column_name", "column_default", "is_nullable"
    FROM "information_schema"."columns"
    WHERE
      "table_schema" = current_schema() AND
      "table_name" = 'model_source_evidence_v2' AND
      "column_name" IN ('license', 'cache_status')
    ORDER BY "column_name" COLLATE "C"
  `)
  const preservedEvidence = await client.query(`
    SELECT "result", "license", "cache_status"
    FROM "model_source_evidence_v2"
    WHERE "id" = '30000000-0000-8000-8000-000000000001'::uuid
  `)
  const evidenceDefinition = evidenceShape.rows[0]?.definition ?? ''
  if (
    evidenceShape.rows.length !== 1 ||
    evidenceColumns.rows.length !== 2 ||
    evidenceColumns.rows.some(({ column_name: columnName, column_default: columnDefault }) =>
      columnName === 'cache_status' ? columnDefault !== null : false,
    ) ||
    !evidenceDefinition.includes('revision_mismatch') ||
    !evidenceDefinition.includes('cache_status') ||
    !evidenceDefinition.includes('license') ||
    JSON.stringify(preservedEvidence.rows) !==
      JSON.stringify([{ result: 'verified', license: null, cache_status: 'unknown' }])
  ) {
    throw new Error('0017 did not preserve and extend Model source evidence as designed')
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
        ...adoptionConstraints.rows.map(({ conname }) => conname),
        ...adoptionTriggers.rows.map(({ tgname }) => tgname),
        ...evidenceShape.rows.map(() => 'model_source_evidence_v2_shape_check'),
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

async function seedMr2Evidence() {
  const namespaceId = '11111111-1111-4111-8111-111111111111'
  await client.query('BEGIN')
  try {
    await client.query(
      `
        INSERT INTO "models_v2" (
          "id", "namespace_id", "key", "create_profile", "create_digest",
          "display_name", "description", "tags_json"
        ) VALUES (
          '10000000-0000-8000-8000-000000000001'::uuid, $1::uuid,
          'forward-model', 'model-create-v1', $2, 'Forward Model', '', '[]'::jsonb
        )
      `,
      [namespaceId, '1'.repeat(64)],
    )
    await client.query(
      `
        INSERT INTO "model_versions_v2" (
          "id", "namespace_id", "model_id", "version_label", "source_kind",
          "create_profile", "create_digest", "source_fingerprint"
        ) VALUES (
          '20000000-0000-8000-8000-000000000001'::uuid, $1::uuid,
          '10000000-0000-8000-8000-000000000001'::uuid, 'r1',
          'repository_reference', 'model-version-create-repository-v1', $2, $3
        )
      `,
      [namespaceId, '2'.repeat(64), '3'.repeat(64)],
    )
    await client.query(
      `
        INSERT INTO "model_version_repository_sources_v2" (
          "namespace_id", "model_version_id", "provider", "repository_id",
          "revision", "revision_kind"
        ) VALUES (
          $1::uuid, '20000000-0000-8000-8000-000000000001'::uuid,
          'modelscope', 'Qwen/Qwen3-0.6B', 'abc123', 'commit'
        )
      `,
      [namespaceId],
    )
    await client.query(
      `
        INSERT INTO "model_source_evidence_v2" (
          "id", "namespace_id", "model_version_id", "evidence_profile",
          "evidence_digest", "evidence_kind", "adapter", "adapter_version",
          "observed_revision", "observed_at", "result", "response_digest"
        ) VALUES (
          '30000000-0000-8000-8000-000000000001'::uuid, $1::uuid,
          '20000000-0000-8000-8000-000000000001'::uuid,
          'model-source-evidence-v1', $2, 'provider_resolution', 'modelscope', '1',
          'abc123', '2026-08-04T12:00:00.000Z'::timestamptz, 'verified', $3
        )
      `,
      [namespaceId, '4'.repeat(64), '5'.repeat(64)],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
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
