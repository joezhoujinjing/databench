CREATE TABLE "swift_studio_sessions_v2" (
  "id" UUID NOT NULL,
  "namespace_id" UUID NOT NULL,
  "create_digest" CHAR(64) NOT NULL,
  "status" TEXT NOT NULL,
  "dataset_version" CHAR(64) NOT NULL,
  "display_ref" TEXT,
  "converter" TEXT NOT NULL,
  "converter_version" TEXT NOT NULL,
  "normalized_options_json" JSONB NOT NULL,
  "fidelity_digest" CHAR(64) NOT NULL,
  "export_output_count" BIGINT NOT NULL,
  "export_digest" CHAR(64),
  "export_size_bytes" BIGINT,
  "provider" TEXT NOT NULL,
  "provider_session_id" TEXT NOT NULL,
  "upstream_commit" CHAR(40) NOT NULL,
  "image_digest" CHAR(64) NOT NULL,
  "runtime_capability_digest" CHAR(64) NOT NULL,
  "failure_json" JSONB,
  "preparation_owner_token" UUID NOT NULL,
  "preparation_abandoned_at" TIMESTAMPTZ(6),
  "preparation_expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '5 hours'),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ready_at" TIMESTAMPTZ(6),
  "closed_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "swift_studio_sessions_v2_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_swift_studio_sessions_v2_create_digest"
    UNIQUE ("namespace_id", "create_digest"),
  CONSTRAINT "uq_swift_studio_sessions_v2_provider_locator"
    UNIQUE ("provider", "provider_session_id"),
  CONSTRAINT "swift_studio_sessions_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "swift_studio_sessions_v2_dataset_fkey" FOREIGN KEY ("dataset_version")
    REFERENCES "dataset_snapshots_v2"("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "swift_studio_sessions_v2_status_check" CHECK (
    "status" IN ('preparing', 'ready', 'closing', 'closed', 'failed')
  ),
  CONSTRAINT "swift_studio_sessions_v2_digest_check" CHECK (
    "create_digest" ~ '^[0-9a-f]{64}$' AND
    "dataset_version" ~ '^[0-9a-f]{64}$' AND
    "fidelity_digest" ~ '^[0-9a-f]{64}$' AND
    ("export_digest" IS NULL OR "export_digest" ~ '^[0-9a-f]{64}$') AND
    "image_digest" ~ '^[0-9a-f]{64}$' AND
    "runtime_capability_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "swift_studio_sessions_v2_display_ref_check" CHECK (
    "display_ref" IS NULL OR (
      "display_ref" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' AND
      "display_ref" !~ '^[0-9a-f]{64}$' AND
      "display_ref" <> '.' AND
      "display_ref" <> '..'
    )
  ),
  CONSTRAINT "swift_studio_sessions_v2_runtime_check" CHECK (
    "converter" = 'ms-swift' AND
    "converter_version" = '1.0.0' AND
    "provider" = 'swift-studio' AND
    "upstream_commit" ~ '^[0-9a-f]{40}$' AND
    octet_length("provider_session_id") BETWEEN 1 AND 256 AND
    "provider_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$'
  ),
  CONSTRAINT "swift_studio_sessions_v2_export_bounds_check" CHECK (
    "export_output_count" > 0 AND
    ("export_size_bytes" IS NULL OR "export_size_bytes" >= 0)
  ),
  CONSTRAINT "swift_studio_sessions_v2_json_bounds_check" CHECK (
    jsonb_typeof("normalized_options_json") = 'object' AND
    octet_length("normalized_options_json"::text) <= 65536 AND
    ("failure_json" IS NULL OR (
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
        '$.** ? (@.type() == "string" && (@ like_regex "sk-(proj-)?[A-Za-z0-9_-]{8,}" flag "i" || @ like_regex "(authorization|x-api-key|api[_-]?key|token)[[:space:]]*[:=][[:space:]]*[^[:space:]]+" flag "i"))'
      )
    ))
  ),
  CONSTRAINT "swift_studio_sessions_v2_export_shape_check" CHECK (
    ("export_digest" IS NULL) = ("export_size_bytes" IS NULL)
  ),
  CONSTRAINT "swift_studio_sessions_v2_lifecycle_shape_check" CHECK (
    (("status" = 'failed') = ("failure_json" IS NOT NULL)) AND
    (("status" IN ('ready', 'closing', 'closed')) = (
      "ready_at" IS NOT NULL AND "export_digest" IS NOT NULL
    )) AND
    (("status" = 'closed') = ("closed_at" IS NOT NULL)) AND
    ("preparation_expires_at" >= "created_at") AND
    ("preparation_abandoned_at" IS NULL OR (
      "status" = 'preparing' AND "preparation_abandoned_at" >= "created_at"
    )) AND
    ("ready_at" IS NULL OR "ready_at" >= "created_at") AND
    ("closed_at" IS NULL OR ("ready_at" IS NOT NULL AND "closed_at" >= "ready_at"))
  )
);

CREATE UNIQUE INDEX "uq_swift_studio_sessions_v2_active_provider"
  ON "swift_studio_sessions_v2"("provider")
  WHERE "status" IN ('preparing', 'ready', 'closing');

CREATE INDEX "idx_swift_studio_sessions_v2_dataset"
  ON "swift_studio_sessions_v2"("namespace_id", "dataset_version", "created_at", "id");

CREATE INDEX "idx_swift_studio_sessions_v2_status"
  ON "swift_studio_sessions_v2"("namespace_id", "status", "created_at", "id");
