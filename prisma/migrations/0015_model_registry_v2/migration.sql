CREATE TABLE "models_v2" (
  "id" UUID NOT NULL,
  "namespace_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "create_profile" TEXT NOT NULL,
  "create_digest" CHAR(64) NOT NULL,
  "display_name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "task_family" TEXT,
  "tags_json" JSONB NOT NULL,
  "metadata_revision" BIGINT NOT NULL DEFAULT 0,
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "models_v2_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_models_v2_namespace_id" UNIQUE ("namespace_id", "id"),
  CONSTRAINT "uq_models_v2_key" UNIQUE ("namespace_id", "key"),
  CONSTRAINT "uq_models_v2_create_digest" UNIQUE ("namespace_id", "create_digest"),
  CONSTRAINT "models_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "models_v2_identity_check" CHECK (
    "create_profile" = 'model-create-v1' AND
    "create_digest" ~ '^[0-9a-f]{64}$' AND
    "key" ~ '^[a-z][a-z0-9-]{0,127}$'
  ),
  CONSTRAINT "models_v2_metadata_check" CHECK (
    octet_length("display_name") BETWEEN 1 AND 256 AND
    octet_length("description") <= 2048 AND
    ("task_family" IS NULL OR "task_family" ~ '^[a-z][a-z0-9._-]{0,127}$') AND
    jsonb_typeof("tags_json") = 'array' AND
    jsonb_array_length("tags_json") <= 32 AND
    "metadata_revision" BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT "models_v2_timestamp_check" CHECK (
    "updated_at" >= "created_at" AND
    ("archived_at" IS NULL OR "archived_at" >= "created_at")
  )
);

CREATE INDEX "idx_models_v2_list"
  ON "models_v2"("namespace_id", "archived_at", "updated_at", "id");

