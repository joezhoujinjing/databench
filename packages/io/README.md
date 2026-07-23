# @databench/io

JSONL ingestion, sample-kind detection, normalization, and export shaping.

V2 public API includes canonical JSONL streaming plus the versioned
`canonical-jsonl`, TRL SFT/DPO/GRPO-RLVR, and ms-swift converter registry. Every
converter uses strict Zod-derived options, deterministic inspect/stream phases,
stable output ordering, and machine-readable fidelity changes.
