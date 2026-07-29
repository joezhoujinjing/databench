# EvalScope operator runbook

This runbook owns the backend-only EvalScope integration after E9. It does not authorize a public-cloud deployment;
the only enabled release profile is the ADR 0012 trusted-network offline bundle. General API deployments remain
disabled unless their separate access-control and owner gates are approved.

## Service boundary

- Users open Databench `/evaluations/*`; there is no EvalScope SPA, logo or host port.
- Caddy sends `/evalscope-api/*` to Databench API. The API forwards only the compiled method + exact-path manifest.
- EvalScope calls Databench REST for exact Dataset export, run callback and archive; it never connects to PostgreSQL
  or receives a long-lived object-store credential.
- Model endpoints are operator allowlisted. Redirects, metadata/link-local/private destinations outside that
  allowlist and browser-supplied Dataset locators fail closed.
- Active HTML is converted to an opaque generated document with sanitizer, nonce CSP and sandbox framing. Raw HTML
  is never a top-level route. Plotly is a digest-pinned local asset.

## Readiness and diagnosis

```bash
sudo databenchctl status
sudo databenchctl doctor
sudo databenchctl evalscope-status
sudo databenchctl logs evalscope
```

`doctor` checks PostgreSQL, object storage and EvalScope health. A healthy process can still be draining; inspect
`evalscope-status` before submitting a task. Never paste operator tokens, signed upload URLs, prompts or predictions
into tickets or commands.

## Planned maintenance

`backup`, `restart`, `upgrade` and `rollback` already perform this sequence:

1. stop Web to remove ordinary browser admission;
2. authenticate directly to the internal drain endpoint;
3. reject new invoke while keeping progress/log/stop/report alive;
4. wait for `active_tasks=0` (default 300 seconds);
5. stop API, EvalScope and Worker;
6. perform the operation and restart API → EvalScope → Web;
7. run health, gateway and lifecycle smoke.

If the timeout expires, the operation aborts and resumes task admission. Ask users to stop or finish the active task,
then retry. Do not bypass drain with `docker kill`; a forced shutdown turns a task without terminal evidence into
`provider_interrupted` during startup reconciliation.

Manual controls:

```bash
sudo databenchctl evalscope-drain
sudo databenchctl evalscope-status
sudo databenchctl evalscope-resume
```

## Capacity changes

The offline defaults are 4 CPUs, 12 GiB memory, no GPU, 2 concurrent evaluation tasks, 2 concurrent performance
tasks, 24-hour task runtime, 1 GiB input, 4 GiB output, 1 GiB archive, 100,000 evaluation samples, 256 evaluation
batch size, 10 repeats, 256 performance parallelism, 1,000,000 performance requests, 10,000 requests/s,
32,768 model tokens and a 3,600-second per-request timeout. Runtime admission and Compose limits are independent:
both must remain configured.

Capacity values live in `/etc/databench/evalscope.env`; change them only in a maintenance window, retain
`root:root 0600`, restart, and run a small exact Dataset evaluation. The runtime rejects values above compiled safety
ceilings. Host filesystem monitoring is still required because bind mounts do not provide quota.

## Backup and restore

One consistent offline backup generation contains:

- PostgreSQL dump and migration list;
- MinIO mirror, including immutable evaluation archives;
- EvalScope `outputs` and `inputs` volume archive;
- encrypted Databench, MCP and EvalScope config escrow;
- release/bundle identity and checksums.

Store the generation, matching release bundle and backup key on independent media. Restore the same generation as a
unit; restoring only PostgreSQL, MinIO or EvalScope output creates an inconsistent product. After restore, verify one
online report, one archive locator, restart reconciliation and one new callback/archive lifecycle.
Backup rejects links and special files in the EvalScope volume; restore revalidates that every tar member is a regular
file or directory rooted exactly under `outputs` or `inputs` before root extraction, then normalizes every descendant
to the fixed runtime UID/GID with `0750` directory and `0640` file permissions.

## Failure handling

| Symptom | Safe action |
|---|---|
| gateway 503 | Check API and EvalScope health; do not expose port 9000 as a workaround |
| `runtime_draining` | Wait for maintenance or ask the operator to resume |
| capacity error | Reduce task size/concurrency or change reviewed limits during maintenance |
| `provider_interrupted` | Inspect persisted terminal state and run authenticated reconciliation |
| online unavailable, archive available | Restore the matching EvalScope output backup; E8 does not reconstruct online output from archive |
| archive failed | Keep execution result; retry a new archive attempt after correcting the policy/storage cause |
| Plotly/document failure | Verify pinned asset digest, CSP and generated-document route; never fall back to a CDN/raw HTML URL |

The deployment-specific commands and disconnected target checklist are in
`deploy/offline/EVALSCOPE-OPERATOR-GUIDE.zh-CN.md`.
