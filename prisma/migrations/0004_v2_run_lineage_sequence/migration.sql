ALTER TABLE "runs_v2"
  ADD COLUMN "lineage_seq" BIGSERIAL NOT NULL;

ALTER SEQUENCE "runs_v2_lineage_seq_seq"
  OWNED BY "runs_v2"."lineage_seq";

CREATE UNIQUE INDEX "runs_v2_lineage_seq_key"
  ON "runs_v2" ("lineage_seq");

ALTER TABLE "runs_v2"
  ADD CONSTRAINT "runs_v2_lineage_seq_check"
  CHECK ("lineage_seq" > 0);
