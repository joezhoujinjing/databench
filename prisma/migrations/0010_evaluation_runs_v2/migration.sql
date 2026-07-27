CREATE TABLE "evaluation_runs_v2" (
  "id" UUID NOT NULL,
  "namespace_id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_task_id" TEXT NOT NULL,
  "create_request_digest" CHAR(64) NOT NULL,
  "provider_report_ids_json" JSONB,
  "dataset_version" CHAR(64) NOT NULL,
  "source_ref" TEXT,
  "converter" TEXT NOT NULL,
  "converter_version" TEXT NOT NULL,
  "converter_options_json" JSONB NOT NULL,
  "fidelity_digest" CHAR(64) NOT NULL,
  "benchmark" TEXT NOT NULL,
  "model_name" TEXT,
  "evalscope_commit" TEXT,
  "status" TEXT NOT NULL,
  "metrics_json" JSONB,
  "error_json" JSONB,
  "archive_status" TEXT NOT NULL DEFAULT 'not_requested',
  "archive_attempt" INTEGER NOT NULL DEFAULT 0,
  "result_artifact_key" TEXT,
  "result_artifact_digest" CHAR(64),
  "result_artifact_size_bytes" BIGINT,
  "archive_error_json" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "evaluation_runs_v2_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_evaluation_runs_v2_provider_task"
    UNIQUE ("namespace_id", "provider", "provider_task_id"),
  CONSTRAINT "evaluation_runs_v2_namespace_fkey" FOREIGN KEY ("namespace_id")
    REFERENCES "identity_namespaces_v2"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "evaluation_runs_v2_dataset_fkey" FOREIGN KEY ("dataset_version")
    REFERENCES "dataset_snapshots_v2"("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "evaluation_runs_v2_provider_check" CHECK ("provider" = 'evalscope'),
  CONSTRAINT "evaluation_runs_v2_provider_task_check" CHECK (
    octet_length("provider_task_id") BETWEEN 1 AND 256 AND
    "provider_task_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$'
  ),
  CONSTRAINT "evaluation_runs_v2_digest_check" CHECK (
    "create_request_digest" ~ '^[0-9a-f]{64}$' AND
    "dataset_version" ~ '^[0-9a-f]{64}$' AND
    "fidelity_digest" ~ '^[0-9a-f]{64}$' AND
    ("result_artifact_digest" IS NULL OR "result_artifact_digest" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "evaluation_runs_v2_source_ref_check" CHECK (
    "source_ref" IS NULL OR (
      "source_ref" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' AND
      "source_ref" !~ '^[0-9a-f]{64}$' AND
      "source_ref" <> '.' AND
      "source_ref" <> '..'
    )
  ),
  CONSTRAINT "evaluation_runs_v2_names_check" CHECK (
    "converter" ~ '^[a-z][a-z0-9._-]{0,127}$' AND
    "converter_version" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' AND
    "benchmark" ~ '^[a-z][a-z0-9._-]{0,127}$'
  ),
  CONSTRAINT "evaluation_runs_v2_model_check" CHECK (
    ("model_name" IS NULL OR (
      octet_length("model_name") BETWEEN 1 AND 512 AND
      "model_name" !~ '[[:cntrl:]]'
    )) AND
    ("evalscope_commit" IS NULL OR "evalscope_commit" ~ '^[0-9a-f]{40}$')
  ),
  CONSTRAINT "evaluation_runs_v2_status_check" CHECK (
    "status" IN ('prepared', 'running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT "evaluation_runs_v2_json_bounds_check" CHECK (
    jsonb_typeof("converter_options_json") = 'object' AND
    octet_length("converter_options_json"::text) <= 65536 AND
    ("provider_report_ids_json" IS NULL OR (
      jsonb_typeof("provider_report_ids_json") = 'array' AND
      jsonb_array_length("provider_report_ids_json") <= 32 AND
      octet_length("provider_report_ids_json"::text) <= 16512 AND
      NOT jsonb_path_exists(
        "provider_report_ids_json",
        '$[*] ? (@.type() != "string")'
      ) AND
      NOT jsonb_path_exists(
        "provider_report_ids_json",
        '$[*] ? (!(@ like_regex "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}[A-Za-z0-9._-]{0,255}[A-Za-z0-9._-]?$"))'
      ) AND
      NOT jsonb_path_exists(
        "provider_report_ids_json",
        '$[*] ? (@ like_regex "^sk-(proj-)?[A-Za-z0-9_-]{8,}$" flag "i")'
      )
    )) AND
    ("metrics_json" IS NULL OR (
      jsonb_typeof("metrics_json") = 'array' AND
      jsonb_array_length("metrics_json") <= 10000 AND
      octet_length("metrics_json"::text) <= 9437184 AND
      NOT jsonb_path_exists("metrics_json", '$[*] ? (@.type() != "object")') AND
      NOT jsonb_path_exists(
        "metrics_json",
        '$[*].keyvalue() ? (@.key != "dataset" && @.key != "subset" && @.key != "metric" && @.key != "score" && @.key != "sample_count" && @.key != "categories")'
      ) AND
      NOT jsonb_path_exists(
        "metrics_json",
        '$[*] ? (!exists(@.dataset) || @.dataset.type() != "string" || !exists(@.subset) || (@.subset.type() != "string" && @.subset.type() != "null") || !exists(@.metric) || @.metric.type() != "string" || !exists(@.score) || (@.score.type() != "number" && @.score.type() != "null") || !exists(@.sample_count) || (@.sample_count.type() != "number" && @.sample_count.type() != "null") || !exists(@.categories) || @.categories.type() != "array")'
      ) AND
      NOT jsonb_path_exists(
        "metrics_json",
        '$[*].categories[*] ? (@.type() != "string")'
      ) AND
      NOT jsonb_path_exists(
        "metrics_json",
        '$.** ? (@.type() == "string" && (@ like_regex "sk-(proj-)?[A-Za-z0-9_-]{8,}" flag "i" || @ like_regex "(authorization|x-api-key|api[_-]?key|token)[[:space:]]*[:=][[:space:]]*[^[:space:]]+" flag "i"))'
      )
    )) AND
    ("error_json" IS NULL OR (
      jsonb_typeof("error_json") = 'object' AND
      octet_length("error_json"::text) <= 4096 AND
      jsonb_typeof("error_json"->'phase') = 'string' AND
      jsonb_typeof("error_json"->'code') = 'string' AND
      jsonb_typeof("error_json"->'message') = 'string' AND
      NOT jsonb_path_exists(
        "error_json",
        '$.keyvalue() ? (@.key != "phase" && @.key != "code" && @.key != "message")'
      ) AND
      NOT jsonb_path_exists(
        "error_json",
        '$.** ? (@.type() == "string" && (@ like_regex "sk-(proj-)?[A-Za-z0-9_-]{8,}" flag "i" || @ like_regex "(authorization|x-api-key|api[_-]?key|token)[[:space:]]*[:=][[:space:]]*[^[:space:]]+" flag "i"))'
      )
    )) AND
    ("archive_error_json" IS NULL OR (
      jsonb_typeof("archive_error_json") = 'object' AND
      octet_length("archive_error_json"::text) <= 4096
    ))
  ),
  CONSTRAINT "evaluation_runs_v2_execution_shape_check" CHECK (
    (("status" IN ('completed', 'failed', 'cancelled')) = ("finished_at" IS NOT NULL)) AND
    ("status" NOT IN ('running', 'completed') OR "started_at" IS NOT NULL) AND
    (("status" = 'completed') = (
      "metrics_json" IS NOT NULL AND "provider_report_ids_json" IS NOT NULL
    )) AND
    (("status" IN ('failed', 'cancelled')) = ("error_json" IS NOT NULL))
  ),
  CONSTRAINT "evaluation_runs_v2_archive_status_check" CHECK (
    "archive_status" IN ('not_requested', 'pending', 'uploading', 'available', 'failed') AND
    "archive_attempt" >= 0
  ),
  CONSTRAINT "evaluation_runs_v2_artifact_shape_check" CHECK (
    (
      "result_artifact_key" IS NULL AND
      "result_artifact_digest" IS NULL AND
      "result_artifact_size_bytes" IS NULL
    ) OR (
      "result_artifact_key" IS NOT NULL AND
      octet_length("result_artifact_key") BETWEEN 1 AND 2048 AND
      "result_artifact_digest" IS NOT NULL AND
      "result_artifact_size_bytes" IS NOT NULL AND
      "result_artifact_size_bytes" >= 0
    )
  ),
  CONSTRAINT "evaluation_runs_v2_archive_shape_check" CHECK (
    ("archive_status" = 'available') = ("result_artifact_key" IS NOT NULL) AND
    ("archive_status" = 'failed') = ("archive_error_json" IS NOT NULL)
  )
);

CREATE INDEX "idx_evaluation_runs_v2_dataset"
  ON "evaluation_runs_v2"("namespace_id", "dataset_version", "created_at", "id");
CREATE INDEX "idx_evaluation_runs_v2_status"
  ON "evaluation_runs_v2"("namespace_id", "status", "created_at", "id");
