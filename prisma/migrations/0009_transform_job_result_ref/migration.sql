ALTER TABLE "transform_jobs_v2"
  ADD COLUMN "result_ref_namespace_id" UUID,
  ADD COLUMN "result_ref_name" TEXT,
  ADD COLUMN "result_ref_status" TEXT,
  ADD COLUMN "result_ref_version" CHAR(64);

ALTER TABLE "transform_jobs_v2"
  ADD CONSTRAINT "transform_jobs_v2_result_ref_namespace_fkey"
    FOREIGN KEY ("result_ref_namespace_id")
    REFERENCES "identity_namespaces_v2"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "transform_jobs_v2_result_ref_version_fkey"
    FOREIGN KEY ("result_ref_version")
    REFERENCES "dataset_snapshots_v2"("version")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "transform_jobs_v2_result_ref_shape_check" CHECK (
    (
      "result_ref_namespace_id" IS NULL AND
      "result_ref_name" IS NULL AND
      "result_ref_status" IS NULL AND
      "result_ref_version" IS NULL
    ) OR (
      "result_ref_namespace_id" IS NOT NULL AND
      "result_ref_name" IS NOT NULL AND
      "result_ref_status" IS NOT NULL AND
      (
        ("result_ref_status" = 'pending' AND "result_ref_version" IS NULL) OR
        ("result_ref_status" IN ('updated', 'conflict') AND "result_ref_version" IS NOT NULL)
      )
    )
  ),
  ADD CONSTRAINT "transform_jobs_v2_result_ref_name_check" CHECK (
    "result_ref_name" IS NULL OR (
      "result_ref_name" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' AND
      "result_ref_name" !~ '^[0-9a-f]{64}$' AND
      "result_ref_name" <> '.' AND
      "result_ref_name" <> '..'
    )
  );

CREATE INDEX "idx_transform_jobs_v2_result_ref"
  ON "transform_jobs_v2" ("result_ref_namespace_id", "result_ref_name" COLLATE "C")
  WHERE "result_ref_name" IS NOT NULL;
