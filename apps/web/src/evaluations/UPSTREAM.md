# EvalScope upstream provenance

This directory is the Databench-owned destination for the EvalScope React UI business-capability port. It is not a
vendored SPA and must never import code from a checkout, submodule or the Python image.

The locked source is `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60` under
`evalscope/web/src`. The source contains 183 files, including 34 test files and 21,096 TypeScript/TSX lines.

Tracking files:

- `deploy/evalscope/upstream.lock` fixes repository, commit, dependency-file hashes, license and Plotly evidence.
- `upstream-manifest.json` tracks every locked source file and its SHA-256, planned target and file-level status.
- `ui-capability-manifest.json` is the capability-level acceptance source. A file marked adapted does not prove the
  interactions inside it are complete.
- `implemented-capabilities.json` is the reverse index. Every implemented target capability must be registered and
  green; unknown IDs and green-but-unregistered targets fail the checker.
- `pnpm evalscope:parity:check` is the E0 classification gate.
- `pnpm evalscope:parity:check:green` is the GE7 completion gate and must remain red until implemented targets,
  tests and browser evidence replace every planned locator.

Green test locators use `test-file:<repo-relative-path>#<test-name>`. Every green capability also needs at least one
existing `browser-file:<repo-relative-path>#<evidence-id>` locator; `upstream-code:` evidence may remain as provenance
but cannot replace migrated browser evidence.

Classifications are intentionally separate:

- `upstream-parity`: locked upstream business behavior;
- `security-replacement`: safe implementation that preserves the upstream user purpose;
- `databench-extension`: Databench-only behavior that cannot increase upstream coverage;
- `brand-shell-exclusion`: only duplicate application boot, navigation, theme, locale and upstream brand assets.

See `THIRD_PARTY_NOTICES.md`, ADR 0017 and `docs/evalscope/TECHNICAL-DESIGN.md` before porting a file. Keep the
applicable Apache-2.0 copyright and clearly mark modifications.
