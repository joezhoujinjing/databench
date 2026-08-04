ALTER TABLE "model_deployments_v2"
  ADD COLUMN "deployment_profile" TEXT,
  ADD COLUMN "model_version_id" UUID,
  ADD COLUMN "connectivity_scope" TEXT,
  ADD COLUMN "credential_ref" TEXT,
  ADD COLUMN "declared_capabilities_json" JSONB,
  ADD COLUMN "policy_generation" BIGINT,
  ADD COLUMN "credential_generation" BIGINT,
  ADD COLUMN "activated_at" TIMESTAMPTZ(6);

UPDATE "model_deployments_v2"
SET "deployment_profile" = 'artifact-bound-v1';

ALTER TABLE "model_deployments_v2"
  ALTER COLUMN "deployment_profile" SET NOT NULL,
  ALTER COLUMN "artifact_id" DROP NOT NULL;

ALTER TABLE "model_deployments_v2"
  DROP CONSTRAINT "model_deployments_v2_fixed_profile_check",
  DROP CONSTRAINT "model_deployments_v2_status_check";

CREATE FUNCTION "model_deployment_capabilities_v2_is_valid"("value" JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  "interface_value" JSONB;
  "interface_name" TEXT;
  "seen_interfaces" TEXT[] := ARRAY[]::TEXT[];
  "context_limit" NUMERIC;
BEGIN
  IF jsonb_typeof("value") <> 'object' OR
     NOT ("value" ? 'interfaces') OR
     NOT ("value" ? 'context_limit') OR
     ("value" - 'interfaces' - 'context_limit') <> '{}'::JSONB OR
     jsonb_typeof("value" -> 'interfaces') <> 'array' OR
     jsonb_array_length("value" -> 'interfaces') NOT BETWEEN 1 AND 4 THEN
    RETURN FALSE;
  END IF;

  FOR "interface_value" IN
    SELECT "entry" FROM jsonb_array_elements("value" -> 'interfaces') AS "entry"
  LOOP
    IF jsonb_typeof("interface_value") <> 'string' THEN
      RETURN FALSE;
    END IF;
    "interface_name" := "interface_value" #>> '{}';
    IF "interface_name" NOT IN ('chat_completions', 'embeddings', 'vision', 'tools') OR
       "interface_name" = ANY("seen_interfaces") THEN
      RETURN FALSE;
    END IF;
    "seen_interfaces" := array_append("seen_interfaces", "interface_name");
  END LOOP;

  IF "value" -> 'context_limit' = 'null'::JSONB THEN
    RETURN TRUE;
  END IF;
  IF jsonb_typeof("value" -> 'context_limit') <> 'number' THEN
    RETURN FALSE;
  END IF;
  "context_limit" := ("value" ->> 'context_limit')::NUMERIC;
  RETURN "context_limit" = trunc("context_limit") AND
         "context_limit" BETWEEN 1 AND 10000000;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

ALTER TABLE "model_deployments_v2"
  ADD CONSTRAINT "model_deployments_v2_profile_shape_check" CHECK (
    (
      "deployment_profile" = 'artifact-bound-v1' AND
      "artifact_id" IS NOT NULL AND
      "model_version_id" IS NULL AND
      "connectivity_scope" IS NULL AND
      "provider" = 'openai_compatible' AND
      "auth_mode" = 'none' AND
      "credential_ref" IS NULL AND
      "declared_capabilities_json" IS NULL AND
      "policy_generation" IS NULL AND
      "credential_generation" IS NULL AND
      "activated_at" IS NULL AND
      "status" IN ('active', 'disabled')
    ) OR (
      "deployment_profile" = 'model-version-v1' AND
      "model_version_id" IS NOT NULL AND
      "connectivity_scope" IN ('private_network', 'public_network') AND
      "provider" = 'openai_compatible' AND
      "auth_mode" IN ('none', 'bearer_ref') AND
      (("auth_mode" = 'bearer_ref') = ("credential_ref" IS NOT NULL)) AND
      (
        "credential_ref" IS NULL OR (
          "credential_ref" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' AND
          strpos("credential_ref", '..') = 0
        )
      ) AND
      "model_deployment_capabilities_v2_is_valid"("declared_capabilities_json") AND
      "status" IN ('registered', 'active', 'disabled') AND
      ("policy_generation" IS NULL OR "policy_generation" BETWEEN 1 AND 9007199254740991) AND
      (
        "credential_generation" IS NULL OR
        "credential_generation" BETWEEN 1 AND 9007199254740991
      ) AND
      (
        "auth_mode" = 'bearer_ref' OR
        "credential_generation" IS NULL
      ) AND
      (
        "status" <> 'registered' OR (
          "policy_generation" IS NULL AND
          "credential_generation" IS NULL AND
          "activated_at" IS NULL
        )
      ) AND
      ("status" <> 'active' OR (
        "policy_generation" IS NOT NULL AND
        ("auth_mode" = 'none' OR "credential_generation" IS NOT NULL) AND
        "activated_at" IS NOT NULL
      ))
    )
  ),
  ADD CONSTRAINT "model_deployments_v2_lifecycle_check" CHECK (
    (("status" = 'disabled') = ("disabled_at" IS NOT NULL)) AND
    (
      "deployment_profile" <> 'model-version-v1' OR (
        ("status" <> 'registered' OR "activated_at" IS NULL) AND
        ("status" <> 'active' OR "activated_at" IS NOT NULL)
      )
    ) AND
    ("activated_at" IS NULL OR "activated_at" >= "created_at") AND
    ("disabled_at" IS NULL OR "disabled_at" >= COALESCE("activated_at", "created_at"))
  ),
  ADD CONSTRAINT "model_deployments_v2_new_health_code_check" CHECK (
    "deployment_profile" <> 'model-version-v1' OR
    "health_error" IS NULL OR
    "health_error" IN (
      'timeout', 'network_error', 'http_error', 'invalid_response',
      'served_model_missing', 'policy_rejected', 'credential_rejected',
      'configuration_changed', 'unhealthy'
    )
  ),
  ADD CONSTRAINT "uq_model_deployments_v2_namespace_id" UNIQUE ("namespace_id", "id"),
  ADD CONSTRAINT "uq_model_deployments_v2_namespace_id_digest"
    UNIQUE ("namespace_id", "id", "create_digest"),
  ADD CONSTRAINT "uq_model_deployments_v2_version_id_digest"
    UNIQUE ("namespace_id", "model_version_id", "id", "create_digest"),
  ADD CONSTRAINT "model_deployments_v2_model_version_fkey"
    FOREIGN KEY ("namespace_id", "model_version_id")
    REFERENCES "model_versions_v2"("namespace_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "model_deployments_v2_version_artifact_fkey"
    FOREIGN KEY ("namespace_id", "model_version_id", "artifact_id")
    REFERENCES "model_version_artifact_sources_v2"(
      "namespace_id", "model_version_id", "artifact_id"
    )
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "assert_model_deployment_source_binding_v2"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  "stored_source_kind" TEXT;
BEGIN
  IF NEW."deployment_profile" <> 'model-version-v1' THEN
    RETURN NULL;
  END IF;

  SELECT "source_kind" INTO "stored_source_kind"
  FROM "model_versions_v2"
  WHERE "namespace_id" = NEW."namespace_id" AND "id" = NEW."model_version_id";

  IF "stored_source_kind" IS NULL OR
     (("stored_source_kind" = 'databench_artifact') <> (NEW."artifact_id" IS NOT NULL)) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'model_deployments_v2_source_binding_check',
      MESSAGE = 'Model Deployment Artifact binding does not match its Version source';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "model_deployments_v2_source_binding_check"
AFTER INSERT OR UPDATE OF "deployment_profile", "namespace_id", "model_version_id", "artifact_id"
ON "model_deployments_v2"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_model_deployment_source_binding_v2"();

CREATE INDEX "idx_model_deployments_v2_version"
  ON "model_deployments_v2"(
    "namespace_id", "model_version_id", "status", "created_at", "id"
  );

ALTER TABLE "model_registration_claims_v2"
  ADD COLUMN "deployment_id" UUID,
  ADD COLUMN "deployment_digest" CHAR(64),
  ADD CONSTRAINT "model_registration_claims_v2_deployment_shape_check" CHECK (
    ("deployment_id" IS NULL) = ("deployment_digest" IS NULL) AND
    ("deployment_digest" IS NULL OR "deployment_digest" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "model_registration_claims_v2_deployment_fkey"
    FOREIGN KEY ("namespace_id", "deployment_id", "deployment_digest")
    REFERENCES "model_deployments_v2"("namespace_id", "id", "create_digest")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
