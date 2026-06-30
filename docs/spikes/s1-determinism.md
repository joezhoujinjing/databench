# S1 Determinism Spike

## Scope

Validate the two highest-risk parity assumptions before implementing the core engine:

- whether `nodejs-polars` can reproduce Python Polars seeded sampling on the existing bench data;
- whether the TS hashing path can match Python `canonical_json` + BLAKE3 byte-for-byte, including unicode, `null`, and integer-valued floats such as `1.0`.

Reference data is read-only:

- bench root: `/Users/hanlu/Desktop/databench/databench/bench`
- Python executable: `/Users/hanlu/Desktop/databench/databench/.venv/bin/python`

Re-run:

```bash
pnpm spike:s1
```

Machine-readable evidence is written to [`s1-determinism.results.json`](./s1-determinism.results.json).

## Result

S1 passes.

- Python Polars `1.41.2` vs `nodejs-polars` `0.25.1`.
- Sampling parity: `44 / 44` bench cases passed for seeds `0, 1, 7, 42`.
- Hashing parity: `2 / 2` canonical fixtures passed.
- Bench row hashing: `25 / 25` rows passed for payload canonical JSON, `Sample.id`, and `row_digest`.
- Empty dataset hash matched Python: `hashText("empty") = 6bdf3fe55052831d222fc6b82b2ba03f32b3599410fafd317642e21925c38f16`.

## Locked Engine Path

Use `nodejs-polars` as the primary in-process frame engine.

For seeded sampling, do not call the object overload:

```ts
// Do not use for seeded parity.
frame.sample({ n, seed })
```

`nodejs-polars@0.25.1` does not forward `opts.seed` in that overload. Use a small local wrapper around the positional API instead:

```ts
frame.sample(n, undefined, false, seed)
```

S6 must encode this in a golden test before exposing `sampleN`.

## Locked Hashing Path

Use `hash-wasm` BLAKE3 for TS hashing.

Canonical JSON must match Python:

- sorted object keys;
- separators `,` and `:` with no spaces;
- unicode emitted directly, not ASCII-escaped;
- `null` preserved;
- JSON number source lexemes preserved for hash-bound JSON inputs so `1.0` and `0.0` stay byte-compatible with Python.

Node 22 provides `JSON.parse` reviver source context, which the spike used to preserve integer-valued float lexemes. S2/S3/S5 must not parse hash-bound JSON through a path that loses this information before canonicalization.
