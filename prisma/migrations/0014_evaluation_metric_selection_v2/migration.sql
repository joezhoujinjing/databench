ALTER TABLE "evaluation_runs_v2"
  ADD COLUMN "scoring_config_json" JSONB,
  ADD COLUMN "primary_metric_id" TEXT,
  ADD COLUMN "primary_output_key" TEXT;

ALTER TABLE "evaluation_runs_v2"
  DROP CONSTRAINT "evaluation_runs_v2_create_profile_check",
  DROP CONSTRAINT "evaluation_runs_v2_deployment_shape_check",
  DROP CONSTRAINT "evaluation_runs_v2_json_bounds_check";

ALTER TABLE "evaluation_runs_v2"
  ADD CONSTRAINT "evaluation_runs_v2_create_profile_check" CHECK (
    "create_profile" IN (
      'evaluation-run-create-v1',
      'evaluation-run-create-v2',
      'evaluation-run-create-v3',
      'evaluation-run-create-v4'
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
    )
  ),
  ADD CONSTRAINT "evaluation_runs_v2_scoring_shape_check" CHECK (
    (
      "create_profile" IN ('evaluation-run-create-v1', 'evaluation-run-create-v2') AND
      "scoring_config_json" IS NULL AND
      "primary_metric_id" IS NULL AND
      "primary_output_key" IS NULL
    ) OR (
      "create_profile" IN ('evaluation-run-create-v3', 'evaluation-run-create-v4') AND
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
  ADD CONSTRAINT "evaluation_runs_v2_json_bounds_check" CHECK (
    jsonb_typeof("converter_options_json") = 'object' AND
    octet_length("converter_options_json"::text) <= 65536 AND
    ("provider_report_ids_json" IS NULL OR (
      jsonb_typeof("provider_report_ids_json") = 'array' AND
      jsonb_array_length("provider_report_ids_json") <= 32 AND
      octet_length("provider_report_ids_json"::text) <= 16512 AND
      NOT jsonb_path_exists("provider_report_ids_json", '$[*] ? (@.type() != "string")') AND
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
        '$[*].keyvalue() ? (@.key != "dataset" && @.key != "subset" && @.key != "metric_id" && @.key != "output_key" && @.key != "metric" && @.key != "score" && @.key != "sample_count" && @.key != "categories")'
      ) AND
      NOT jsonb_path_exists(
        "metrics_json",
        '$[*] ? (!exists(@.dataset) || @.dataset.type() != "string" || !exists(@.subset) || (@.subset.type() != "string" && @.subset.type() != "null") || !exists(@.metric) || @.metric.type() != "string" || !exists(@.score) || (@.score.type() != "number" && @.score.type() != "null") || !exists(@.sample_count) || (@.sample_count.type() != "number" && @.sample_count.type() != "null") || !exists(@.categories) || @.categories.type() != "array")'
      ) AND
      NOT jsonb_path_exists(
        "metrics_json",
        '$[*] ? ((exists(@.metric_id) && !exists(@.output_key)) || (!exists(@.metric_id) && exists(@.output_key)))'
      ) AND
      NOT jsonb_path_exists(
        "metrics_json",
        '$[*] ? (exists(@.metric_id) && ((@.metric_id.type() != "string" && @.metric_id.type() != "null") || (@.output_key.type() != "string" && @.output_key.type() != "null") || (@.metric_id.type() == "null" && @.output_key.type() != "null") || (@.metric_id.type() != "null" && @.output_key.type() == "null")))'
      ) AND
      NOT jsonb_path_exists("metrics_json", '$[*].categories[*] ? (@.type() != "string")') AND
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
  );
