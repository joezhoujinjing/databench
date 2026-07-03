# @databench/io

JSONL ingestion, sample-kind detection, normalization, and export shaping.

Public API:

- `readJsonl(...)`: stream JSONL records into canonical samples with 1-based parse errors and source tagging.
- `recordToSample(...)`: normalize a single record into a `Sample`.
- `detectKind(...)`: Python-compatible sample kind detection.
- `exportRecord(...)`: shape samples for NDJSON export; current `fmt`/TRL behavior intentionally mirrors the legacy no-op branch.
