CREATE TABLE IF NOT EXISTS "vocabularies" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT,
  "dimension" TEXT NOT NULL,
  "num_terms" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "vocab_refs" (
  "name" TEXT PRIMARY KEY,
  "vocab_id" TEXT NOT NULL,
  "status" TEXT,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vocab_refs_vocab_id_fkey" FOREIGN KEY ("vocab_id") REFERENCES "vocabularies" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
