CREATE TABLE "model_version_deployment_adoptions_v2" (
  "namespace_id" UUID NOT NULL,
  "deployment_id" UUID NOT NULL,
  "model_id" UUID NOT NULL,
  "model_version_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "deployment_digest" CHAR(64) NOT NULL,
  "adoption_profile" TEXT NOT NULL,
  "adoption_digest" CHAR(64) NOT NULL,
  "adopted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "model_version_deployment_adoptions_v2_pkey"
    PRIMARY KEY ("namespace_id", "deployment_id"),
  CONSTRAINT "uq_model_version_deployment_adoptions_v2_deployment"
    UNIQUE ("namespace_id", "deployment_id", "artifact_id", "deployment_digest"),
  CONSTRAINT "uq_model_version_deployment_adoptions_v2_digest"
    UNIQUE ("namespace_id", "adoption_digest"),
  CONSTRAINT "model_version_deployment_adoptions_v2_namespace_fkey"
    FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_deployment_adoptions_v2_version_fkey"
    FOREIGN KEY ("namespace_id", "model_id", "model_version_id")
    REFERENCES "model_versions_v2"("namespace_id", "model_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_deployment_adoptions_v2_artifact_source_fkey"
    FOREIGN KEY ("namespace_id", "model_version_id", "artifact_id")
    REFERENCES "model_version_artifact_sources_v2"(
      "namespace_id", "model_version_id", "artifact_id"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_deployment_adoptions_v2_deployment_fkey"
    FOREIGN KEY ("namespace_id", "deployment_id", "artifact_id", "deployment_digest")
    REFERENCES "model_deployments_v2"(
      "namespace_id", "id", "artifact_id", "create_digest"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "model_version_deployment_adoptions_v2_shape_check" CHECK (
    "adoption_profile" = 'model-deployment-adoption-v1' AND
    "adoption_digest" ~ '^[0-9a-f]{64}$' AND
    "deployment_digest" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "idx_model_version_deployment_adoptions_v2_version"
  ON "model_version_deployment_adoptions_v2"(
    "namespace_id", "model_version_id", "adopted_at", "deployment_id"
  );

CREATE OR REPLACE FUNCTION "reject_model_deployment_adoption_mutation_v2"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Model Deployment adoption is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "model_version_deployment_adoptions_v2_append_only"
BEFORE UPDATE OR DELETE ON "model_version_deployment_adoptions_v2"
FOR EACH ROW EXECUTE FUNCTION "reject_model_deployment_adoption_mutation_v2"();
