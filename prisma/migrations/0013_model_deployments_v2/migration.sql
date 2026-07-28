ALTER TABLE "model_artifacts_v2"
  ADD CONSTRAINT "uq_model_artifacts_v2_namespace_id" UNIQUE ("namespace_id", "id");

CREATE TABLE "model_deployments_v2" (
  "id" UUID NOT NULL,
  "namespace_id" UUID NOT NULL,
  "create_digest" CHAR(64) NOT NULL,
  "artifact_id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "served_model_name" TEXT NOT NULL,
  "endpoint_base_url" TEXT NOT NULL,
  "auth_mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "health_status" TEXT NOT NULL DEFAULT 'unknown',
  "health_checked_at" TIMESTAMPTZ(6),
  "health_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disabled_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "model_deployments_v2_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_model_deployments_v2_create_digest"
    UNIQUE ("namespace_id", "create_digest"),
  CONSTRAINT "uq_model_deployments_v2_namespace_id_artifact_digest"
    UNIQUE ("namespace_id", "id", "artifact_id", "create_digest"),
  CONSTRAINT "model_deployments_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_deployments_v2_artifact_fkey" FOREIGN KEY ("namespace_id", "artifact_id")
    REFERENCES "model_artifacts_v2"("namespace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_deployments_v2_digest_check" CHECK (
    "create_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "model_deployments_v2_fixed_profile_check" CHECK (
    "provider" = 'openai_compatible' AND "auth_mode" = 'none'
  ),
  CONSTRAINT "model_deployments_v2_text_check" CHECK (
    octet_length("display_name") BETWEEN 1 AND 256 AND
    "display_name" !~ '[[:cntrl:]]' AND
    octet_length("served_model_name") BETWEEN 1 AND 512 AND
    "served_model_name" !~ '[[:cntrl:]]' AND
    NOT (
      "display_name" ~* 'sk-(proj-)?[A-Za-z0-9_-]{8,}' OR
      "served_model_name" ~* 'sk-(proj-)?[A-Za-z0-9_-]{8,}'
    )
  ),
  CONSTRAINT "model_deployments_v2_endpoint_check" CHECK (
    octet_length("endpoint_base_url") BETWEEN 1 AND 2048 AND
    "endpoint_base_url" ~ '^https?://[^/?#@[:space:]]+([/][^?#[:cntrl:]]*)?$' AND
    "endpoint_base_url" !~ '[?#@[:cntrl:]]' AND
    "endpoint_base_url" !~* 'sk-(proj-)?[A-Za-z0-9_-]{8,}' AND
    "endpoint_base_url" !~* '(authorization|x-api-key|api[_-]?key|token)[[:space:]]*[:=]' AND
    right("endpoint_base_url", 1) <> '/'
  ),
  CONSTRAINT "model_deployments_v2_status_check" CHECK (
    "status" IN ('active', 'disabled') AND
    (("status" = 'disabled') = ("disabled_at" IS NOT NULL)) AND
    ("disabled_at" IS NULL OR "disabled_at" >= "created_at")
  ),
  CONSTRAINT "model_deployments_v2_health_check" CHECK (
    "health_status" IN ('unknown', 'healthy', 'unhealthy') AND
    (("health_status" = 'unknown') = ("health_checked_at" IS NULL)) AND
    (("health_status" = 'unhealthy') = ("health_error" IS NOT NULL)) AND
    ("health_error" IS NULL OR (
      octet_length("health_error") BETWEEN 1 AND 2048 AND
      "health_error" !~ '[[:cntrl:]]'
    ))
  ),
  CONSTRAINT "model_deployments_v2_timestamp_check" CHECK (
    "updated_at" >= "created_at" AND
    ("health_checked_at" IS NULL OR "health_checked_at" >= "created_at")
  )
);

CREATE INDEX "idx_model_deployments_v2_status"
  ON "model_deployments_v2"("namespace_id", "status", "created_at", "id");
CREATE INDEX "idx_model_deployments_v2_artifact"
  ON "model_deployments_v2"("namespace_id", "artifact_id", "created_at", "id");

ALTER TABLE "evaluation_runs_v2"
  ADD COLUMN "create_profile" TEXT NOT NULL DEFAULT 'evaluation-run-create-v1',
  ADD COLUMN "model_deployment_id" UUID,
  ADD COLUMN "model_artifact_id" UUID,
  ADD COLUMN "model_deployment_digest" CHAR(64);

ALTER TABLE "evaluation_runs_v2"
  ADD CONSTRAINT "evaluation_runs_v2_create_profile_check" CHECK (
    "create_profile" IN ('evaluation-run-create-v1', 'evaluation-run-create-v2')
  ),
  ADD CONSTRAINT "evaluation_runs_v2_deployment_shape_check" CHECK (
    (
      "create_profile" = 'evaluation-run-create-v1' AND
      "model_deployment_id" IS NULL AND
      "model_artifact_id" IS NULL AND
      "model_deployment_digest" IS NULL
    ) OR (
      "create_profile" = 'evaluation-run-create-v2' AND
      "model_deployment_id" IS NOT NULL AND
      "model_artifact_id" IS NOT NULL AND
      "model_deployment_digest" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "evaluation_runs_v2_model_deployment_fkey"
    FOREIGN KEY (
      "namespace_id", "model_deployment_id", "model_artifact_id", "model_deployment_digest"
    )
    REFERENCES "model_deployments_v2"("namespace_id", "id", "artifact_id", "create_digest")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "idx_evaluation_runs_v2_model_deployment"
  ON "evaluation_runs_v2"("namespace_id", "model_deployment_id", "created_at", "id");
