# E9 security, capacity and offline release evidence

- Date: 2026-07-29
- Upstream: `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`
- State: local implementation complete; owner-approved merge with disconnected target validation deferred

## Release boundary

E9 does not expose an EvalScope SPA or make the general deployment profile public. The existing Web product remains
the Databench `/evaluations/*` route tree and the general EvalScope gateway remains disabled by default. The only
enabled runtime profile added by E9 is the ADR 0012 trusted-network offline bundle.

That bundle now contains seven digest-recorded `linux/amd64` images: API, Web, Python Worker, backend-only
EvalScope, PostgreSQL, MinIO and MinIO Client. EvalScope is reachable only as `evalscope:9000` on the Compose
network. It has no host port or GPU device, runs with a read-only root filesystem, and is bounded to 4 CPUs, 12 GiB
memory and 1024 PIDs. Persistent state is limited to the reviewed `outputs` and `inputs` bind mounts.

The locally built release-candidate EvalScope image is:

```text
tag: databench-evalscope:0.7.0
image: sha256:de904221050d23b73191df25c5efa2c66fe5255cefeeaeba48af7f8df50a0df0
platform: linux/amd64
```

The image started with Docker network mode `none` and a read-only root filesystem. Runtime inspection verified that
the upstream Web directory was absent, `/` returned 404, no CUDA/NVIDIA package or device path was present, public
config contained no filesystem path, the operator status endpoint was ready, and the local Plotly asset matched the
pinned SHA-256. This is a runtime-disconnection check of a prebuilt image; ADR 0017 explicitly does not require a
fresh source build with `docker build --network=none`.

On 2026-07-29 the repository actually produced the ignored local release candidate
`output/offline/databench-offline-0.7.0-linux-amd64.tar.gz`, built from commit
`fe63b26e1c681c27b9bb54f67d8bac34a5a149c4`. It contains all seven locked images and is 1.6 GiB.
The release manifest records `linux/amd64`, the exact image lock digest
`40d1d7bf7c9a948025b4a217456745c8f5f7b48d9de37f7e65ccef6a7e0028c7`, and the outer archive SHA-256 is
`a75c4816122671d5d02af79bb1463adfaa02fdb7842ac201a68ffa396328df5a`. The bundle builder's seven-image
executable smoke and inner checksums passed. The outer SHA-256, gzip stream and complete tar listing were then
verified locally.

## Admission, drain and capacity

The single-worker runtime has authenticated internal status, drain and resume controls. Drain establishes a
process-local admission fence before maintenance: new evaluation and performance invoke calls receive
`runtime_draining`, while existing progress, log, stop and report routes remain available. Active invoke accounting
is reported to the operator. Offline backup, restart, upgrade and rollback wait for zero active tasks for 300 seconds
by default; timeout resumes admission and aborts maintenance instead of killing an unrecorded task.

Evaluation and performance use separate bounded semaphores. Runtime configuration and task admission enforce:

- input, output, request, response, generated-document and archive byte ceilings;
- evaluation sample, batch and repeat ceilings;
- performance sweep width, parallelism, total request and request-rate ceilings;
- model token and per-request timeout ceilings;
- maximum task directories, per-kind concurrency and total task runtime.

Every operator-configurable value also has a compiled maximum, so an accidental environment change cannot remove
the safety boundary. Compose CPU, memory and PID limits are independent of application admission. The target still
requires filesystem monitoring because bind mounts do not provide a quota.

Python tests exercised authenticated drain/resume, active-task completion during drain, rejected new admission,
concurrency behavior, capacity failures before task claim, timeout termination and stable terminal replay.

## Exact gateway and active-content boundary

The browser gateway remains a compiled method + exact-path allowlist checked against the pinned route manifest.
Local API and offline smoke verification confirmed that these remain blocked:

- EvalScope root and static SPA paths;
- upstream resume and arbitrary report scan;
- an unclassified synthetic upstream endpoint;
- all internal operator endpoints.

The public `/api/v1/config` response remains path-free. Report/chart/performance documents continue through opaque
Databench generated-document IDs, sanitizer, nonce CSP and an iframe sandbox without `allow-same-origin`; raw active
HTML is not a top-level product route. Plotly is served only from the fixed local asset and its bytes are checked
against `6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603`.

The E3-E8 failure-injection suites that own task claim/reconciliation, same-ID and stop races, callback loss,
model-endpoint SSRF/DNS/redirect checks, malicious content, secret redaction and archive ordering remained green.
E9 did not replace those controls with deployment-only assumptions.

## Offline lifecycle and backup

Install creates or reuses `/etc/databench/evalscope.env` as `root:root 0600`. The file owns stable task-HMAC and
operator secrets, the trusted Databench origin, model endpoint allowlist and reviewed capacity values. It is not
browser-readable.

Application lifecycle order is Worker → API → EvalScope → Web. Maintenance stops Web admission first, drains
EvalScope, then stops API, EvalScope and Worker. Backup generations now cover PostgreSQL, MinIO, EvalScope outputs
and inputs, and encrypted Databench/MCP/EvalScope configuration escrow. The backup refuses symlinks, multiply linked
files and special files. Restore verifies that the tar contains exactly ordinary files/directories below both
`outputs` and `inputs`, with no traversal, duplicate member, link or alternate root, before extraction.
Restored descendants are then recursively assigned to the fixed EvalScope UID/GID; directories are normalized to
`0750` and regular files to `0640` instead of trusting archived ownership or mode bits.

Release parsing accepts historical five-image and six-image installed releases so an E9 release can retain the
existing rollback path. The operator guide documents status/drain/resume, capacity changes, failure handling and the
disconnected acceptance checklist. The upstream upgrade runbook requires source, route, capability, Python,
security and release compatibility matrices before moving the pinned commit.

## Local verification completed

The following completed locally and must not be confused with the remaining target-machine gate:

- EvalScope provider: 71 Python tests and `uv lock --check`;
- API gateway: 97 tests, including proof that the browser gateway blocks operator endpoints;
- exact route/parity checks, including the all-green capability manifest;
- runtime drain, timeout and capacity failure injection;
- offline script/static/Compose validation and seven-image contract;
- actual 1.6 GiB `0.7.0` seven-image offline bundle creation, inner/outer checksums and archive readability;
- pinned `linux/amd64` backend-only image inspection and network-none runtime;
- repository lint, build, typecheck, tests, OpenAPI, v2 status, peer, parity and offline checks completed during E9
  implementation.

No Web product code changed in E9. The owner excluded phone portrait from the current Web gate, and no repeat
browser acceptance was required for this deployment-only step.

## GE9 still pending

GE9 is not passed. A real Ubuntu 22.04 `linux/amd64` target with outbound network disabled must still execute the
released bundle through:

```text
install
→ select exact Databench Dataset
→ evaluation and native report
→ compare and performance
→ Databench callback and immutable archive
→ restart and reconciliation
→ upgrade
→ rollback
```

The target run must also repeat exact-route drift, same-ID/stop/callback-loss, malicious active content,
DNS-rebinding/redirect/metadata and zero-external-asset negative checks under the target network policy. It must
record the released bundle checksum, all seven image digests, task/run/report/archive identifiers, backup generation,
upgrade/rollback versions and console/network evidence.

On 2026-07-29 the owner approved merging the implementation and will execute this disconnected target validation
manually. Until that evidence is attached, `e9_implementation` is `complete` and `e9_gate` is
`owner_deferred_target`, not passed. E9 does not complete Databench V16/V17 and does not resolve the public-cloud D3
owner decision.
