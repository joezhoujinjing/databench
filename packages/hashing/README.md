# @databench/hashing

Deterministic hashing primitives: canonical JSON, BLAKE3, and digest helpers.

Public API:

- `canonicalJson(value)`: Python-compatible canonical JSON for hash inputs.
- `hashBytes(bytes)` / `hashText(text)` / `hashObj(value)`: BLAKE3 hex digests.
- `hashUnordered(digests)`: order-independent dataset version helper.
- `HASH_ALGO`: fixed hash algorithm identifier.

Hash-bound serialization must use this package; do not feed raw `JSON.stringify`
output into hashes elsewhere.
