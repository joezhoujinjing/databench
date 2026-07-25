-- R4 intentionally keeps this destructive change separate from application
-- startup. Empty legacy tables can be retired directly. Non-empty tables
-- require tooling/v1-retirement to write an exact, operator-confirmed approval
-- after a repeatable-read preflight.
DO $retire_v1$
DECLARE
  target_schema TEXT := current_schema();
  legacy_table TEXT;
  actual_count BIGINT;
  approved_count BIGINT;
  actual_rows_md5 TEXT;
  approved_rows_md5 TEXT;
  total_rows BIGINT := 0;
  approval_digest TEXT;
  approval_counts JSONB;
BEGIN
  FOREACH legacy_table IN ARRAY ARRAY[
    'datasets',
    'runs',
    'refs',
    'vocabularies',
    'vocab_refs'
  ]
  LOOP
    IF to_regclass(format('%I.%I', target_schema, legacy_table)) IS NOT NULL THEN
      EXECUTE format(
        'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
        target_schema,
        legacy_table
      );
      EXECUTE format(
        'SELECT count(*)::bigint FROM %I.%I',
        target_schema,
        legacy_table
      ) INTO actual_count;
      total_rows := total_rows + actual_count;
    END IF;
  END LOOP;

  IF total_rows > 0 THEN
    IF to_regclass(
      format('%I.%I', target_schema, '_databench_v1_retirement_approval')
    ) IS NULL THEN
      RAISE EXCEPTION
        'refusing to retire % v1 catalog rows without an operator-confirmed R4 preflight',
        total_rows
        USING HINT =
          'Run pnpm v1:retire preflight, review the manifest, then run approve-database with its exact digest.';
    END IF;

    EXECUTE format(
      'SELECT database_digest::text, table_counts
       FROM %I.%I
       WHERE singleton = TRUE',
      target_schema,
      '_databench_v1_retirement_approval'
    ) INTO approval_digest, approval_counts;

    IF approval_digest IS NULL OR approval_digest !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'the R4 database approval is missing or invalid';
    END IF;

    FOREACH legacy_table IN ARRAY ARRAY[
      'datasets',
      'runs',
      'refs',
      'vocabularies',
      'vocab_refs'
    ]
    LOOP
      actual_count := 0;
      IF to_regclass(format('%I.%I', target_schema, legacy_table)) IS NOT NULL THEN
        EXECUTE format(
          'SELECT count(*)::bigint FROM %I.%I',
          target_schema,
          legacy_table
        ) INTO actual_count;
      END IF;
      approved_count := (approval_counts -> legacy_table ->> 'row_count')::bigint;
      IF approved_count IS NULL OR approved_count <> actual_count THEN
        RAISE EXCEPTION
          'v1 table % changed after R4 approval: approved %, current %',
          legacy_table,
          approved_count,
          actual_count;
      END IF;

      IF to_regclass(format('%I.%I', target_schema, legacy_table)) IS NULL THEN
        actual_rows_md5 := md5('[]');
      ELSE
        EXECUTE format(
          'WITH rows AS (
             SELECT to_jsonb(value) AS row_json
             FROM %I.%I AS value
           )
           SELECT md5(
             COALESCE(
               jsonb_agg(row_json ORDER BY row_json::text),
               ''[]''::jsonb
             )::text
           )
           FROM rows',
          target_schema,
          legacy_table
        ) INTO actual_rows_md5;
      END IF;
      approved_rows_md5 := approval_counts -> legacy_table ->> 'rows_md5';
      IF approved_rows_md5 IS NULL OR approved_rows_md5 <> actual_rows_md5 THEN
        RAISE EXCEPTION
          'v1 table % contents changed after R4 approval',
          legacy_table;
      END IF;
    END LOOP;
  END IF;
END
$retire_v1$;

DROP TABLE IF EXISTS "vocab_refs";
DROP TABLE IF EXISTS "vocabularies";
DROP TABLE IF EXISTS "refs";
DROP TABLE IF EXISTS "runs";
DROP TABLE IF EXISTS "datasets";
DROP TABLE IF EXISTS "_databench_v1_retirement_approval";
