CREATE TABLE "transform_jobs_v2" (
  "id" CHAR(68) NOT NULL,
  "cache_key" CHAR(64) NOT NULL,
  "op" TEXT NOT NULL,
  "op_version" TEXT NOT NULL,
  "params_json" JSONB NOT NULL,
  "input_version" CHAR(64) NOT NULL,
  "capability_name" TEXT NOT NULL,
  "capability_version" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "lease_owner" TEXT,
  "lease_token" BYTEA,
  "lease_expires_at" TIMESTAMPTZ(6),
  "progress_json" JSONB,
  "input_key" TEXT,
  "output_key" TEXT,
  "input_count" BIGINT NOT NULL,
  "output_count" BIGINT,
  "output_version" CHAR(64),
  "cache_hit" BOOLEAN NOT NULL DEFAULT false,
  "error_json" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "transform_jobs_v2_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transform_jobs_v2_cache_key_key" UNIQUE ("cache_key"),
  CONSTRAINT "transform_jobs_v2_input_fkey" FOREIGN KEY ("input_version")
    REFERENCES "dataset_snapshots_v2"("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "transform_jobs_v2_output_fkey" FOREIGN KEY ("output_version")
    REFERENCES "dataset_snapshots_v2"("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "transform_jobs_v2_status_check" CHECK (
    "status" IN ('queued', 'leased', 'running', 'finalizing', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT "transform_jobs_v2_identity_check" CHECK (
    "cache_key" ~ '^[0-9a-f]{64}$' AND
    "id" = 'job_' || "cache_key" AND
    "input_version" ~ '^[0-9a-f]{64}$' AND
    ("output_version" IS NULL OR "output_version" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "transform_jobs_v2_names_check" CHECK (
    "op" ~ '^[a-z][a-z0-9._-]{0,127}$' AND
    "op_version" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' AND
    "capability_name" ~ '^[a-z][a-z0-9._-]{0,127}$' AND
    "capability_version" ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
  ),
  CONSTRAINT "transform_jobs_v2_json_bounds_check" CHECK (
    jsonb_typeof("params_json") = 'object' AND
    octet_length("params_json"::text) <= 16384 AND
    ("progress_json" IS NULL OR octet_length("progress_json"::text) <= 16384) AND
    ("error_json" IS NULL OR octet_length("error_json"::text) <= 16384)
  ),
  CONSTRAINT "transform_jobs_v2_attempt_check" CHECK ("attempt" >= 0),
  CONSTRAINT "transform_jobs_v2_count_check" CHECK (
    "input_count" >= 0 AND
    ("output_count" IS NULL OR ("output_count" >= 0 AND "output_count" <= "input_count"))
  ),
  CONSTRAINT "transform_jobs_v2_lease_shape_check" CHECK (
    ("lease_owner" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL) OR
    ("lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL AND
      octet_length("lease_token") = 32 AND "lease_expires_at" IS NOT NULL)
  ),
  CONSTRAINT "transform_jobs_v2_active_lease_check" CHECK (
    ("status" IN ('leased', 'running', 'finalizing')) = ("lease_token" IS NOT NULL)
    OR "status" IN ('failed', 'cancelled')
  ),
  CONSTRAINT "transform_jobs_v2_completion_check" CHECK (
    ("status" = 'completed' AND "output_version" IS NOT NULL AND "finished_at" IS NOT NULL) OR
    ("status" <> 'completed' AND "output_version" IS NULL)
  ),
  CONSTRAINT "transform_jobs_v2_terminal_check" CHECK (
    ("status" IN ('completed', 'failed', 'cancelled')) = ("finished_at" IS NOT NULL)
  ),
  CONSTRAINT "transform_jobs_v2_error_check" CHECK (
    ("status" = 'failed') = ("error_json" IS NOT NULL)
  ),
  CONSTRAINT "transform_jobs_v2_cache_hit_check" CHECK (
    NOT "cache_hit" OR "status" = 'completed'
  )
);

CREATE INDEX "idx_transform_jobs_v2_queue"
  ON "transform_jobs_v2"("status", "created_at", "id");
CREATE INDEX "idx_transform_jobs_v2_lease_expiry"
  ON "transform_jobs_v2"("lease_expires_at");
