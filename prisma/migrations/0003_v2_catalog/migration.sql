CREATE TABLE "identity_namespaces_v2" (
  "id" UUID PRIMARY KEY,
  "scope" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_namespaces_v2_scope_check" CHECK ("scope" = 'default')
);

CREATE TABLE "identity_claims_v2" (
  "namespace_id" UUID NOT NULL,
  "entity_kind" TEXT NOT NULL,
  "claim_key_digest" CHAR(64) NOT NULL,
  "claim_profile" TEXT NOT NULL,
  "request_profile" TEXT NOT NULL,
  "creation_profile" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "request_digest" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_claims_v2_pkey" PRIMARY KEY ("namespace_id", "entity_kind", "claim_key_digest"),
  CONSTRAINT "uq_identity_claims_v2_entity" UNIQUE ("namespace_id", "entity_id"),
  CONSTRAINT "identity_claims_v2_namespace_id_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "identity_claims_v2_claim_key_digest_check" CHECK ("claim_key_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "identity_claims_v2_request_digest_check" CHECK ("request_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "identity_claims_v2_claim_profile_check" CHECK ("claim_profile" = 'databench-identity-claim-v1'),
  CONSTRAINT "identity_claims_v2_request_profile_check" CHECK ("request_profile" = 'databench-identity-request-v1'),
  CONSTRAINT "identity_claims_v2_creation_profile_check" CHECK (
    "creation_profile" IN (
      'source-root-v1',
      'artifact-row-v1',
      'direct-root-v1',
      'derived-record-v1',
      'candidate-v1',
      'signal-event-v1',
      'preference-event-v1'
    )
  ),
  CONSTRAINT "identity_claims_v2_kind_profile_check" CHECK (
    ("entity_kind" = 'record' AND "creation_profile" IN ('source-root-v1', 'artifact-row-v1', 'direct-root-v1', 'derived-record-v1')) OR
    ("entity_kind" = 'candidate' AND "creation_profile" = 'candidate-v1') OR
    ("entity_kind" = 'signal' AND "creation_profile" = 'signal-event-v1') OR
    ("entity_kind" = 'preference' AND "creation_profile" = 'preference-event-v1')
  ),
  CONSTRAINT "identity_claims_v2_kind_id_check" CHECK (
    ("entity_kind" = 'record' AND "entity_id" ~ '^rec_[0-9a-f]{64}$') OR
    ("entity_kind" = 'candidate' AND "entity_id" ~ '^cand_[0-9a-f]{64}$') OR
    ("entity_kind" = 'signal' AND "entity_id" ~ '^sig_[0-9a-f]{64}$') OR
    ("entity_kind" = 'preference' AND "entity_id" ~ '^pref_[0-9a-f]{64}$')
  )
);

CREATE TABLE "dataset_snapshots_v2" (
  "version" CHAR(64) PRIMARY KEY,
  "identity_profile" TEXT NOT NULL,
  "record_schema_version" TEXT NOT NULL,
  "num_records" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dataset_snapshots_v2_version_check" CHECK ("version" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "dataset_snapshots_v2_num_records_check" CHECK ("num_records" >= 0)
);

CREATE TABLE "dataset_layouts_v2" (
  "dataset_version" CHAR(64) NOT NULL,
  "layout_version" TEXT NOT NULL,
  "artifact_digest" CHAR(64) NOT NULL,
  "artifact_size_bytes" BIGINT NOT NULL,
  "manifest_key" TEXT NOT NULL,
  "columns_json" JSONB NOT NULL,
  "committed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dataset_layouts_v2_pkey" PRIMARY KEY ("dataset_version", "layout_version"),
  CONSTRAINT "uq_dataset_layouts_v2_manifest_key" UNIQUE ("manifest_key"),
  CONSTRAINT "dataset_layouts_v2_dataset_version_fkey" FOREIGN KEY ("dataset_version")
    REFERENCES "dataset_snapshots_v2" ("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "dataset_layouts_v2_dataset_version_check" CHECK ("dataset_version" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "dataset_layouts_v2_layout_version_check" CHECK ("layout_version" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT "dataset_layouts_v2_artifact_digest_check" CHECK ("artifact_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "dataset_layouts_v2_artifact_size_check" CHECK ("artifact_size_bytes" >= 0),
  CONSTRAINT "dataset_layouts_v2_columns_check" CHECK (jsonb_typeof("columns_json") = 'array')
);

CREATE TABLE "runs_v2" (
  "id" CHAR(68) NOT NULL UNIQUE,
  "cache_key" CHAR(64) PRIMARY KEY,
  "op" TEXT NOT NULL,
  "op_version" TEXT NOT NULL,
  "params_json" JSONB NOT NULL,
  "output_version" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runs_v2_output_version_fkey" FOREIGN KEY ("output_version")
    REFERENCES "dataset_snapshots_v2" ("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "runs_v2_cache_key_check" CHECK ("cache_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "runs_v2_output_version_check" CHECK ("output_version" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "runs_v2_id_format_check" CHECK ("id" ~ '^run_[0-9a-f]{64}$'),
  CONSTRAINT "runs_v2_id_check" CHECK ("id" = 'run_' || "cache_key"),
  CONSTRAINT "runs_v2_params_check" CHECK (jsonb_typeof("params_json") = 'object')
);

CREATE INDEX "idx_runs_v2_output" ON "runs_v2" ("output_version");

CREATE TABLE "run_inputs_v2" (
  "cache_key" CHAR(64) NOT NULL,
  "position" INTEGER NOT NULL,
  "dataset_version" CHAR(64) NOT NULL,
  CONSTRAINT "run_inputs_v2_pkey" PRIMARY KEY ("cache_key", "position"),
  CONSTRAINT "run_inputs_v2_cache_key_fkey" FOREIGN KEY ("cache_key")
    REFERENCES "runs_v2" ("cache_key") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "run_inputs_v2_dataset_version_fkey" FOREIGN KEY ("dataset_version")
    REFERENCES "dataset_snapshots_v2" ("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "run_inputs_v2_cache_key_check" CHECK ("cache_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "run_inputs_v2_dataset_version_check" CHECK ("dataset_version" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "run_inputs_v2_position_check" CHECK ("position" >= 0)
);

CREATE INDEX "idx_run_inputs_v2_dataset" ON "run_inputs_v2" ("dataset_version");

CREATE TABLE "record_revision_locations_v2" (
  "record_id" CHAR(68) NOT NULL,
  "record_digest" CHAR(64) NOT NULL,
  "dataset_version" CHAR(64) NOT NULL,
  CONSTRAINT "record_revision_locations_v2_pkey" PRIMARY KEY ("record_id", "record_digest"),
  CONSTRAINT "record_revision_locations_v2_dataset_version_fkey" FOREIGN KEY ("dataset_version")
    REFERENCES "dataset_snapshots_v2" ("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "record_revision_locations_v2_record_id_check" CHECK ("record_id" ~ '^rec_[0-9a-f]{64}$'),
  CONSTRAINT "record_revision_locations_v2_record_digest_check" CHECK ("record_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "record_revision_locations_v2_dataset_version_check" CHECK ("dataset_version" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "idx_record_revision_locations_v2_dataset"
  ON "record_revision_locations_v2" ("dataset_version");

CREATE TABLE "record_parent_edges_v2" (
  "child_record_id" CHAR(68) NOT NULL,
  "child_record_digest" CHAR(64) NOT NULL,
  "position" INTEGER NOT NULL,
  "parent_record_id" CHAR(68) NOT NULL,
  "parent_record_digest" CHAR(64) NOT NULL,
  CONSTRAINT "record_parent_edges_v2_pkey" PRIMARY KEY ("child_record_id", "child_record_digest", "position"),
  CONSTRAINT "uq_record_parent_edges_v2_parent_id" UNIQUE ("child_record_id", "child_record_digest", "parent_record_id"),
  CONSTRAINT "record_parent_edges_v2_child_fkey" FOREIGN KEY ("child_record_id", "child_record_digest")
    REFERENCES "record_revision_locations_v2" ("record_id", "record_digest") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "record_parent_edges_v2_child_id_check" CHECK ("child_record_id" ~ '^rec_[0-9a-f]{64}$'),
  CONSTRAINT "record_parent_edges_v2_child_digest_check" CHECK ("child_record_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "record_parent_edges_v2_parent_id_check" CHECK ("parent_record_id" ~ '^rec_[0-9a-f]{64}$'),
  CONSTRAINT "record_parent_edges_v2_parent_digest_check" CHECK ("parent_record_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "record_parent_edges_v2_position_check" CHECK ("position" >= 0),
  CONSTRAINT "record_parent_edges_v2_no_self_id_check" CHECK ("child_record_id" <> "parent_record_id")
);

CREATE INDEX "idx_record_parent_edges_v2_parent"
  ON "record_parent_edges_v2" ("parent_record_id", "parent_record_digest");

CREATE TABLE "refs_v2" (
  "namespace_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "version" CHAR(64) NOT NULL,
  "message" TEXT,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refs_v2_pkey" PRIMARY KEY ("namespace_id", "name"),
  CONSTRAINT "refs_v2_namespace_id_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "refs_v2_version_fkey" FOREIGN KEY ("version")
    REFERENCES "dataset_snapshots_v2" ("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "refs_v2_name_check" CHECK (
    "name" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' AND
    "name" !~ '^[0-9a-f]{64}$' AND
    "name" <> '.' AND
    "name" <> '..'
  ),
  CONSTRAINT "refs_v2_version_check" CHECK ("version" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "idx_refs_v2_version" ON "refs_v2" ("version");
CREATE INDEX "idx_refs_v2_seek" ON "refs_v2" ("namespace_id", "name" COLLATE "C");
