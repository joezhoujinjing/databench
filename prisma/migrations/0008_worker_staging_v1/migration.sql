ALTER TABLE "transform_jobs_v2"
  ADD CONSTRAINT "transform_jobs_v2_staging_keys_check" CHECK (
    ("input_key" IS NULL AND "output_key" IS NULL) OR
    (
      "input_key" = 'staging/worker/v1/' || "id" || '/' || "attempt" || '/input.jsonl' AND
      "output_key" = 'staging/worker/v1/' || "id" || '/' || "attempt" || '/output.jsonl'
    )
  );
