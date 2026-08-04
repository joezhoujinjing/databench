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

  await seedLegacyModelDeployment()
  const legacyDeploymentBefore = await legacyModelDeployment()
  await applyMigration('0018_model_version_deployments_v2')
  const legacyDeploymentAfter = await legacyModelDeployment()
  if (JSON.stringify(legacyDeploymentAfter) !== JSON.stringify(legacyDeploymentBefore)) {
    throw new Error('0018 changed pre-existing artifact-bound Deployment fields')
  }

  const deploymentProfile = await client.query(`
    SELECT
      "deployment_profile", "model_version_id", "connectivity_scope",
      "credential_ref", "declared_capabilities_json", "policy_generation",
      "credential_generation", "activated_at"
    FROM "model_deployments_v2"
    WHERE "id" = '40000000-0000-8000-8000-000000000001'::uuid
  `)
  const deploymentConstraints = await client.query(`
    SELECT "conname", pg_get_constraintdef("oid") AS "definition"
    FROM "pg_constraint"
    WHERE
      "connamespace" = current_schema()::regnamespace AND
      "conname" IN (
        'model_deployments_v2_profile_shape_check',
        'model_deployments_v2_lifecycle_check',
        'model_deployments_v2_model_version_fkey',
        'model_deployments_v2_version_artifact_fkey',
        'model_registration_claims_v2_deployment_fkey'
      )
    ORDER BY "conname" COLLATE "C"
  `)
  const deploymentTriggers = await client.query(`
    SELECT "tgname"
    FROM "pg_trigger"
    WHERE
      NOT "tgisinternal" AND
      "tgrelid" = 'model_deployments_v2'::regclass AND
      "tgname" = 'model_deployments_v2_source_binding_check'
  `)
  if (
    JSON.stringify(deploymentProfile.rows) !==
      JSON.stringify([
        {
          deployment_profile: 'artifact-bound-v1',
          model_version_id: null,
          connectivity_scope: null,
          credential_ref: null,
          declared_capabilities_json: null,
          policy_generation: null,
          credential_generation: null,
          activated_at: null,
        },
      ]) ||
    deploymentConstraints.rows.length !== 5 ||
    deploymentTriggers.rows.length !== 1
  ) {
    throw new Error('0018 did not preserve legacy rows and install the MR5 Deployment shape')
  }
  const deploymentDefinitions = deploymentConstraints.rows.map(({ definition }) => definition)
  if (
    !deploymentDefinitions.some((definition) =>
      definition.includes('FOREIGN KEY (namespace_id, model_version_id)'),
    ) ||
    !deploymentDefinitions.some((definition) =>
      definition.includes('FOREIGN KEY (namespace_id, model_version_id, artifact_id)'),
    ) ||
    !deploymentDefinitions.some((definition) =>
      definition.includes('FOREIGN KEY (namespace_id, deployment_id, deployment_digest)'),
    )
  ) {
    throw new Error('0018 Deployment and registration-claim exact FK columns have drifted')
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
        ...deploymentConstraints.rows.map(({ conname }) => conname),
        ...deploymentTriggers.rows.map(({ tgname }) => tgname),
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

async function seedLegacyModelDeployment() {
  const namespaceId = '11111111-1111-4111-8111-111111111111'
  const sessionId = '50000000-0000-8000-8000-000000000001'
  const importId = '60000000-0000-8000-8000-000000000001'
  const artifactId = '70000000-0000-8000-8000-000000000001'
  const archiveDigest = '6'.repeat(64)
  const manifest = {
    manifest_version: 'model-artifact-manifest-v1',
    artifact_kind: 'lora_adapter',
    artifact_format: 'swift-lora-adapter-v1',
    archive_format: 'deterministic-tar-zst-v1',
    archive_digest: archiveDigest,
    archive_size_bytes: 1,
    output_snapshot_digest: '7'.repeat(64),
    source: { studio_session_id: sessionId },
    dataset_lineage: {
      status: 'not_applicable',
      dataset_version: null,
      dataset_export_digest: null,
    },
    base_model: {
      reference: 'Qwen/Qwen3-0.6B',
      revision: 'abc123',
      binding_status: 'verified',
    },
  }
  await client.query('BEGIN')
  try {
    await client.query(
      `
        INSERT INTO "swift_studio_sessions_v2" (
          "id", "namespace_id", "create_digest", "status", "dataset_version",
          "display_ref", "converter", "converter_version", "normalized_options_json",
          "fidelity_digest", "export_output_count", "provider", "provider_session_id",
          "upstream_commit", "image_digest", "runtime_capability_digest",
          "preparation_owner_token"
        ) VALUES (
          $1::uuid, $2::uuid, $3, 'preparing', $4, 'main', 'ms-swift', '1.0.0',
          '{}'::jsonb, $5, 1, 'swift-studio', 'forward-session', $6, $7, $8,
          '80000000-0000-8000-8000-000000000001'::uuid
        )
      `,
      [
        sessionId,
        namespaceId,
        '8'.repeat(64),
        'a'.repeat(64),
        '9'.repeat(64),
        'a'.repeat(40),
        'b'.repeat(64),
        'c'.repeat(64),
      ],
    )
    await client.query(
      `
        INSERT INTO "model_artifact_imports_v2" (
          "id", "namespace_id", "create_digest", "status", "studio_session_id",
          "output_handle_digest", "artifact_kind", "display_name", "base_model_reference"
        ) VALUES (
          $1::uuid, $2::uuid, $3, 'requested', $4::uuid, $5, 'lora_adapter',
          'Forward Artifact', 'Qwen/Qwen3-0.6B'
        )
      `,
      [importId, namespaceId, 'd'.repeat(64), sessionId, 'e'.repeat(64)],
    )
    await client.query(
      `
        INSERT INTO "model_artifacts_v2" (
          "id", "namespace_id", "display_name", "artifact_kind", "artifact_format",
          "archive_format", "archive_digest", "archive_size_bytes", "object_locator",
          "manifest_digest", "manifest_json", "source_kind", "source_session_id",
          "source_import_id", "dataset_lineage_status", "base_model_reference",
          "base_model_revision", "base_model_binding_status", "upstream_commit", "image_digest"
        ) VALUES (
          $1::uuid, $2::uuid, 'Forward Artifact', 'lora_adapter',
          'swift-lora-adapter-v1', 'deterministic-tar-zst-v1', $3, 1,
          $4, $5, $6::jsonb, 'swift_studio_session', $7::uuid, $8::uuid,
          'not_applicable', 'Qwen/Qwen3-0.6B', 'abc123', 'verified', $9, $10
        )
      `,
      [
        artifactId,
        namespaceId,
        archiveDigest,
        `objects/v2/model-artifact-v1/${archiveDigest.slice(0, 2)}/${archiveDigest}.tar.zst`,
        'f'.repeat(64),
        JSON.stringify(manifest),
        sessionId,
        importId,
        'a'.repeat(40),
        'b'.repeat(64),
      ],
    )
    await client.query(
      `
        INSERT INTO "model_deployments_v2" (
          "id", "namespace_id", "create_digest", "artifact_id", "provider",
          "display_name", "served_model_name", "endpoint_base_url", "auth_mode", "status"
        ) VALUES (
          '40000000-0000-8000-8000-000000000001'::uuid, $1::uuid, $2, $3::uuid,
          'openai_compatible', 'Forward Legacy Deployment', 'forward-model',
          'http://model-service:8000/v1', 'none', 'active'
        )
      `,
      [namespaceId, '1'.repeat(64), artifactId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function legacyModelDeployment() {
  const result = await client.query(`
    SELECT
      "id"::text, "namespace_id"::text, "create_digest", "artifact_id"::text,
      "provider", "display_name", "served_model_name", "endpoint_base_url",
      "auth_mode", "status", "health_status", "health_checked_at", "health_error",
      "created_at", "disabled_at", "updated_at"
    FROM "model_deployments_v2"
    WHERE "id" = '40000000-0000-8000-8000-000000000001'::uuid
  `)
  return result.rows
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
