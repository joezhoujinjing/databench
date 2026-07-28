CREATE TABLE "model_artifact_imports_v2" (
  "id" UUID NOT NULL,
  "namespace_id" UUID NOT NULL,
  "create_digest" CHAR(64) NOT NULL,
  "status" TEXT NOT NULL,
  "studio_session_id" UUID NOT NULL,
  "output_handle_digest" CHAR(64) NOT NULL,
  "artifact_kind" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "base_model_reference" TEXT NOT NULL,
  "base_model_revision" TEXT,
  "provider_import_id" TEXT,
  "output_snapshot_digest" CHAR(64),
  "staging_object_key" TEXT,
  "archive_digest" CHAR(64),
  "archive_size_bytes" BIGINT,
  "manifest_digest" CHAR(64),
  "manifest_json" JSONB,
  "dataset_lineage_status" TEXT,
  "dataset_version" CHAR(64),
  "dataset_export_digest" CHAR(64),
  "base_model_binding_status" TEXT,
  "artifact_id" UUID,
  "failure_json" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "staging_at" TIMESTAMPTZ(6),
  "finalizing_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "failed_at" TIMESTAMPTZ(6),
  "staging_cleaned_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "model_artifact_imports_v2_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_model_artifact_imports_v2_create_digest"
    UNIQUE ("namespace_id", "create_digest"),
  CONSTRAINT "uq_model_artifact_imports_v2_output"
    UNIQUE ("namespace_id", "studio_session_id", "output_handle_digest", "artifact_kind"),
  CONSTRAINT "uq_model_artifact_imports_v2_provider_import" UNIQUE ("provider_import_id"),
  CONSTRAINT "uq_model_artifact_imports_v2_artifact" UNIQUE ("artifact_id"),
  CONSTRAINT "model_artifact_imports_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_artifact_imports_v2_session_fkey" FOREIGN KEY ("studio_session_id")
    REFERENCES "swift_studio_sessions_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_artifact_imports_v2_dataset_fkey" FOREIGN KEY ("dataset_version")
    REFERENCES "dataset_snapshots_v2"("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_artifact_imports_v2_status_check" CHECK (
    "status" IN ('requested', 'staging', 'finalizing', 'completed', 'failed')
  ),
  CONSTRAINT "model_artifact_imports_v2_identity_check" CHECK (
    "create_digest" ~ '^[0-9a-f]{64}$' AND
    "output_handle_digest" ~ '^[0-9a-f]{64}$' AND
    "artifact_kind" = 'lora_adapter'
  ),
  CONSTRAINT "model_artifact_imports_v2_text_check" CHECK (
    octet_length("display_name") BETWEEN 1 AND 256 AND
    "display_name" !~ '[[:cntrl:]]' AND
    "display_name" !~ '^(\/|\\\\|[A-Za-z]:[\\/]|file:|\\.\\.?[\\/]|~[\\/])' AND
    octet_length("base_model_reference") BETWEEN 1 AND 512 AND
    "base_model_reference" !~ '[[:cntrl:]\\\\]' AND
    "base_model_reference" !~ '^(\/|[A-Za-z]:[\\/]|file:|\\.\\.?[\\/]|~[\\/])' AND
    ("base_model_revision" IS NULL OR (
      octet_length("base_model_revision") BETWEEN 1 AND 256 AND
      "base_model_revision" ~ '^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,255}$'
    )) AND
    NOT (
      "display_name" ~* 'sk-(proj-)?[A-Za-z0-9_-]{8,}' OR
      "display_name" ~* '(authorization|x-api-key|api[_-]?key|token)[[:space:]]*[:=]' OR
      "base_model_reference" ~* 'sk-(proj-)?[A-Za-z0-9_-]{8,}' OR
      "base_model_reference" ~* '(authorization|x-api-key|api[_-]?key|token)[[:space:]]*[:=]'
    )
  ),
  CONSTRAINT "model_artifact_imports_v2_provider_check" CHECK (
    "provider_import_id" IS NULL OR
    "provider_import_id" ~ '^swai_[A-Za-z0-9_-]{16,128}$'
  ),
  CONSTRAINT "model_artifact_imports_v2_digest_check" CHECK (
    ("output_snapshot_digest" IS NULL OR "output_snapshot_digest" ~ '^[0-9a-f]{64}$') AND
    ("archive_digest" IS NULL OR "archive_digest" ~ '^[0-9a-f]{64}$') AND
    ("manifest_digest" IS NULL OR "manifest_digest" ~ '^[0-9a-f]{64}$') AND
    ("dataset_version" IS NULL OR "dataset_version" ~ '^[0-9a-f]{64}$') AND
    ("dataset_export_digest" IS NULL OR "dataset_export_digest" ~ '^[0-9a-f]{64}$') AND
    ("archive_size_bytes" IS NULL OR "archive_size_bytes" >= 0)
  ),
  CONSTRAINT "model_artifact_imports_v2_enum_check" CHECK (
    ("dataset_lineage_status" IS NULL OR "dataset_lineage_status" IN (
      'verified', 'external_or_unverified', 'not_applicable'
    )) AND
    ("base_model_binding_status" IS NULL OR "base_model_binding_status" IN (
      'verified', 'declared', 'unresolved'
    )) AND
    NOT ("base_model_binding_status" = 'verified' AND "base_model_revision" IS NULL)
  ),
  CONSTRAINT "model_artifact_imports_v2_staging_key_check" CHECK (
    "staging_object_key" IS NULL OR
    "staging_object_key" =
      'staging/swift-artifact/v1/' || "id"::text || '/archive.tar.zst'
  ),
  CONSTRAINT "model_artifact_imports_v2_failure_check" CHECK (
    "failure_json" IS NULL OR (
      jsonb_typeof("failure_json") = 'object' AND
      octet_length("failure_json"::text) <= 4096 AND
      jsonb_typeof("failure_json"->'phase') = 'string' AND
      jsonb_typeof("failure_json"->'code') = 'string' AND
      jsonb_typeof("failure_json"->'message') = 'string' AND
      ("failure_json"->>'phase') ~ '^[a-z][a-z0-9._-]{0,127}$' AND
      ("failure_json"->>'code') ~ '^[a-z][a-z0-9._-]{0,127}$' AND
      octet_length("failure_json"->>'message') BETWEEN 1 AND 2048 AND
      ("failure_json"->>'message') !~ '[[:cntrl:]]' AND
      NOT jsonb_path_exists(
        "failure_json",
        '$.keyvalue() ? (@.key != "phase" && @.key != "code" && @.key != "message")'
      ) AND
      NOT jsonb_path_exists(
        "failure_json",
        '$.** ? (@.type() == "string" && (@ like_regex "sk-(proj-)?[A-Za-z0-9_-]{8,}" flag "i" || @ like_regex "(authorization|x-api-key|api[_-]?key|token)[[:space:]]*[:=]" flag "i"))'
      )
    )
  ),
  CONSTRAINT "model_artifact_imports_v2_manifest_check" CHECK (
    "manifest_json" IS NULL OR (
      jsonb_typeof("manifest_json") = 'object' AND
      octet_length("manifest_json"::text) <= 262144 AND
      "manifest_json"->>'manifest_version' = 'model-artifact-manifest-v1' AND
      "manifest_json"->>'artifact_kind' = 'lora_adapter' AND
      "manifest_json"->>'artifact_format' = 'swift-lora-adapter-v1' AND
      "manifest_json"->>'archive_format' = 'deterministic-tar-zst-v1' AND
      "manifest_json"->>'archive_digest' = "archive_digest" AND
      "manifest_json"->'archive_size_bytes' = to_jsonb("archive_size_bytes") AND
      "manifest_json"->>'output_snapshot_digest' = "output_snapshot_digest" AND
      "manifest_json"#>>'{source,studio_session_id}' = "studio_session_id"::text AND
      "manifest_json"#>>'{dataset_lineage,status}' = "dataset_lineage_status" AND
      "manifest_json"#>>'{dataset_lineage,dataset_version}' IS NOT DISTINCT FROM "dataset_version" AND
      "manifest_json"#>>'{dataset_lineage,dataset_export_digest}' IS NOT DISTINCT FROM "dataset_export_digest" AND
      "manifest_json"#>>'{base_model,reference}' = "base_model_reference" AND
      "manifest_json"#>>'{base_model,revision}' IS NOT DISTINCT FROM "base_model_revision" AND
      "manifest_json"#>>'{base_model,binding_status}' = "base_model_binding_status" AND
      NOT jsonb_path_exists(
        "manifest_json",
        '$.** ? (@.type() == "string" && (@ like_regex "sk-(proj-)?[A-Za-z0-9_-]{8,}" flag "i" || @ like_regex "(authorization|x-api-key|api[_-]?key|token)[[:space:]]*[:=]" flag "i"))'
      ) AND
      NOT jsonb_path_exists(
        "manifest_json",
        '$.** ? (@.type() == "string" && (@ like_regex "^(\\/|\\\\|[A-Za-z]:[\\\\/]|file:|\\.\\.?[\\\\/]|~[\\\\/])" flag "i"))'
      )
    )
  ),
  CONSTRAINT "model_artifact_imports_v2_lineage_shape_check" CHECK (
    (("dataset_lineage_status" = 'verified') = (
      "dataset_version" IS NOT NULL AND "dataset_export_digest" IS NOT NULL
    )) AND
    ("dataset_lineage_status" = 'verified' OR (
      "dataset_version" IS NULL AND "dataset_export_digest" IS NULL
    ))
  ),
  CONSTRAINT "model_artifact_imports_v2_lifecycle_check" CHECK (
    (("staging_at" IS NULL) = ("output_snapshot_digest" IS NULL)) AND
    (
      ("finalizing_at" IS NULL AND "staging_object_key" IS NULL AND
       "archive_digest" IS NULL AND "archive_size_bytes" IS NULL AND
       "manifest_digest" IS NULL AND "manifest_json" IS NULL AND
       "dataset_lineage_status" IS NULL AND "base_model_binding_status" IS NULL)
      OR
      ("finalizing_at" IS NOT NULL AND "staging_at" IS NOT NULL AND
       "staging_object_key" IS NOT NULL AND "archive_digest" IS NOT NULL AND
       "archive_size_bytes" IS NOT NULL AND "manifest_digest" IS NOT NULL AND
       "manifest_json" IS NOT NULL AND "dataset_lineage_status" IS NOT NULL AND
       "base_model_binding_status" IS NOT NULL)
    ) AND
    (
      ("status" = 'requested' AND "provider_import_id" IS NULL AND
       "staging_at" IS NULL AND "finalizing_at" IS NULL AND
       "artifact_id" IS NULL AND "failure_json" IS NULL AND
       "completed_at" IS NULL AND "failed_at" IS NULL)
      OR
      ("status" = 'staging' AND "provider_import_id" IS NOT NULL AND
       "staging_at" IS NOT NULL AND "finalizing_at" IS NULL AND
       "artifact_id" IS NULL AND "failure_json" IS NULL AND
       "completed_at" IS NULL AND "failed_at" IS NULL)
      OR
      ("status" = 'finalizing' AND "provider_import_id" IS NOT NULL AND
       "finalizing_at" IS NOT NULL AND "artifact_id" IS NULL AND
       "failure_json" IS NULL AND "completed_at" IS NULL AND "failed_at" IS NULL)
      OR
      ("status" = 'completed' AND "provider_import_id" IS NOT NULL AND
       "finalizing_at" IS NOT NULL AND "artifact_id" IS NOT NULL AND
       "failure_json" IS NULL AND "completed_at" IS NOT NULL AND "failed_at" IS NULL)
      OR
      ("status" = 'failed' AND "artifact_id" IS NULL AND
       "failure_json" IS NOT NULL AND "completed_at" IS NULL AND "failed_at" IS NOT NULL)
    ) AND
    ("staging_at" IS NULL OR "staging_at" >= "created_at") AND
    ("finalizing_at" IS NULL OR "finalizing_at" >= "staging_at") AND
    ("completed_at" IS NULL OR "completed_at" >= "finalizing_at") AND
    ("failed_at" IS NULL OR "failed_at" >= "created_at") AND
    (
      "staging_cleaned_at" IS NULL OR
      ("status" IN ('completed', 'failed') AND
       "staging_cleaned_at" >= COALESCE("completed_at", "failed_at"))
    )
  )
);

CREATE TABLE "model_artifacts_v2" (
  "id" UUID NOT NULL,
  "namespace_id" UUID NOT NULL,
  "display_name" TEXT NOT NULL,
  "artifact_kind" TEXT NOT NULL,
  "artifact_format" TEXT NOT NULL,
  "archive_format" TEXT NOT NULL,
  "archive_digest" CHAR(64) NOT NULL,
  "archive_size_bytes" BIGINT NOT NULL,
  "object_locator" TEXT NOT NULL,
  "manifest_digest" CHAR(64) NOT NULL,
  "manifest_json" JSONB NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_session_id" UUID NOT NULL,
  "source_import_id" UUID NOT NULL,
  "dataset_lineage_status" TEXT NOT NULL,
  "dataset_version" CHAR(64),
  "dataset_export_digest" CHAR(64),
  "base_model_reference" TEXT NOT NULL,
  "base_model_revision" TEXT,
  "base_model_binding_status" TEXT NOT NULL,
  "upstream_commit" CHAR(40) NOT NULL,
  "image_digest" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "model_artifacts_v2_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_model_artifacts_v2_source_import" UNIQUE ("source_import_id"),
  CONSTRAINT "model_artifacts_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_artifacts_v2_session_fkey" FOREIGN KEY ("source_session_id")
    REFERENCES "swift_studio_sessions_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_artifacts_v2_import_fkey" FOREIGN KEY ("source_import_id")
    REFERENCES "model_artifact_imports_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_artifacts_v2_dataset_fkey" FOREIGN KEY ("dataset_version")
    REFERENCES "dataset_snapshots_v2"("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_artifacts_v2_fixed_format_check" CHECK (
    "artifact_kind" = 'lora_adapter' AND
    "artifact_format" = 'swift-lora-adapter-v1' AND
    "archive_format" = 'deterministic-tar-zst-v1' AND
    "source_kind" = 'swift_studio_session'
  ),
  CONSTRAINT "model_artifacts_v2_digest_check" CHECK (
    "archive_digest" ~ '^[0-9a-f]{64}$' AND
    "archive_size_bytes" >= 0 AND
    "manifest_digest" ~ '^[0-9a-f]{64}$' AND
    ("dataset_version" IS NULL OR "dataset_version" ~ '^[0-9a-f]{64}$') AND
    ("dataset_export_digest" IS NULL OR "dataset_export_digest" ~ '^[0-9a-f]{64}$') AND
    "upstream_commit" ~ '^[0-9a-f]{40}$' AND
    "image_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "model_artifacts_v2_object_locator_check" CHECK (
    "object_locator" =
      'objects/v2/model-artifact-v1/' || substring("archive_digest" from 1 for 2) ||
      '/' || "archive_digest" || '.tar.zst'
  ),
  CONSTRAINT "model_artifacts_v2_lineage_check" CHECK (
    "dataset_lineage_status" IN (
      'verified', 'external_or_unverified', 'not_applicable'
    ) AND
    (("dataset_lineage_status" = 'verified') = (
      "dataset_version" IS NOT NULL AND "dataset_export_digest" IS NOT NULL
    )) AND
    ("dataset_lineage_status" = 'verified' OR (
      "dataset_version" IS NULL AND "dataset_export_digest" IS NULL
    ))
  ),
  CONSTRAINT "model_artifacts_v2_base_model_check" CHECK (
    "base_model_binding_status" IN ('verified', 'declared', 'unresolved') AND
    NOT ("base_model_binding_status" = 'verified' AND "base_model_revision" IS NULL) AND
    octet_length("base_model_reference") BETWEEN 1 AND 512 AND
    "base_model_reference" !~ '[[:cntrl:]\\\\]' AND
    "base_model_reference" !~ '^(\/|[A-Za-z]:[\\/]|file:|\\.\\.?[\\/]|~[\\/])' AND
    ("base_model_revision" IS NULL OR (
      octet_length("base_model_revision") BETWEEN 1 AND 256 AND
      "base_model_revision" ~ '^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,255}$'
    ))
  ),
  CONSTRAINT "model_artifacts_v2_display_name_check" CHECK (
    octet_length("display_name") BETWEEN 1 AND 256 AND
    "display_name" !~ '[[:cntrl:]]' AND
    "display_name" !~ '^(\/|\\\\|[A-Za-z]:[\\/]|file:|\\.\\.?[\\/]|~[\\/])'
  ),
  CONSTRAINT "model_artifacts_v2_manifest_check" CHECK (
    jsonb_typeof("manifest_json") = 'object' AND
    octet_length("manifest_json"::text) <= 262144 AND
    "manifest_json"->>'manifest_version' = 'model-artifact-manifest-v1' AND
    "manifest_json"->>'artifact_kind' = "artifact_kind" AND
    "manifest_json"->>'artifact_format' = "artifact_format" AND
    "manifest_json"->>'archive_format' = "archive_format" AND
    "manifest_json"->>'archive_digest' = "archive_digest" AND
    "manifest_json"->'archive_size_bytes' = to_jsonb("archive_size_bytes") AND
    "manifest_json"#>>'{source,studio_session_id}' = "source_session_id"::text AND
    "manifest_json"#>>'{source,upstream_commit}' = "upstream_commit" AND
    "manifest_json"#>>'{source,image_digest}' = "image_digest" AND
    "manifest_json"#>>'{dataset_lineage,status}' = "dataset_lineage_status" AND
    "manifest_json"#>>'{dataset_lineage,dataset_version}' IS NOT DISTINCT FROM "dataset_version" AND
    "manifest_json"#>>'{dataset_lineage,dataset_export_digest}' IS NOT DISTINCT FROM "dataset_export_digest" AND
    "manifest_json"#>>'{base_model,reference}' = "base_model_reference" AND
    "manifest_json"#>>'{base_model,revision}' IS NOT DISTINCT FROM "base_model_revision" AND
    "manifest_json"#>>'{base_model,binding_status}' = "base_model_binding_status" AND
    NOT jsonb_path_exists(
      "manifest_json",
      '$.** ? (@.type() == "string" && (@ like_regex "sk-(proj-)?[A-Za-z0-9_-]{8,}" flag "i" || @ like_regex "(authorization|x-api-key|api[_-]?key|token)[[:space:]]*[:=]" flag "i"))'
    ) AND
    NOT jsonb_path_exists(
      "manifest_json",
      '$.** ? (@.type() == "string" && (@ like_regex "^(\\/|\\\\|[A-Za-z]:[\\\\/]|file:|\\.\\.?[\\\\/]|~[\\\\/])" flag "i"))'
    )
  )
);

CREATE INDEX "idx_model_artifact_imports_v2_status"
  ON "model_artifact_imports_v2"("namespace_id", "status", "created_at", "id");

CREATE INDEX "idx_model_artifact_imports_v2_session"
  ON "model_artifact_imports_v2"("studio_session_id", "created_at", "id");

CREATE INDEX "idx_model_artifacts_v2_created"
  ON "model_artifacts_v2"("namespace_id", "created_at", "id");

CREATE INDEX "idx_model_artifacts_v2_archive_digest"
  ON "model_artifacts_v2"("namespace_id", "archive_digest");

CREATE INDEX "idx_model_artifacts_v2_dataset"
  ON "model_artifacts_v2"("namespace_id", "dataset_version", "created_at", "id");
