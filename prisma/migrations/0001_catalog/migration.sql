CREATE TABLE IF NOT EXISTS "datasets" (
  "version" TEXT PRIMARY KEY,
  "name" TEXT,
  "num_rows" INTEGER NOT NULL,
  "kinds_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "runs" (
  "cache_key" TEXT PRIMARY KEY,
  "op" TEXT NOT NULL,
  "op_version" TEXT NOT NULL,
  "params_json" JSONB NOT NULL,
  "inputs_json" JSONB NOT NULL,
  "output_version" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_runs_output" ON "runs" ("output_version");

CREATE TABLE IF NOT EXISTS "refs" (
  "name" TEXT PRIMARY KEY,
  "version" TEXT NOT NULL,
  "message" TEXT,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