CREATE TABLE "model_versions_v2" (
  "id" UUID NOT NULL,
  "namespace_id" UUID NOT NULL,
  "model_id" UUID NOT NULL,
  "version_label" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "create_profile" TEXT NOT NULL,
  "create_digest" CHAR(64) NOT NULL,
  "source_fingerprint" CHAR(64) NOT NULL,
  "base_model_reference" TEXT,
  "base_model_revision" TEXT,
  "base_model_binding_status" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "model_versions_v2_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_model_versions_v2_namespace_id" UNIQUE ("namespace_id", "id"),
  CONSTRAINT "uq_model_versions_v2_model_id" UNIQUE ("namespace_id", "model_id", "id"),
  CONSTRAINT "uq_model_versions_v2_label" UNIQUE ("namespace_id", "model_id", "version_label"),
  CONSTRAINT "uq_model_versions_v2_source" UNIQUE ("namespace_id", "model_id", "source_fingerprint"),
  CONSTRAINT "model_versions_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_versions_v2_model_fkey" FOREIGN KEY ("namespace_id", "model_id")
    REFERENCES "models_v2"("namespace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_versions_v2_profile_check" CHECK (
    ("source_kind" = 'databench_artifact' AND "create_profile" = 'model-version-create-artifact-v1') OR
    ("source_kind" = 'repository_reference' AND "create_profile" = 'model-version-create-repository-v1') OR
    ("source_kind" = 'existing_service' AND "create_profile" = 'model-version-create-service-v1')
  ),
  CONSTRAINT "model_versions_v2_digest_check" CHECK (
    "create_digest" ~ '^[0-9a-f]{64}$' AND
    "source_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "model_versions_v2_text_check" CHECK (
    octet_length("version_label") BETWEEN 1 AND 128 AND
    ("base_model_reference" IS NULL OR octet_length("base_model_reference") BETWEEN 1 AND 512) AND
    ("base_model_revision" IS NULL OR octet_length("base_model_revision") BETWEEN 1 AND 256) AND
    ("base_model_reference" IS NOT NULL OR "base_model_revision" IS NULL)
  ),
  CONSTRAINT "model_versions_v2_base_binding_check" CHECK (
    ("source_kind" = 'databench_artifact' AND
      "base_model_reference" IS NOT NULL AND
      "base_model_binding_status" IN ('verified', 'declared', 'unresolved')) OR
    ("source_kind" IN ('repository_reference', 'existing_service') AND
      "base_model_binding_status" IS NULL)
  )
);

CREATE INDEX "idx_model_versions_v2_list"
  ON "model_versions_v2"("namespace_id", "model_id", "created_at", "id");

CREATE TABLE "model_version_artifact_sources_v2" (
  "namespace_id" UUID NOT NULL,
  "model_version_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "artifact_kind" TEXT NOT NULL,
  "artifact_format" TEXT NOT NULL,
  "archive_digest" CHAR(64) NOT NULL,
  "manifest_digest" CHAR(64) NOT NULL,

  CONSTRAINT "model_version_artifact_sources_v2_pkey"
    PRIMARY KEY ("namespace_id", "model_version_id"),
  CONSTRAINT "uq_model_version_artifact_sources_v2_binding"
    UNIQUE ("namespace_id", "model_version_id", "artifact_id"),
  CONSTRAINT "model_version_artifact_sources_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_artifact_sources_v2_version_fkey"
    FOREIGN KEY ("namespace_id", "model_version_id")
    REFERENCES "model_versions_v2"("namespace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_artifact_sources_v2_artifact_fkey"
    FOREIGN KEY ("namespace_id", "artifact_id")
    REFERENCES "model_artifacts_v2"("namespace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_artifact_sources_v2_digest_check" CHECK (
    "archive_digest" ~ '^[0-9a-f]{64}$' AND "manifest_digest" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "model_version_repository_sources_v2" (
  "namespace_id" UUID NOT NULL,
  "model_version_id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "repository_id" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "revision_kind" TEXT NOT NULL,

  CONSTRAINT "model_version_repository_sources_v2_pkey"
    PRIMARY KEY ("namespace_id", "model_version_id"),
  CONSTRAINT "model_version_repository_sources_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_repository_sources_v2_version_fkey"
    FOREIGN KEY ("namespace_id", "model_version_id")
    REFERENCES "model_versions_v2"("namespace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_repository_sources_v2_shape_check" CHECK (
    "provider" IN ('hugging_face', 'modelscope', 'operator_managed') AND
    "revision_kind" IN ('commit', 'digest', 'tag', 'opaque') AND
    octet_length("repository_id") BETWEEN 1 AND 512 AND
    octet_length("revision") BETWEEN 1 AND 256
  )
);

CREATE TABLE "model_version_service_sources_v2" (
  "namespace_id" UUID NOT NULL,
  "model_version_id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "external_model_ref" TEXT NOT NULL,
  "external_version_ref" TEXT NOT NULL,
  "declared_reference_kind" TEXT NOT NULL,

  CONSTRAINT "model_version_service_sources_v2_pkey"
    PRIMARY KEY ("namespace_id", "model_version_id"),
  CONSTRAINT "model_version_service_sources_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_service_sources_v2_version_fkey"
    FOREIGN KEY ("namespace_id", "model_version_id")
    REFERENCES "model_versions_v2"("namespace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_service_sources_v2_shape_check" CHECK (
    "provider" = 'openai_compatible' AND
    "declared_reference_kind" IN ('immutable_version', 'mutable_alias', 'opaque') AND
    octet_length("external_model_ref") BETWEEN 1 AND 512 AND
    octet_length("external_version_ref") BETWEEN 1 AND 512
  )
);

CREATE OR REPLACE FUNCTION "check_model_version_source_xor_v2"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_namespace UUID;
  target_version UUID;
  expected_kind TEXT;
  artifact_count INTEGER;
  repository_count INTEGER;
  service_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'model_versions_v2' THEN
    IF TG_OP = 'DELETE' THEN
      target_namespace := OLD."namespace_id";
      target_version := OLD."id";
    ELSE
      target_namespace := NEW."namespace_id";
      target_version := NEW."id";
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    target_namespace := OLD."namespace_id";
    target_version := OLD."model_version_id";
  ELSE
    target_namespace := NEW."namespace_id";
    target_version := NEW."model_version_id";
  END IF;

  SELECT "source_kind" INTO expected_kind
  FROM "model_versions_v2"
  WHERE "namespace_id" = target_namespace AND "id" = target_version;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*) INTO artifact_count
  FROM "model_version_artifact_sources_v2"
  WHERE "namespace_id" = target_namespace AND "model_version_id" = target_version;
  SELECT COUNT(*) INTO repository_count
  FROM "model_version_repository_sources_v2"
  WHERE "namespace_id" = target_namespace AND "model_version_id" = target_version;
  SELECT COUNT(*) INTO service_count
  FROM "model_version_service_sources_v2"
  WHERE "namespace_id" = target_namespace AND "model_version_id" = target_version;

  IF artifact_count + repository_count + service_count <> 1 OR
    (expected_kind = 'databench_artifact' AND artifact_count <> 1) OR
    (expected_kind = 'repository_reference' AND repository_count <> 1) OR
    (expected_kind = 'existing_service' AND service_count <> 1) THEN
    RAISE EXCEPTION 'Model Version source XOR violation for %', target_version
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "model_versions_v2_source_xor"
AFTER INSERT OR UPDATE ON "model_versions_v2"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_model_version_source_xor_v2"();

CREATE CONSTRAINT TRIGGER "model_version_artifact_sources_v2_source_xor"
AFTER INSERT OR UPDATE OR DELETE ON "model_version_artifact_sources_v2"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_model_version_source_xor_v2"();

CREATE CONSTRAINT TRIGGER "model_version_repository_sources_v2_source_xor"
AFTER INSERT OR UPDATE OR DELETE ON "model_version_repository_sources_v2"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_model_version_source_xor_v2"();

CREATE CONSTRAINT TRIGGER "model_version_service_sources_v2_source_xor"
AFTER INSERT OR UPDATE OR DELETE ON "model_version_service_sources_v2"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_model_version_source_xor_v2"();

CREATE TABLE "model_source_evidence_v2" (
  "id" UUID NOT NULL,
  "namespace_id" UUID NOT NULL,
  "model_version_id" UUID NOT NULL,
  "evidence_profile" TEXT NOT NULL,
  "evidence_digest" CHAR(64) NOT NULL,
  "evidence_kind" TEXT NOT NULL,
  "adapter" TEXT NOT NULL,
  "adapter_version" TEXT NOT NULL,
  "observed_revision" TEXT,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "result" TEXT NOT NULL,
  "response_digest" CHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "model_source_evidence_v2_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_model_source_evidence_v2_digest"
    UNIQUE ("namespace_id", "model_version_id", "evidence_digest"),
  CONSTRAINT "model_source_evidence_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_source_evidence_v2_version_fkey"
    FOREIGN KEY ("namespace_id", "model_version_id")
    REFERENCES "model_versions_v2"("namespace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_source_evidence_v2_shape_check" CHECK (
    "evidence_profile" = 'model-source-evidence-v1' AND
    "evidence_digest" ~ '^[0-9a-f]{64}$' AND
    "evidence_kind" IN ('provider_resolution', 'operator_attestation') AND
    "adapter" ~ '^[a-z][a-z0-9._-]{0,127}$' AND
    "adapter_version" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' AND
    "result" IN ('verified', 'not_found', 'unavailable', 'invalid') AND
    ("response_digest" IS NULL OR "response_digest" ~ '^[0-9a-f]{64}$') AND
    ("result" <> 'verified' OR ("observed_revision" IS NOT NULL AND "response_digest" IS NOT NULL))
  )
);

CREATE INDEX "idx_model_source_evidence_v2_version"
  ON "model_source_evidence_v2"("namespace_id", "model_version_id", "observed_at", "id");

CREATE OR REPLACE FUNCTION "reject_model_source_evidence_mutation_v2"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Model source evidence is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "model_source_evidence_v2_append_only"
BEFORE UPDATE OR DELETE ON "model_source_evidence_v2"
FOR EACH ROW EXECUTE FUNCTION "reject_model_source_evidence_mutation_v2"();

CREATE TABLE "model_aliases_v2" (
  "namespace_id" UUID NOT NULL,
  "model_id" UUID NOT NULL,
  "alias" TEXT NOT NULL,
  "version_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "model_aliases_v2_pkey" PRIMARY KEY ("namespace_id", "model_id", "alias"),
  CONSTRAINT "model_aliases_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_aliases_v2_model_fkey" FOREIGN KEY ("namespace_id", "model_id")
    REFERENCES "models_v2"("namespace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_aliases_v2_version_fkey"
    FOREIGN KEY ("namespace_id", "model_id", "version_id")
    REFERENCES "model_versions_v2"("namespace_id", "model_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_aliases_v2_name_check" CHECK ("alias" IN ('candidate', 'staging', 'production'))
);

CREATE TABLE "model_registration_claims_v2" (
  "namespace_id" UUID NOT NULL,
  "registration_digest" CHAR(64) NOT NULL,
  "plan_profile" TEXT NOT NULL,
  "normalized_request_json" JSONB NOT NULL,
  "model_id" UUID NOT NULL,
  "model_version_id" UUID NOT NULL,
  "alias_name" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "model_registration_claims_v2_pkey"
    PRIMARY KEY ("namespace_id", "registration_digest"),
  CONSTRAINT "model_registration_claims_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_registration_claims_v2_model_fkey" FOREIGN KEY ("namespace_id", "model_id")
    REFERENCES "models_v2"("namespace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_registration_claims_v2_version_fkey"
    FOREIGN KEY ("namespace_id", "model_id", "model_version_id")
    REFERENCES "model_versions_v2"("namespace_id", "model_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_registration_claims_v2_alias_fkey"
    FOREIGN KEY ("namespace_id", "model_id", "alias_name")
    REFERENCES "model_aliases_v2"("namespace_id", "model_id", "alias")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_registration_claims_v2_shape_check" CHECK (
    "registration_digest" ~ '^[0-9a-f]{64}$' AND
    "plan_profile" IN (
      'model-registration-plan-artifact-v1',
      'model-registration-plan-repository-v1',
      'model-registration-plan-service-v1'
    ) AND
    jsonb_typeof("normalized_request_json") = 'object' AND
    octet_length("normalized_request_json"::text) <= 65536 AND
    ("alias_name" IS NULL OR "alias_name" IN ('candidate', 'staging', 'production'))
  )
);
