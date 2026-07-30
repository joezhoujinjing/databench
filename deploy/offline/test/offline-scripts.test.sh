#!/usr/bin/env bash

set -Eeuo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/databench-offline-test.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
  printf 'offline test failed: %s\n' "$*" >&2
  exit 1
}

while IFS= read -r script; do
  bash -n "$script"
done < <(find "$SCRIPT_DIR" -type f \( -name '*.sh' -o -name databenchctl \) | LC_ALL=C sort)
node --check "${SCRIPT_DIR}/smoke/gateway.mjs"
node --check "${SCRIPT_DIR}/smoke/mcp.mjs"
node --check "${SCRIPT_DIR}/smoke/upstream-failure.mjs"
node --check "${SCRIPT_DIR}/smoke/worker.mjs"

if rg -n 'docker compose down -v|image:.*latest|build:' \
  "${SCRIPT_DIR}/compose.yml" "${SCRIPT_DIR}/compose.swift-gpu.yml" \
  "${SCRIPT_DIR}"/*.sh "${SCRIPT_DIR}/databenchctl"; then
  fail 'offline runtime contains a forbidden destructive, latest, or build directive'
fi

if rg -n 'docker image inspect --platform' "${SCRIPT_DIR}/lib" "${SCRIPT_DIR}"/{install,upgrade,rollback,backup,restore}.sh; then
  fail 'target runtime uses inspect --platform, which is newer than Docker Engine 24'
fi

grep -q 'pull_policy: never' "${SCRIPT_DIR}/compose.yml" || fail 'pull_policy is not disabled'
grep -Fq '/etc/databench/mcp.env' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline API does not load the dedicated MCP configuration'
grep -Fq 'handle_path /api/*' "${SCRIPT_DIR}/Caddyfile" ||
  fail 'Caddy does not proxy and strip the dedicated /api prefix'
if rg -n '@v2SpaNavigation|header Accept|@api path .* /v[12]/\*' "${SCRIPT_DIR}/Caddyfile"; then
  fail 'Caddy still multiplexes SPA and API requests by Accept'
fi
grep -Fq 'VITE_DATABENCH_API_BASE_URL=/api' "${SCRIPT_DIR}/Dockerfile.web" ||
  fail 'offline Web image does not default the API base to /api'
grep -Fq 'VITE_DATABENCH_API_BASE_URL=/api' "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not pin the Web API base to /api'
grep -Fq 'fetch("http://web/api/health")' "${SCRIPT_DIR}/lib/health.sh" ||
  fail 'gateway readiness does not check the prefixed API health endpoint'
grep -Fq 'includes("application/json")' "${SCRIPT_DIR}/lib/health.sh" ||
  fail 'gateway readiness does not require a JSON response'
grep -Fq 'body?.status === "ok"' "${SCRIPT_DIR}/lib/health.sh" ||
  fail 'gateway readiness does not validate the health payload'
grep -Fq 'DATABENCH_OPENAPI_SERVER_URL: "/api"' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline API does not advertise the external /api OpenAPI server URL'
grep -Fq 'DATABENCH_WORKER_ENABLED: "true"' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline API does not explicitly enable the Worker runtime'
grep -Fq 'DATABENCH_WORKER_TARGET: "worker:50051"' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline API does not use the private Compose Worker target'
grep -Fq 'image: ${DATABENCH_WORKER_IMAGE:?missing DATABENCH_WORKER_IMAGE}' \
  "${SCRIPT_DIR}/compose.yml" || fail 'offline Compose does not require the Worker image'
grep -Fq 'image: ${DATABENCH_EVALSCOPE_IMAGE:?missing DATABENCH_EVALSCOPE_IMAGE}' \
  "${SCRIPT_DIR}/compose.yml" || fail 'offline Compose does not require the EvalScope image'
grep -Fq 'image: ${DATABENCH_SWIFT_IMAGE:?missing DATABENCH_SWIFT_IMAGE}' \
  "${SCRIPT_DIR}/compose.yml" || fail 'offline Compose does not require the Swift Studio image'
grep -Fq 'profiles: ["swift-studio"]' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline Swift Studio is not isolated behind its explicit Studio profile'
grep -Fq '/srv/databench/swift-studio:/var/lib/databench-swift-studio' \
  "${SCRIPT_DIR}/compose.yml" || fail 'Swift Studio Session workspace is not persistent'
grep -Fq '/srv/databench/swift-models:/opt/databench-models:ro' \
  "${SCRIPT_DIR}/compose.yml" || fail 'offline models are not mounted read-only into Swift Studio'
grep -Fq 'shm_size: 8gb' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline Swift Studio does not reserve enough shared memory for PyTorch workers'
grep -Fq 'body.get('\''ready'\'') is True' "${SCRIPT_DIR}/compose.yml" ||
  fail 'Swift Studio UI-only health does not require the native Studio runtime'
grep -Fq 'gpu_available' "${SCRIPT_DIR}/compose.swift-gpu.yml" ||
  fail 'Swift Studio GPU overlay health does not require the selected GPU'
grep -Fq 'driver: nvidia' "${SCRIPT_DIR}/compose.swift-gpu.yml" ||
  fail 'Swift Studio GPU overlay does not request the NVIDIA runtime'
if sed -n '/^  swift-studio:/,/^  api:/p' "${SCRIPT_DIR}/compose.yml" |
  grep -Eq '^[[:space:]]+ports:'; then
  fail 'offline Swift Studio publishes a host port'
fi
grep -Fq 'DATABENCH_EVALSCOPE_ENABLED: "true"' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline API does not enable the scoped EvalScope gateway'
grep -Fq 'DATABENCH_EVALSCOPE_INTERNAL_BASE_URL: "http://evalscope:9000"' \
  "${SCRIPT_DIR}/compose.yml" || fail 'offline API does not use the private EvalScope origin'
grep -Fq '/srv/databench/evalscope/outputs:/var/lib/evalscope/outputs' \
  "${SCRIPT_DIR}/compose.yml" || fail 'EvalScope outputs are not persistent'
grep -Fq '/srv/databench/evalscope/inputs:/var/lib/evalscope/inputs' \
  "${SCRIPT_DIR}/compose.yml" || fail 'EvalScope inputs are not persistent'
grep -Fq 'NVIDIA_VISIBLE_DEVICES: "void"' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline EvalScope does not disable GPU device admission'
grep -Fq 'mem_limit: 12g' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline EvalScope memory is not bounded'
grep -Fq 'cpus: 4.0' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline EvalScope CPU is not bounded'
if sed -n '/^  evalscope:/,/^  api:/p' "${SCRIPT_DIR}/compose.yml" | grep -Eq '^[[:space:]]+ports:'; then
  fail 'offline EvalScope publishes a host port'
fi
if rg -n 'ipv4_address:|subnet:' "${SCRIPT_DIR}/compose.yml"; then
  fail 'offline Worker must use Compose DNS so upgrades do not depend on a fixed subnet'
fi
grep -Fq '/app/.venv/bin/databench-worker-healthcheck' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline Worker does not use its gRPC healthcheck'
grep -Fq '/tmp:size=4g,mode=1777' "${SCRIPT_DIR}/compose.yml" ||
  fail 'offline Worker does not have bounded ephemeral job storage'
if sed -n '/^  worker:/,/^  api:/p' "${SCRIPT_DIR}/compose.yml" | grep -Eq '^[[:space:]]+ports:'; then
  fail 'offline Worker publishes a host port'
fi
grep -Fq 'workers/python/Dockerfile' "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not build the Worker image'
grep -Fq 'deploy/evalscope/Dockerfile' "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not build the pinned EvalScope image'
grep -Fq 'deploy/swift-studio/Dockerfile' "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not build the pinned Swift Studio image'
grep -Fq 'torch.version.cuda is None' "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not reject a CUDA-enabled Worker image'
grep -Fq 'name.startswith("nvidia-")' "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not reject NVIDIA Worker packages'
grep -Fq 'saving eight images' "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not save the eight-image release set'
grep -Fq 'Swift Studio Provider and native Gradio readiness smoke without a GPU' \
  "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not smoke the packaged native Swift runtime'
[ "$(grep -Ec '^[[:space:]]*log([[:space:]]|$)' "${SCRIPT_DIR}/Caddyfile")" -eq 1 ] ||
  fail 'Caddy must configure exactly one redacted runtime logger and no access logger'
grep -Fq 'format filter' "${SCRIPT_DIR}/Caddyfile" ||
  fail 'Caddy runtime logging does not use the filter encoder'
grep -Fq 'request>uri delete' "${SCRIPT_DIR}/Caddyfile" ||
  fail 'Caddy runtime logging does not delete request URIs'
grep -Fq '/datasets/system-offline-smoke-v2' "${SCRIPT_DIR}/smoke/gateway.mjs" ||
  fail 'offline smoke does not cover the dataset SPA page path'
grep -Fq '/api/v2/datasets/system-offline-smoke-v2' "${SCRIPT_DIR}/smoke/gateway.mjs" ||
  fail 'offline smoke does not cover the distinct v2 API path'
grep -Fq "document.servers[0]?.url !== '/api'" "${SCRIPT_DIR}/smoke/gateway.mjs" ||
  fail 'offline smoke does not verify the external OpenAPI server URL'
grep -Fq '/api/mcp' "${SCRIPT_DIR}/smoke/gateway.mjs" ||
  fail 'offline gateway smoke does not cover the MCP route'
grep -Fq 'LOG_SERVICES+=(swift-studio)' "${SCRIPT_DIR}/smoke.sh" ||
  fail 'offline smoke does not include an enabled Swift Studio in log leak checks'
grep -Fq '/evalscope-api/api/v1/config' "${SCRIPT_DIR}/smoke/gateway.mjs" ||
  fail 'offline smoke does not verify the path-free EvalScope public config'
grep -Fq '/evalscope-api/api/v1/eval/resume/invoke' "${SCRIPT_DIR}/smoke/gateway.mjs" ||
  fail 'offline smoke does not verify blocked EvalScope endpoints'
grep -Fq "createHash('sha256')" "${SCRIPT_DIR}/smoke/gateway.mjs" ||
  fail 'offline smoke does not verify the local Plotly digest'
grep -Fq '/internal/v1/operator/drain' "${SCRIPT_DIR}/smoke.sh" ||
  fail 'offline smoke does not verify EvalScope drain'
grep -Fq 'upstream-failure.mjs' "${SCRIPT_DIR}/smoke.sh" ||
  fail 'offline smoke does not probe Caddy logging while the API is unavailable'
smoke_stopped_flag_line="$(grep -nF 'API_STOPPED=true' "${SCRIPT_DIR}/smoke.sh" | cut -d: -f1)"
smoke_stop_line="$(grep -nF 'compose_for_release "$SCRIPT_DIR" stop api' "${SCRIPT_DIR}/smoke.sh" | cut -d: -f1)"
[ "$smoke_stopped_flag_line" -lt "$smoke_stop_line" ] ||
  fail 'offline smoke must arm API recovery before attempting to stop the API'
grep -Fq 'mcp-smoke.mjs' "${SCRIPT_DIR}/smoke.sh" ||
  fail 'offline lifecycle smoke does not run the MCP SDK client'
grep -Fq 'worker-smoke.mjs' "${SCRIPT_DIR}/smoke.sh" ||
  fail 'offline lifecycle smoke does not run the canonical Worker client'
grep -Fq '/v2/transforms/basic-clean/jobs' "${SCRIPT_DIR}/smoke/worker.mjs" ||
  fail 'offline Worker smoke does not submit basic-clean'
grep -Fq 'system-offline-smoke-clean-v2' "${SCRIPT_DIR}/smoke/worker.mjs" ||
  fail 'offline Worker smoke does not verify create-only result naming'
grep -Fq 'X-Amz-Signature' "${SCRIPT_DIR}/smoke.sh" ||
  fail 'offline smoke does not reject signed URL leakage in logs'
grep -Fq 'canonical-draft-jsonl-v1' "${SCRIPT_DIR}/smoke/mcp.mjs" ||
  fail 'offline MCP smoke does not cover canonical draft processing'
grep -Fq "'active file limit did not return 429'" "${SCRIPT_DIR}/smoke/mcp.mjs" ||
  fail 'offline MCP smoke does not verify 429 retry backpressure'
grep -Fq "'stalled uploads left draft spools behind'" "${SCRIPT_DIR}/smoke/mcp.mjs" ||
  fail 'offline MCP smoke does not verify abort cleanup'
grep -Fq 'databench dataset audit system-offline-smoke-v2' "${SCRIPT_DIR}/smoke.sh" ||
  fail 'offline smoke does not audit the committed v2 dataset'
grep -Fq 'databench ref show system-offline-smoke-v2' "${SCRIPT_DIR}/lib/health.sh" ||
  fail 'offline doctor does not verify the retained smoke ref in PostgreSQL'
grep -Fq 'databench dataset audit system-offline-smoke-v2' "${SCRIPT_DIR}/lib/health.sh" ||
  fail 'offline doctor does not verify the retained smoke dataset in object storage'
if rg -n 'databench meta doctor' \
  "${SCRIPT_DIR}/lib" "${SCRIPT_DIR}"/*.sh "${SCRIPT_DIR}/databenchctl"; then
  fail 'offline runtime still invokes the retired meta doctor command'
fi
install_smoke_line="$(grep -nF '"${RELEASE_DIR}/smoke.sh"' "${SCRIPT_DIR}/install.sh" | cut -d: -f1)"
install_doctor_line="$(grep -nF 'run_doctor "$RELEASE_DIR"' "${SCRIPT_DIR}/install.sh" | cut -d: -f1)"
[ "$install_smoke_line" -lt "$install_doctor_line" ] ||
  fail 'first install must create the retained smoke dataset before running doctor'
if rg -n \
  'databench v2|databench dataset add|http://web/api/v1/|/api/v1/(datasets|refs|converters|transforms)|system-offline-smoke-v1|smoke/v1\.jsonl|v1/v2' \
  "${SCRIPT_DIR}/smoke.sh" \
  "${SCRIPT_DIR}/smoke/gateway.mjs" \
  "${SCRIPT_DIR}/README.zh-CN.md" \
  "${SCRIPT_DIR}/DEPLOYMENT-GUIDE.zh-CN.md" \
  "${SCRIPT_DIR}/TROUBLESHOOTING.zh-CN.md"; then
  fail 'offline release still references a retired v1 product surface'
fi

for document in README.zh-CN.md DEPLOYMENT-GUIDE.zh-CN.md TROUBLESHOOTING.zh-CN.md \
  MCP-AGENT-GUIDE.zh-CN.md EVALSCOPE-OPERATOR-GUIDE.zh-CN.md \
  SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md; do
  [ -f "${SCRIPT_DIR}/${document}" ] || fail "offline document is missing: $document"
done
if rg -n 'http://127\.0\.0\.1/(health|version|capabilities|openapi\.json|v1/)' \
  "${SCRIPT_DIR}/DEPLOYMENT-GUIDE.zh-CN.md" "${SCRIPT_DIR}/TROUBLESHOOTING.zh-CN.md"; then
  fail 'offline documentation still uses an unprefixed external API URL'
fi
grep -Fq 'http://127.0.0.1/api/version' "${SCRIPT_DIR}/DEPLOYMENT-GUIDE.zh-CN.md" ||
  fail 'deployment guide does not verify the prefixed version endpoint'
grep -Fq '默认 API base 应为 `/api`' "${SCRIPT_DIR}/TROUBLESHOOTING.zh-CN.md" ||
  fail 'troubleshooting guide does not explain the offline API base'
grep -Fq '(DEPLOYMENT-GUIDE.zh-CN.md)' "${SCRIPT_DIR}/README.zh-CN.md" ||
  fail 'README does not link the deployment guide'
grep -Fq '(TROUBLESHOOTING.zh-CN.md)' "${SCRIPT_DIR}/README.zh-CN.md" ||
  fail 'README does not link the troubleshooting guide'
for bundle_asset in \
  deploy/offline/DEPLOYMENT-GUIDE.zh-CN.md \
  deploy/offline/TROUBLESHOOTING.zh-CN.md \
  deploy/offline/MCP-AGENT-GUIDE.zh-CN.md \
  deploy/offline/EVALSCOPE-OPERATOR-GUIDE.zh-CN.md \
  deploy/offline/SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md \
  deploy/offline/mcp.env.example \
  deploy/offline/evalscope.env.example \
  deploy/offline/swift.env.example \
  deploy/offline/compose.swift-gpu.yml \
  docs/deployment/offline-single-host-plan.zh-CN.md \
  docs/decisions/0012-offline-single-host-deployment.md \
  docs/decisions/0018-ms-swift-native-gradio-studio.md \
  'docs/ADR-0012.md'; do
  grep -Fq "$bundle_asset" "${SCRIPT_DIR}/build-bundle.sh" ||
    fail "bundle builder does not include: $bundle_asset"
done
for release_asset in DEPLOYMENT-GUIDE.zh-CN.md TROUBLESHOOTING.zh-CN.md \
  MCP-AGENT-GUIDE.zh-CN.md EVALSCOPE-OPERATOR-GUIDE.zh-CN.md \
  SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md mcp.env.example evalscope.env.example \
  swift.env.example compose.swift-gpu.yml docs; do
  grep -Fq "$release_asset" "${SCRIPT_DIR}/lib/common.sh" ||
    fail "installed release does not preserve: $release_asset"
done

mkdir -p "${TEMP_DIR}/release"
cat > "${TEMP_DIR}/release/release.env" <<'EOF'
DATABENCH_VERSION=1.2.3
DATABENCH_API_IMAGE=databench-api:1.2.3
DATABENCH_WEB_IMAGE=databench-web:1.2.3
DATABENCH_WORKER_IMAGE=databench-worker:1.2.3
DATABENCH_EVALSCOPE_IMAGE=databench-evalscope:1.2.3
DATABENCH_SWIFT_IMAGE=databench-swift-studio:1.2.3
DATABENCH_SWIFT_IMAGE_DIGEST=8888888888888888888888888888888888888888888888888888888888888888
DATABENCH_POSTGRES_IMAGE=databench-offline/postgres:1111111111111111
DATABENCH_MINIO_IMAGE=databench-offline/minio:2222222222222222
DATABENCH_MINIO_MC_IMAGE=databench-offline/minio-mc:3333333333333333
EOF

cat > "${TEMP_DIR}/release/images.lock" <<'EOF'
# databench offline images lock v1
databench-api:1.2.3|sha256:1111111111111111111111111111111111111111111111111111111111111111|linux/amd64|git:1111111111111111111111111111111111111111
databench-web:1.2.3|sha256:2222222222222222222222222222222222222222222222222222222222222222|linux/amd64|git:1111111111111111111111111111111111111111
databench-worker:1.2.3|sha256:3333333333333333333333333333333333333333333333333333333333333333|linux/amd64|git:1111111111111111111111111111111111111111
databench-evalscope:1.2.3|sha256:4444444444444444444444444444444444444444444444444444444444444444|linux/amd64|evalscope:b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60
databench-swift-studio:1.2.3|sha256:8888888888888888888888888888888888888888888888888888888888888888|linux/amd64|ms-swift:f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d
databench-offline/postgres:1111111111111111|sha256:5555555555555555555555555555555555555555555555555555555555555555|linux/amd64|postgres:17.6-alpine
databench-offline/minio:2222222222222222|sha256:6666666666666666666666666666666666666666666666666666666666666666|linux/amd64|minio/minio:RELEASE.2025-09-07T16-13-09Z
databench-offline/minio-mc:3333333333333333|sha256:7777777777777777777777777777777777777777777777777777777777777777|linux/amd64|minio/mc:RELEASE.2025-08-13T08-35-41Z
EOF

if command -v sha256sum >/dev/null 2>&1; then
  LOCK_SHA="$(sha256sum "${TEMP_DIR}/release/images.lock" | awk '{print $1}')"
else
  LOCK_SHA="$(shasum -a 256 "${TEMP_DIR}/release/images.lock" | awk '{print $1}')"
fi

grep -Fq 'ensure_mcp_config' "${SCRIPT_DIR}/install.sh" ||
  fail 'offline install does not create the explicit MCP configuration'
grep -Fq 'ensure_mcp_config' "${SCRIPT_DIR}/upgrade.sh" ||
  fail 'offline upgrade does not preserve or create the MCP configuration'
grep -Fq 'ensure_evalscope_config' "${SCRIPT_DIR}/install.sh" ||
  fail 'offline install does not create the stable EvalScope configuration'
grep -Fq 'ensure_evalscope_config' "${SCRIPT_DIR}/upgrade.sh" ||
  fail 'offline upgrade does not preserve or create the EvalScope configuration'
grep -Fq 'ensure_swift_config' "${SCRIPT_DIR}/install.sh" ||
  fail 'offline install does not create the explicit Swift GPU configuration'
grep -Fq 'ensure_swift_config' "${SCRIPT_DIR}/upgrade.sh" ||
  fail 'offline upgrade does not preserve or explicitly change the Swift GPU configuration'
upgrade_swift_config_line="$(
  grep -nF '  ensure_swift_config' "${SCRIPT_DIR}/upgrade.sh" | cut -d: -f1
)"
upgrade_backup_line="$(
  grep -nF '"${PREVIOUS_RELEASE}/backup.sh" --api-already-stopped' \
    "${SCRIPT_DIR}/upgrade.sh" | cut -d: -f1
)"
[ "$upgrade_swift_config_line" -gt "$upgrade_backup_line" ] ||
  fail 'offline upgrade changes the Swift enabled state before backing up the previous release'
grep -Fq 'set_swift_enabled_state "$PREVIOUS_SWIFT_ENABLED"' "${SCRIPT_DIR}/upgrade.sh" ||
  fail 'offline upgrade recovery does not restore the previous Swift enabled state'
grep -Fq 'verify_swift_gpu_runtime' "${SCRIPT_DIR}/install.sh" ||
  fail 'offline install does not verify the selected GPU with the packaged Swift image'
grep -Fq 'ensure_evalscope_data_directories' "${SCRIPT_DIR}/upgrade.sh" ||
  fail 'offline upgrade does not initialize EvalScope persistent directories'
upgrade_evalscope_dirs_line="$(
  grep -nF 'ensure_evalscope_data_directories' "${SCRIPT_DIR}/upgrade.sh" | cut -d: -f1
)"
upgrade_stop_line="$(
  grep -nF 'stop_application_services "$PREVIOUS_RELEASE"' "${SCRIPT_DIR}/upgrade.sh" | cut -d: -f1
)"
[ "$upgrade_evalscope_dirs_line" -lt "$upgrade_stop_line" ] ||
  fail 'offline upgrade must initialize EvalScope directories before stopping the previous release'
grep -Fq 'force_stop_application_services "$TARGET_RELEASE"' "${SCRIPT_DIR}/upgrade.sh" ||
  fail 'offline upgrade recovery cannot force-stop an unhealthy target release'
grep -Fq 'remove_application_services_absent_from_release' "${SCRIPT_DIR}/upgrade.sh" ||
  fail 'offline upgrade recovery does not remove target-only service containers'
grep -Fq 'remove_application_services_absent_from_release' "${SCRIPT_DIR}/rollback.sh" ||
  fail 'offline rollback does not remove service containers absent from the selected release'
grep -Fq 'readlink -f "${BASH_SOURCE[0]}"' "${SCRIPT_DIR}/databenchctl" ||
  fail 'databenchctl does not resolve the installed symlink before loading release libraries'
grep -Fq 'evalscope-volume.tar' "${SCRIPT_DIR}/backup.sh" ||
  fail 'offline backup does not capture the EvalScope persistent volume'
grep -Fq 'evalscope-volume.tar' "${SCRIPT_DIR}/restore.sh" ||
  fail 'offline restore does not restore the EvalScope persistent volume'
grep -Fq 'assert_evalscope_volume_tree_safe' "${SCRIPT_DIR}/backup.sh" ||
  fail 'offline backup does not reject unsafe EvalScope volume members'
grep -Fq 'validate_evalscope_volume_archive' "${SCRIPT_DIR}/restore.sh" ||
  fail 'offline restore does not validate the EvalScope archive member allowlist'
grep -Fq 'chown -R 10001:10001' "${SCRIPT_DIR}/restore.sh" ||
  fail 'offline restore does not normalize EvalScope volume ownership'
grep -Fq -- '-type f -exec chmod 0640' "${SCRIPT_DIR}/restore.sh" ||
  fail 'offline restore does not normalize EvalScope file permissions'
grep -Fq 'evalscope.env.enc' "${SCRIPT_DIR}/backup.sh" ||
  fail 'offline backup does not escrow the EvalScope stable secrets'
grep -Fq 'swift-studio-workspace.tar' "${SCRIPT_DIR}/backup.sh" ||
  fail 'offline backup does not capture the Swift Studio Session workspace'
grep -Fq 'swift-studio-workspace.tar' "${SCRIPT_DIR}/restore.sh" ||
  fail 'offline restore does not restore the Swift Studio Session workspace'
grep -Fq 'swift.env.enc' "${SCRIPT_DIR}/backup.sh" ||
  fail 'offline backup does not escrow the Swift Provider credential'
grep -Fq 'assert_swift_idle' "${SCRIPT_DIR}/lib/common.sh" ||
  fail 'offline maintenance does not refuse to kill an active native Swift task'
stop_function="$(
  sed -n '/^stop_application_services()/,/^}/p' "${SCRIPT_DIR}/lib/common.sh"
)"
stop_web_line="$(grep -nF 'stop web' <<< "$stop_function" | head -n 1 | cut -d: -f1)"
stop_swift_idle_line="$(grep -nF 'assert_swift_idle' <<< "$stop_function" | cut -d: -f1)"
[ "$stop_web_line" -lt "$stop_swift_idle_line" ] ||
  fail 'offline maintenance must stop Web admission before checking Swift native tasks'
grep -Fq 'assert_swift_session_transition_compatible' "${SCRIPT_DIR}/upgrade.sh" ||
  fail 'offline upgrade does not fence active Sessions across Swift image or enabled-state changes'
grep -Fq 'assert_swift_session_transition_compatible' "${SCRIPT_DIR}/rollback.sh" ||
  fail 'offline rollback does not fence active Sessions across Swift image changes'
grep -Fq 'verify_swift_model_preload' "${SCRIPT_DIR}/install.sh" ||
  fail 'offline install does not require a preloaded model when Swift is enabled'
grep -Fq 'verify_swift_model_preload' "${SCRIPT_DIR}/upgrade.sh" ||
  fail 'offline upgrade does not require a preloaded model when enabling Swift'
start_function="$(
  sed -n '/^start_application_services()/,/^}/p' "${SCRIPT_DIR}/lib/health.sh"
)"
grep -Fq 'assert_swift_session_transition_compatible' <<< "$start_function" ||
  fail 'disabled Swift startup does not reject a stale active Studio Session'
start_session_line="$(
  grep -nF 'assert_swift_session_transition_compatible' <<< "$start_function" | cut -d: -f1
)"
start_remove_line="$(grep -nF 'rm --stop --force swift-studio' <<< "$start_function" | cut -d: -f1)"
[ "$start_session_line" -lt "$start_remove_line" ] ||
  fail 'disabled Swift startup removes the container before checking active Session lineage'
grep -Fq 'current Swift enabled state does not match the backup' "${SCRIPT_DIR}/restore.sh" ||
  fail 'offline restore does not reject a Swift enabled-state mismatch'
grep -Fq '! -name cache ! -name home -delete' "${SCRIPT_DIR}/restore.sh" ||
  fail 'offline restore does not mirror the Swift workspace while preserving cache and home'
grep -Fq 'databenchctl restart' "${SCRIPT_DIR}/upgrade.sh" ||
  fail 'offline upgrade recovery does not print a profile-aware manual restart command'
grep -Fq 'drain_evalscope' "${SCRIPT_DIR}/lib/common.sh" ||
  fail 'offline service stop does not drain EvalScope'
grep -Fq "stat -c '%U:%G'" "${SCRIPT_DIR}/lib/config.sh" ||
  fail 'offline MCP configuration does not enforce root ownership'
grep -Fq 'DATABENCH_MCP_ENABLED=true' "${SCRIPT_DIR}/mcp.env.example" ||
  fail 'offline MCP example is not explicitly enabled'
grep -Fq 'DATABENCH_MCP_AUTH_MODE=none' "${SCRIPT_DIR}/mcp.env.example" ||
  fail 'offline MCP example does not declare anonymous mode'
grep -Fq 'DATABENCH_MIN_WORKSPACE_FREE_GB' "${SCRIPT_DIR}/lib/preflight.sh" ||
  fail 'offline preflight does not check the Databench data filesystem'
grep -Fq 'default_min_cpus=6' "${SCRIPT_DIR}/lib/preflight.sh" ||
  fail 'offline UI-only preflight does not use the control-plane CPU floor'
grep -Fq 'default_min_memory_gb=15' "${SCRIPT_DIR}/lib/preflight.sh" ||
  fail 'offline UI-only preflight does not use the control-plane memory floor'
grep -Fq "swift_mode\" = 'gpu'" "${SCRIPT_DIR}/lib/preflight.sh" ||
  fail 'offline preflight does not retain the explicit GPU capacity branch'
grep -Fq 'DATABENCH_MIN_FREE_GB:-60' "${SCRIPT_DIR}/lib/preflight.sh" ||
  fail 'offline preflight does not enforce the installation disk floor'
for lifecycle_script in install.sh upgrade.sh rollback.sh backup.sh restore.sh databenchctl; do
  grep -Eq 'start_application_services|stop_application_services' \
    "${SCRIPT_DIR}/${lifecycle_script}" ||
    fail "${lifecycle_script} bypasses the version-aware Worker application lifecycle"
done
for health_script in install.sh upgrade.sh rollback.sh restore.sh; do
  grep -Fq 'wait_application_services' "${SCRIPT_DIR}/${health_script}" ||
    fail "${health_script} does not wait for the selected release application health"
done
for image_validation_script in install.sh upgrade.sh; do
  grep -Fq 'release_image_count "$SCRIPT_DIR"' "${SCRIPT_DIR}/${image_validation_script}" ||
    fail "${image_validation_script} infers the target image count from ambient release state"
done
grep -Fq 'release_image_count "$release_dir"' "${SCRIPT_DIR}/lib/manifest.sh" ||
  fail 'release contract validation infers the image count from ambient release state'
(
  # shellcheck source=../lib/common.sh
  source "${SCRIPT_DIR}/lib/common.sh"
  # shellcheck source=../lib/config.sh
  source "${SCRIPT_DIR}/lib/config.sh"
  validate_mcp_public_base_url 'http://databench.internal/api'
  validate_mcp_public_base_url 'https://10.20.30.40:8443/api'
  validate_mcp_origins ''
  validate_mcp_origins ' https://agent.example, http://10.20.30.40:8080, ,https://agent.example '
)
for invalid_base in \
  'http://databench.internal/api/' \
  'http://:80/api' \
  'http://host:bad/api' \
  'http://good.example\evil/api' \
  'http://Databench.internal/api' \
  'http://databench.internal:80/api' \
  'https://databench.internal:443/api' \
  'http://databench.internal:00081/api' \
  'http://10.20.30.999/api' \
  'http://0x7f000001/api' \
  'http://databench.internal:65536/api'; do
  if (
    source "${SCRIPT_DIR}/lib/common.sh"
    source "${SCRIPT_DIR}/lib/config.sh"
    validate_mcp_public_base_url "$invalid_base"
  ) >/dev/null 2>&1; then
    fail "offline MCP public base validator accepted: $invalid_base"
  fi
done
for invalid_origins in \
  'https://agent.example/path' \
  'https://agent.example/' \
  'https://agent.example?query=1' \
  'https://agent.example#fragment' \
  'https://user@agent.example' \
  'HTTPS://agent.example' \
  'https://Agent.example' \
  'http://agent.example:80' \
  'https://agent.example:443' \
  'http://agent.example:0080' \
  'http://10.20.30.999' \
  'http://0x7f000001'; do
  if (
    source "${SCRIPT_DIR}/lib/common.sh"
    source "${SCRIPT_DIR}/lib/config.sh"
    validate_mcp_origins "$invalid_origins"
  ) >/dev/null 2>&1; then
    fail "offline MCP origins validator accepted: $invalid_origins"
  fi
done

mkdir -p "${TEMP_DIR}/release-with-mcp" "${TEMP_DIR}/release-without-mcp"
printf 'services:\n  api:\n    env_file:\n      - /etc/databench/mcp.env\n' > \
  "${TEMP_DIR}/release-with-mcp/compose.yml"
printf 'services:\n  api:\n    image: example\n' > "${TEMP_DIR}/release-without-mcp/compose.yml"
(
  source "${SCRIPT_DIR}/lib/common.sh"
  source "${SCRIPT_DIR}/lib/config.sh"
  release_requires_mcp_config "${TEMP_DIR}/release-with-mcp"
  ! release_requires_mcp_config "${TEMP_DIR}/release-without-mcp"
)

rollback_current_mcp_line="$(grep -nF 'validate_release_mcp_config_if_required "$CURRENT_RELEASE"' "${SCRIPT_DIR}/rollback.sh" | cut -d: -f1)"
rollback_target_mcp_line="$(grep -nF 'validate_release_mcp_config_if_required "$TARGET_RELEASE"' "${SCRIPT_DIR}/rollback.sh" | cut -d: -f1)"
rollback_stop_line="$(grep -nF 'stop_application_services "$CURRENT_RELEASE"' "${SCRIPT_DIR}/rollback.sh" | cut -d: -f1)"
[ "$rollback_current_mcp_line" -lt "$rollback_stop_line" ] &&
  [ "$rollback_target_mcp_line" -lt "$rollback_stop_line" ] ||
  fail 'rollback must validate current and target MCP configuration before stopping services'
grep -Fq 'MCP_PUBLIC_BASE_URL%/api' "${SCRIPT_DIR}/install.sh" ||
  fail 'install success output does not derive the Web URL from the configured public base'
if grep -Fq 'hostname -I' "${SCRIPT_DIR}/install.sh"; then
  fail 'install success output still guesses a server address'
fi
printf '%s\n' \
  "{\"schema_version\":1,\"app_version\":\"1.2.3\",\"git_sha\":\"1111111111111111111111111111111111111111\",\"platform\":\"linux/amd64\",\"min_upgrade_from\":\"1.0.0\",\"postgres_major\":17,\"database_migration\":\"expand-only\",\"rollback_mode\":\"image-only\",\"object_migration\":\"none\",\"images_lock_sha256\":\"${LOCK_SHA}\"}" \
  > "${TEMP_DIR}/release/release-manifest.json"

(
  # shellcheck source=../lib/common.sh
  source "${SCRIPT_DIR}/lib/common.sh"
  # shellcheck source=../lib/manifest.sh
  source "${SCRIPT_DIR}/lib/manifest.sh"
  validate_release_contract "${TEMP_DIR}/release"
  [ "$MANIFEST_APP_VERSION" = '1.2.3' ]
  [ "$MANIFEST_ROLLBACK_MODE" = 'image-only' ]
)

cp -a "${TEMP_DIR}/release" "${TEMP_DIR}/bad-swift-digest-release"
sed -i.bak \
  's/DATABENCH_SWIFT_IMAGE_DIGEST=8888888888888888888888888888888888888888888888888888888888888888/DATABENCH_SWIFT_IMAGE_DIGEST=9999999999999999999999999999999999999999999999999999999999999999/' \
  "${TEMP_DIR}/bad-swift-digest-release/release.env"
if (
  source "${SCRIPT_DIR}/lib/common.sh"
  source "${SCRIPT_DIR}/lib/manifest.sh"
  validate_release_contract "${TEMP_DIR}/bad-swift-digest-release"
) >/dev/null 2>&1; then
  fail 'release validator accepted a Swift digest that differs from images.lock'
fi

mkdir -p "${TEMP_DIR}/legacy-release"
cat > "${TEMP_DIR}/legacy-release/release.env" <<'EOF'
DATABENCH_VERSION=1.0.0
DATABENCH_API_IMAGE=databench-api:1.0.0
DATABENCH_WEB_IMAGE=databench-web:1.0.0
DATABENCH_POSTGRES_IMAGE=databench-offline/postgres:1111111111111111
DATABENCH_MINIO_IMAGE=databench-offline/minio:2222222222222222
DATABENCH_MINIO_MC_IMAGE=databench-offline/minio-mc:3333333333333333
EOF
cat > "${TEMP_DIR}/legacy-release/images.lock" <<'EOF'
# databench offline images lock v1
databench-api:1.0.0|sha256:1111111111111111111111111111111111111111111111111111111111111111|linux/amd64|git:1111111111111111111111111111111111111111
databench-web:1.0.0|sha256:2222222222222222222222222222222222222222222222222222222222222222|linux/amd64|git:1111111111111111111111111111111111111111
databench-offline/postgres:1111111111111111|sha256:3333333333333333333333333333333333333333333333333333333333333333|linux/amd64|postgres:17.6-alpine
databench-offline/minio:2222222222222222|sha256:4444444444444444444444444444444444444444444444444444444444444444|linux/amd64|minio/minio:RELEASE.2025-09-07T16-13-09Z
databench-offline/minio-mc:3333333333333333|sha256:5555555555555555555555555555555555555555555555555555555555555555|linux/amd64|minio/mc:RELEASE.2025-08-13T08-35-41Z
EOF
if command -v sha256sum >/dev/null 2>&1; then
  LEGACY_LOCK_SHA="$(sha256sum "${TEMP_DIR}/legacy-release/images.lock" | awk '{print $1}')"
else
  LEGACY_LOCK_SHA="$(shasum -a 256 "${TEMP_DIR}/legacy-release/images.lock" | awk '{print $1}')"
fi
printf '%s\n' \
  "{\"schema_version\":1,\"app_version\":\"1.0.0\",\"git_sha\":\"1111111111111111111111111111111111111111\",\"platform\":\"linux/amd64\",\"min_upgrade_from\":\"0.1.0\",\"postgres_major\":17,\"database_migration\":\"expand-only\",\"rollback_mode\":\"image-only\",\"object_migration\":\"none\",\"images_lock_sha256\":\"${LEGACY_LOCK_SHA}\"}" \
  > "${TEMP_DIR}/legacy-release/release-manifest.json"
(
  source "${SCRIPT_DIR}/lib/common.sh"
  source "${SCRIPT_DIR}/lib/manifest.sh"
  validate_release_contract "${TEMP_DIR}/legacy-release"
  [ -z "${DATABENCH_WORKER_IMAGE:-}" ]
  [ -z "${DATABENCH_EVALSCOPE_IMAGE:-}" ]
  [ -z "${DATABENCH_SWIFT_IMAGE:-}" ]
  ! release_has_worker "${TEMP_DIR}/legacy-release"
  ! release_has_evalscope "${TEMP_DIR}/legacy-release"
  ! release_has_swift "${TEMP_DIR}/legacy-release"
)

mkdir -p "${TEMP_DIR}/seven-image-release"
grep -v '^DATABENCH_SWIFT_' "${TEMP_DIR}/release/release.env" \
  > "${TEMP_DIR}/seven-image-release/release.env"
grep -v '^databench-swift-studio:' "${TEMP_DIR}/release/images.lock" \
  > "${TEMP_DIR}/seven-image-release/images.lock"
if command -v sha256sum >/dev/null 2>&1; then
  SEVEN_LOCK_SHA="$(
    sha256sum "${TEMP_DIR}/seven-image-release/images.lock" | awk '{print $1}'
  )"
else
  SEVEN_LOCK_SHA="$(
    shasum -a 256 "${TEMP_DIR}/seven-image-release/images.lock" | awk '{print $1}'
  )"
fi
printf '%s\n' \
  "{\"schema_version\":1,\"app_version\":\"1.2.3\",\"git_sha\":\"1111111111111111111111111111111111111111\",\"platform\":\"linux/amd64\",\"min_upgrade_from\":\"1.0.0\",\"postgres_major\":17,\"database_migration\":\"expand-only\",\"rollback_mode\":\"image-only\",\"object_migration\":\"none\",\"images_lock_sha256\":\"${SEVEN_LOCK_SHA}\"}" \
  > "${TEMP_DIR}/seven-image-release/release-manifest.json"
(
  source "${SCRIPT_DIR}/lib/common.sh"
  source "${SCRIPT_DIR}/lib/manifest.sh"
  validate_release_contract "${TEMP_DIR}/seven-image-release"
  release_has_worker "${TEMP_DIR}/seven-image-release"
  release_has_evalscope "${TEMP_DIR}/seven-image-release"
  ! release_has_swift "${TEMP_DIR}/seven-image-release"
  [ "$(release_image_count "${TEMP_DIR}/seven-image-release")" -eq 7 ]
)

mkdir -p "${TEMP_DIR}/different-swift-release"
sed \
  's/DATABENCH_SWIFT_IMAGE_DIGEST=8888888888888888888888888888888888888888888888888888888888888888/DATABENCH_SWIFT_IMAGE_DIGEST=9999999999999999999999999999999999999999999999999999999999999999/' \
  "${TEMP_DIR}/release/release.env" > "${TEMP_DIR}/different-swift-release/release.env"
(
  source "${SCRIPT_DIR}/lib/common.sh"
  active_swift_session_binding() {
    printf '%s\n' \
      '11111111-1111-1111-1111-111111111111|8888888888888888888888888888888888888888888888888888888888888888'
  }
  assert_swift_session_transition_compatible \
    "${TEMP_DIR}/release" "${TEMP_DIR}/release" true
)
if (
  source "${SCRIPT_DIR}/lib/common.sh"
  active_swift_session_binding() {
    printf '%s\n' \
      '11111111-1111-1111-1111-111111111111|8888888888888888888888888888888888888888888888888888888888888888'
  }
  assert_swift_session_transition_compatible \
    "${TEMP_DIR}/release" "${TEMP_DIR}/release" false
) >/dev/null 2>&1; then
  fail 'active Swift Session was allowed while disabling the runtime'
fi
if (
  source "${SCRIPT_DIR}/lib/common.sh"
  active_swift_session_binding() {
    printf '%s\n' \
      '11111111-1111-1111-1111-111111111111|8888888888888888888888888888888888888888888888888888888888888888'
  }
  assert_swift_session_transition_compatible \
    "${TEMP_DIR}/release" "${TEMP_DIR}/different-swift-release" true
) >/dev/null 2>&1; then
  fail 'active Swift Session was allowed across an image digest change'
fi

DIRECTORY_CALLS="${TEMP_DIR}/directory-calls"
(
  source "${SCRIPT_DIR}/lib/common.sh"
  DATABENCH_DATA_ROOT="${TEMP_DIR}/data"
  install() {
    printf '%s\n' "$*" >> "$DIRECTORY_CALLS"
  }
  ensure_evalscope_data_directories
)
grep -Fq -- \
  "-d -o 10001 -g 10001 -m 0750 ${TEMP_DIR}/data/evalscope ${TEMP_DIR}/data/evalscope/outputs ${TEMP_DIR}/data/evalscope/inputs" \
  "$DIRECTORY_CALLS" ||
  fail 'EvalScope directory initializer does not enforce the runtime uid/gid and mode'

mkdir -p "${TEMP_DIR}/model-data/swift-models/Qwen-test"
cat > "${TEMP_DIR}/model-swift.env" <<'EOF'
DATABENCH_SWIFT_ENABLED=true
DATABENCH_SWIFT_RUNTIME_MODE=gpu
EOF
(
  source "${SCRIPT_DIR}/lib/common.sh"
  source "${SCRIPT_DIR}/lib/health.sh"
  DATABENCH_DATA_ROOT="${TEMP_DIR}/model-data"
  DATABENCH_SWIFT_CONFIG_FILE="${TEMP_DIR}/model-swift.env"
  verify_swift_model_preload "${TEMP_DIR}/release"
)
mkdir -p "${TEMP_DIR}/empty-model-data/swift-models"
if (
  source "${SCRIPT_DIR}/lib/common.sh"
  source "${SCRIPT_DIR}/lib/health.sh"
  DATABENCH_DATA_ROOT="${TEMP_DIR}/empty-model-data"
  DATABENCH_SWIFT_CONFIG_FILE="${TEMP_DIR}/model-swift.env"
  verify_swift_model_preload "${TEMP_DIR}/release"
) >/dev/null 2>&1; then
  fail 'Swift model preflight accepted an empty offline model directory'
fi

mkdir -p "${TEMP_DIR}/safe-swift-archive/sessions"
tar -cf "${TEMP_DIR}/safe-swift-workspace.tar" \
  -C "${TEMP_DIR}/safe-swift-archive" sessions
(
  source "${SCRIPT_DIR}/lib/common.sh"
  source "${SCRIPT_DIR}/lib/health.sh"
  validate_swift_volume_archive "${TEMP_DIR}/safe-swift-workspace.tar"
)
mkdir -p "${TEMP_DIR}/unsafe-swift-archive/cache"
printf 'must-not-restore\n' > "${TEMP_DIR}/unsafe-swift-archive/cache/model"
tar -cf "${TEMP_DIR}/unsafe-swift-workspace.tar" \
  -C "${TEMP_DIR}/unsafe-swift-archive" cache
if (
  source "${SCRIPT_DIR}/lib/common.sh"
  source "${SCRIPT_DIR}/lib/health.sh"
  validate_swift_volume_archive "${TEMP_DIR}/unsafe-swift-workspace.tar"
) >/dev/null 2>&1; then
  fail 'Swift archive validator accepted a cache member that would overwrite preserved data'
fi

RECOVERY_CALLS="${TEMP_DIR}/recovery-calls"
cat > "${TEMP_DIR}/swift.env" <<'EOF'
DATABENCH_SWIFT_ENABLED=true
DATABENCH_SWIFT_RUNTIME_MODE=ui-only
DATABENCH_SWIFT_GPU_DEVICE_ID=0
DATABENCH_SWIFT_STUDIO_PROVIDER_CREDENTIAL=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
DATABENCH_SWIFT_PROVIDER_CREDENTIAL=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EOF
(
  source "${SCRIPT_DIR}/lib/common.sh"
  DATABENCH_SWIFT_CONFIG_FILE="${TEMP_DIR}/swift.env"
  compose_for_release() {
    printf '%s\n' "$*" >> "$RECOVERY_CALLS"
  }
  swift_container_exists() {
    return 0
  }
  force_stop_application_services "${TEMP_DIR}/release"
  remove_application_services_absent_from_release \
    "${TEMP_DIR}/release" "${TEMP_DIR}/legacy-release"
  remove_application_services_absent_from_release \
    "${TEMP_DIR}/legacy-release" "${TEMP_DIR}/release"
)
grep -Fxq \
  "${TEMP_DIR}/release stop web api evalscope worker swift-studio" "$RECOVERY_CALLS" ||
  fail 'forced target recovery does not stop every declared application service'
grep -Fxq \
  "${TEMP_DIR}/release rm --stop --force evalscope worker swift-studio" "$RECOVERY_CALLS" ||
  fail 'legacy recovery does not remove target-only EvalScope, Worker, and Swift containers'
[ "$(wc -l < "$RECOVERY_CALLS" | tr -d ' ')" -eq 2 ] ||
  fail 'service cleanup attempted to remove services that exist in the target release'

(
  source "${SCRIPT_DIR}/lib/common.sh"
  source "${SCRIPT_DIR}/lib/manifest.sh"
  validate_release_contract "${TEMP_DIR}/release"
  load_release_env "${TEMP_DIR}/legacy-release/release.env"
  [ -z "${DATABENCH_WORKER_IMAGE:-}" ]
  [ -z "${DATABENCH_EVALSCOPE_IMAGE:-}" ]
  [ -z "${DATABENCH_SWIFT_IMAGE:-}" ]
  [ "$(release_image_count "${TEMP_DIR}/release")" -eq 8 ]
  validate_images_lock "${TEMP_DIR}/release/images.lock" false \
    "$(release_image_count "${TEMP_DIR}/release")"
)

cp "${TEMP_DIR}/release/release-manifest.json" "${TEMP_DIR}/bad-manifest.json"
sed -i.bak 's/"object_migration":"none"/"unknown":true,"object_migration":"none"/' \
  "${TEMP_DIR}/bad-manifest.json"
if (
  source "${SCRIPT_DIR}/lib/common.sh"
  source "${SCRIPT_DIR}/lib/manifest.sh"
  load_release_manifest "${TEMP_DIR}/bad-manifest.json"
) >/dev/null 2>&1; then
  fail 'manifest parser accepted an unknown field'
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  cp "${SCRIPT_DIR}/compose.yml" "${TEMP_DIR}/release/compose.yml"
  cp "${SCRIPT_DIR}/compose.swift-gpu.yml" "${TEMP_DIR}/release/compose.swift-gpu.yml"
  sed -i.bak "s#/etc/databench/databench.env#${TEMP_DIR}/databench.env#g" \
    "${TEMP_DIR}/release/compose.yml"
  sed -i.bak "s#/etc/databench/mcp.env#${TEMP_DIR}/mcp.env#g" \
    "${TEMP_DIR}/release/compose.yml"
  sed -i.bak "s#/etc/databench/evalscope.env#${TEMP_DIR}/evalscope.env#g" \
    "${TEMP_DIR}/release/compose.yml"
  sed -i.bak "s#/etc/databench/swift.env#${TEMP_DIR}/swift.env#g" \
    "${TEMP_DIR}/release/compose.yml"
  cat > "${TEMP_DIR}/databench.env" <<'EOF'
POSTGRES_USER=databench
POSTGRES_PASSWORD=test
POSTGRES_DB=databench
DATABASE_URL=postgresql://databench:test@postgres:5432/databench?schema=public
MINIO_ROOT_USER=databench_root
MINIO_ROOT_PASSWORD=test-root
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=databench
S3_ACCESS_KEY_ID=databench_app
S3_SECRET_ACCESS_KEY=test-app
S3_FORCE_PATH_STYLE=true
DATABENCH_OBJECT_STORE=s3
DATABENCH_CORS_ORIGINS=
DATABENCH_ROOT=/var/lib/databench
DATABENCH_V2_CURSOR_SECRET=test-cursor-secret-long-enough
DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
DATABENCH_SERVICE_CREDENTIAL=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
PORT=8000
EOF
  cat > "${TEMP_DIR}/evalscope.env" <<'EOF'
EVALSCOPE_TASK_CONFIG_HMAC_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EVALSCOPE_OPERATOR_TOKEN=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
DATABENCH_ORIGIN=http://databench.internal
DATABENCH_SERVICE_CREDENTIAL=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST=
EVALSCOPE_DATASET_ENDPOINT_ALLOWLIST=
EVALSCOPE_INPUT_MAX_BYTES=1073741824
EVALSCOPE_OUTPUT_MAX_BYTES=4294967296
EVALSCOPE_ARCHIVE_MAX_BYTES=1073741824
EVALSCOPE_REQUEST_MAX_BYTES=1048576
EVALSCOPE_RESPONSE_MAX_BYTES=16777216
EVALSCOPE_DOCUMENT_MAX_BYTES=16777216
EVALSCOPE_DOCUMENT_TTL_SECONDS=900
EVALSCOPE_MAX_CONCURRENT_EVALS=2
EVALSCOPE_MAX_CONCURRENT_PERF=2
EVALSCOPE_MAX_TASKS=10000
EVALSCOPE_TASK_RUNTIME_SECONDS=86400
EVALSCOPE_EVALUATION_SAMPLE_LIMIT_MAX=100000
EVALSCOPE_EVALUATION_BATCH_SIZE_MAX=256
EVALSCOPE_EVALUATION_REPEATS_MAX=10
EVALSCOPE_PERFORMANCE_PARALLEL_MAX=256
EVALSCOPE_PERFORMANCE_REQUESTS_MAX=1000000
EVALSCOPE_PERFORMANCE_RATE_MAX=10000
EVALSCOPE_MODEL_TOKENS_MAX=32768
EVALSCOPE_REQUEST_TIMEOUT_SECONDS_MAX=3600
EOF
  cat > "${TEMP_DIR}/mcp.env" <<'EOF'
DATABENCH_MCP_ENABLED=true
DATABENCH_MCP_AUTH_MODE=none
DATABENCH_MCP_PUBLIC_BASE_URL=http://databench.internal/api
DATABENCH_MCP_ORIGINS=
EOF
  (
    source "${SCRIPT_DIR}/lib/common.sh"
    source "${SCRIPT_DIR}/lib/config.sh"
    DATABENCH_EVALSCOPE_CONFIG_FILE="${TEMP_DIR}/evalscope.env"
    validate_evalscope_positive_bound EVALSCOPE_MAX_CONCURRENT_EVALS 16
    validate_evalscope_positive_bound EVALSCOPE_OUTPUT_MAX_BYTES 17179869184
  )
  cp "${TEMP_DIR}/evalscope.env" "${TEMP_DIR}/evalscope-invalid.env"
  sed -i.bak 's/EVALSCOPE_MAX_CONCURRENT_EVALS=2/EVALSCOPE_MAX_CONCURRENT_EVALS=17/' \
    "${TEMP_DIR}/evalscope-invalid.env"
  if (
    source "${SCRIPT_DIR}/lib/common.sh"
    source "${SCRIPT_DIR}/lib/config.sh"
    DATABENCH_EVALSCOPE_CONFIG_FILE="${TEMP_DIR}/evalscope-invalid.env"
    validate_evalscope_positive_bound EVALSCOPE_MAX_CONCURRENT_EVALS 16
  ) >/dev/null 2>&1; then
    fail 'offline EvalScope capacity validator accepted a value above the compiled ceiling'
  fi
  docker compose --env-file "${TEMP_DIR}/release/release.env" \
    --env-file "${TEMP_DIR}/databench.env" --file "${TEMP_DIR}/release/compose.yml" config --quiet

  (
    # shellcheck source=../lib/common.sh
    source "${SCRIPT_DIR}/lib/common.sh"
    export DATABENCH_CONFIG_FILE="${TEMP_DIR}/databench.env"
    export DATABENCH_SWIFT_CONFIG_FILE="${TEMP_DIR}/swift.env"
    export DATABENCH_API_IMAGE='wrong-api:ambient-variable-must-not-win'
    export DATABENCH_WEB_IMAGE='wrong-web:ambient-variable-must-not-win'
    export DATABENCH_WORKER_IMAGE='wrong-worker:ambient-variable-must-not-win'
    export DATABENCH_EVALSCOPE_IMAGE='wrong-evalscope:ambient-variable-must-not-win'
    export DATABENCH_SWIFT_IMAGE='wrong-swift:ambient-variable-must-not-win'
    export DATABENCH_SWIFT_IMAGE_DIGEST='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    rendered="$(compose_for_release "${TEMP_DIR}/release" config)"
    grep -q 'image: databench-api:1.2.3' <<< "$rendered" ||
      fail 'ambient variables overrode the selected API release'
    grep -q 'image: databench-web:1.2.3' <<< "$rendered" ||
      fail 'ambient variables overrode the selected Web release'
    grep -q 'image: databench-worker:1.2.3' <<< "$rendered" ||
      fail 'ambient variables overrode the selected Worker release'
    grep -q 'image: databench-evalscope:1.2.3' <<< "$rendered" ||
      fail 'ambient variables overrode the selected EvalScope release'
    grep -q 'image: databench-swift-studio:1.2.3' <<< "$rendered" ||
      fail 'ambient variables overrode the selected Swift release'
    ! grep -q 'driver: nvidia' <<< "$rendered" ||
      fail 'UI-only Swift mode unexpectedly requested an NVIDIA device'
    ! grep -q 'ambient-variable-must-not-win' <<< "$rendered" ||
      fail 'ambient release variables leaked into Compose interpolation'
  )
  sed -i.bak 's/DATABENCH_SWIFT_RUNTIME_MODE=ui-only/DATABENCH_SWIFT_RUNTIME_MODE=gpu/' \
    "${TEMP_DIR}/swift.env"
  (
    source "${SCRIPT_DIR}/lib/common.sh"
    export DATABENCH_CONFIG_FILE="${TEMP_DIR}/databench.env"
    export DATABENCH_SWIFT_CONFIG_FILE="${TEMP_DIR}/swift.env"
    rendered="$(compose_for_release "${TEMP_DIR}/release" config)"
    grep -q 'driver: nvidia' <<< "$rendered" ||
      fail 'GPU Swift mode did not apply the NVIDIA Compose overlay'
    grep -q 'gpu_available' <<< "$rendered" ||
      fail 'GPU Swift mode did not apply the strict GPU healthcheck'
  )
  sed -i.bak 's/DATABENCH_SWIFT_RUNTIME_MODE=gpu/DATABENCH_SWIFT_RUNTIME_MODE=ui-only/' \
    "${TEMP_DIR}/swift.env"
  sed -i.bak 's/DATABENCH_SWIFT_ENABLED=true/DATABENCH_SWIFT_ENABLED=false/' \
    "${TEMP_DIR}/swift.env"
  (
    source "${SCRIPT_DIR}/lib/common.sh"
    export DATABENCH_CONFIG_FILE="${TEMP_DIR}/databench.env"
    export DATABENCH_SWIFT_CONFIG_FILE="${TEMP_DIR}/swift.env"
    rendered="$(compose_for_release "${TEMP_DIR}/release" config)"
    ! grep -q 'image: databench-swift-studio:1.2.3' <<< "$rendered" ||
      fail 'disabled Swift profile still renders the GPU service'
    grep -q 'DATABENCH_SWIFT_STUDIO_ENABLED: "false"' <<< "$rendered" ||
      fail 'disabled Swift profile does not disable the API gateway'
  )
fi

printf 'offline deployment static tests passed\n'
