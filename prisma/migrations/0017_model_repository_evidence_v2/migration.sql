ALTER TABLE "model_source_evidence_v2"
  ADD COLUMN "license" TEXT,
  ADD COLUMN "cache_status" TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE "model_source_evidence_v2"
  DROP CONSTRAINT "model_source_evidence_v2_shape_check";

ALTER TABLE "model_source_evidence_v2"
  ADD CONSTRAINT "model_source_evidence_v2_shape_check" CHECK (
    "evidence_profile" = 'model-source-evidence-v1' AND
    "evidence_digest" ~ '^[0-9a-f]{64}$' AND
    "evidence_kind" IN ('provider_resolution', 'operator_attestation') AND
    "adapter" ~ '^[a-z][a-z0-9._-]{0,127}$' AND
    "adapter_version" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' AND
    ("observed_revision" IS NULL OR (octet_length("observed_revision") BETWEEN 1 AND 256)) AND
    "result" IN ('verified', 'not_found', 'unavailable', 'invalid', 'revision_mismatch') AND
    ("response_digest" IS NULL OR "response_digest" ~ '^[0-9a-f]{64}$') AND
    ("license" IS NULL OR (octet_length("license") BETWEEN 1 AND 256)) AND
    "cache_status" IN ('cached', 'not_cached', 'unknown') AND
    (
      "result" NOT IN ('verified', 'revision_mismatch') OR
      ("observed_revision" IS NOT NULL AND "response_digest" IS NOT NULL)
    )
  );

ALTER TABLE "model_source_evidence_v2"
  ALTER COLUMN "cache_status" DROP DEFAULT;

DROP INDEX "idx_model_source_evidence_v2_version";

CREATE INDEX "idx_model_source_evidence_v2_version"
  ON "model_source_evidence_v2"(
    "namespace_id",
    "model_version_id",
    "observed_at",
    "created_at",
    "id"
  );
