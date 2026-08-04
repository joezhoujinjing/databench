ALTER TABLE "evaluation_runs_v2"
  ADD COLUMN "model_id" UUID,
  ADD COLUMN "model_version_id" UUID,
  ADD COLUMN "source_mutability_snapshot" TEXT,
  ADD COLUMN "verification_level_snapshot" TEXT,
  ADD COLUMN "source_evidence_digest" CHAR(64),
  ADD COLUMN "source_observed_at" TIMESTAMPTZ(6);

ALTER TABLE "evaluation_runs_v2"
  DROP CONSTRAINT "evaluation_runs_v2_create_profile_check",
  DROP CONSTRAINT "evaluation_runs_v2_deployment_shape_check",
  DROP CONSTRAINT "evaluation_runs_v2_scoring_shape_check";

ALTER TABLE "evaluation_runs_v2"
  ADD CONSTRAINT "evaluation_runs_v2_create_profile_check" CHECK (
    "create_profile" IN (
      'evaluation-run-create-v1',
      'evaluation-run-create-v2',
      'evaluation-run-create-v3',
      'evaluation-run-create-v4',
      'evaluation-run-create-v5',
      'evaluation-run-create-v6'
    )
  ),
  ADD CONSTRAINT "evaluation_runs_v2_deployment_shape_check" CHECK (
    (
      "create_profile" IN ('evaluation-run-create-v1', 'evaluation-run-create-v3') AND
      "model_deployment_id" IS NULL AND
      "model_artifact_id" IS NULL AND
      "model_deployment_digest" IS NULL
    ) OR (
      "create_profile" IN ('evaluation-run-create-v2', 'evaluation-run-create-v4') AND
      "model_deployment_id" IS NOT NULL AND
      "model_artifact_id" IS NOT NULL AND
      "model_deployment_digest" IS NOT NULL
    ) OR (
      "create_profile" IN ('evaluation-run-create-v5', 'evaluation-run-create-v6') AND
      "model_deployment_id" IS NOT NULL AND
      "model_deployment_digest" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "evaluation_runs_v2_registry_snapshot_shape_check" CHECK (
    (
      "create_profile" NOT IN ('evaluation-run-create-v5', 'evaluation-run-create-v6') AND
      "model_id" IS NULL AND
      "model_version_id" IS NULL AND
      "source_mutability_snapshot" IS NULL AND
      "verification_level_snapshot" IS NULL AND
      "source_evidence_digest" IS NULL AND
      "source_observed_at" IS NULL
    ) OR (
      "create_profile" IN ('evaluation-run-create-v5', 'evaluation-run-create-v6') AND
      "model_id" IS NOT NULL AND
      "model_version_id" IS NOT NULL AND
      "source_mutability_snapshot" IN ('immutable', 'mutable', 'unknown') AND
      "verification_level_snapshot" IN (
        'content_verified', 'provider_verified', 'operator_attested', 'unverified'
      ) AND
      (
        "source_evidence_digest" IS NULL OR
        "source_evidence_digest" ~ '^[0-9a-f]{64}$'
      ) AND
      (
        "verification_level_snapshot" <> 'provider_verified' OR
        "source_evidence_digest" IS NOT NULL
      ) AND
      "source_observed_at" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "evaluation_runs_v2_scoring_shape_check" CHECK (
    (
      "create_profile" IN (
        'evaluation-run-create-v1', 'evaluation-run-create-v2', 'evaluation-run-create-v5'
      ) AND
      "scoring_config_json" IS NULL AND
      "primary_metric_id" IS NULL AND
      "primary_output_key" IS NULL
    ) OR (
      "create_profile" IN (
        'evaluation-run-create-v3', 'evaluation-run-create-v4', 'evaluation-run-create-v6'
      ) AND
      "scoring_config_json" IS NOT NULL AND
      "primary_metric_id" IS NOT NULL AND
      "primary_output_key" IS NOT NULL AND
      jsonb_typeof("scoring_config_json") = 'object' AND
      octet_length("scoring_config_json"::text) <= 65536 AND
      "primary_metric_id" ~ '^[a-z][a-z0-9._-]{0,127}$' AND
      octet_length("primary_output_key") BETWEEN 1 AND 128 AND
      "primary_output_key" !~ '[[:cntrl:]]' AND
      "scoring_config_json"->>'primary_metric_id' = "primary_metric_id" AND
      "scoring_config_json"->>'primary_output_key' = "primary_output_key" AND
      "scoring_config_json"->>'benchmark' = "benchmark" AND
      "scoring_config_json"->>'evalscope_commit' = "evalscope_commit" AND
      NOT jsonb_path_exists(
        "scoring_config_json",
        '$.** ? (@.type() == "string" && (@ like_regex "sk-(proj-)?[A-Za-z0-9_-]{8,}" flag "i" || @ like_regex "(authorization|x-api-key|api[_-]?key|token)[[:space:]]*[:=][[:space:]]*[^[:space:]]+" flag "i"))'
      )
    )
  ),
  ADD CONSTRAINT "evaluation_runs_v2_model_version_fkey"
    FOREIGN KEY ("namespace_id", "model_id", "model_version_id")
    REFERENCES "model_versions_v2"("namespace_id", "model_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "evaluation_runs_v2_version_deployment_fkey"
    FOREIGN KEY (
      "namespace_id", "model_version_id", "model_deployment_id", "model_deployment_digest"
    )
    REFERENCES "model_deployments_v2"(
      "namespace_id", "model_version_id", "id", "create_digest"
    )
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "evaluation_runs_v2_source_evidence_fkey"
    FOREIGN KEY ("namespace_id", "model_version_id", "source_evidence_digest")
    REFERENCES "model_source_evidence_v2"(
      "namespace_id", "model_version_id", "evidence_digest"
    )
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "assert_evaluation_model_source_binding_v2"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  "stored_source_kind" TEXT;
BEGIN
  IF NEW."create_profile" NOT IN ('evaluation-run-create-v5', 'evaluation-run-create-v6') THEN
    RETURN NULL;
  END IF;

  SELECT "source_kind" INTO "stored_source_kind"
  FROM "model_versions_v2"
  WHERE
    "namespace_id" = NEW."namespace_id" AND
    "model_id" = NEW."model_id" AND
    "id" = NEW."model_version_id";

  IF "stored_source_kind" IS NULL OR
     (("stored_source_kind" = 'databench_artifact') <> (NEW."model_artifact_id" IS NOT NULL)) OR
     (
       "stored_source_kind" = 'databench_artifact' AND
       (
         NEW."source_mutability_snapshot" <> 'immutable' OR
         NEW."verification_level_snapshot" <> 'content_verified' OR
         NEW."source_evidence_digest" IS NOT NULL
       )
     ) OR
     (
       "stored_source_kind" <> 'databench_artifact' AND
       NEW."verification_level_snapshot" = 'content_verified'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'evaluation_runs_v2_model_source_binding_check',
      MESSAGE = 'Evaluation source snapshot does not match its Model Version source';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "evaluation_runs_v2_model_source_binding_check"
AFTER INSERT OR UPDATE OF
  "create_profile", "namespace_id", "model_id", "model_version_id", "model_artifact_id",
  "source_mutability_snapshot", "verification_level_snapshot", "source_evidence_digest"
ON "evaluation_runs_v2"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_evaluation_model_source_binding_v2"();

CREATE INDEX "idx_evaluation_runs_v2_model_version"
  ON "evaluation_runs_v2"(
    "namespace_id", "model_id", "model_version_id", "created_at", "id"
  );
