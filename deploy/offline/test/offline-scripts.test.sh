#!/usr/bin/env bash

set -Eeuo pipefail

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
  "${SCRIPT_DIR}/compose.yml" "${SCRIPT_DIR}"/*.sh "${SCRIPT_DIR}/databenchctl"; then
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
grep -Fq 'torch.version.cuda is None' "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not reject a CUDA-enabled Worker image'
grep -Fq 'name.startswith("nvidia-")' "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not reject NVIDIA Worker packages'
grep -Fq 'saving six images' "${SCRIPT_DIR}/build-bundle.sh" ||
  fail 'offline bundle builder does not save the six-image release set'
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
grep -Fq 'logs web api worker' "${SCRIPT_DIR}/smoke.sh" ||
  fail 'offline smoke does not check API/Caddy/Worker logs for bearer token leakage'
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
  'databench v2|databench dataset add|/api/v1/|system-offline-smoke-v1|smoke/v1\.jsonl|v1/v2' \
  "${SCRIPT_DIR}/smoke.sh" \
  "${SCRIPT_DIR}/smoke/gateway.mjs" \
  "${SCRIPT_DIR}/README.zh-CN.md" \
  "${SCRIPT_DIR}/DEPLOYMENT-GUIDE.zh-CN.md" \
  "${SCRIPT_DIR}/TROUBLESHOOTING.zh-CN.md"; then
  fail 'offline release still references a retired v1 product surface'
fi

for document in README.zh-CN.md DEPLOYMENT-GUIDE.zh-CN.md TROUBLESHOOTING.zh-CN.md \
  MCP-AGENT-GUIDE.zh-CN.md; do
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
  deploy/offline/mcp.env.example \
  docs/deployment/offline-single-host-plan.zh-CN.md \
  docs/decisions/0012-offline-single-host-deployment.md \
  'docs/ADR-0012.md'; do
  grep -Fq "$bundle_asset" "${SCRIPT_DIR}/build-bundle.sh" ||
    fail "bundle builder does not include: $bundle_asset"
done
for release_asset in DEPLOYMENT-GUIDE.zh-CN.md TROUBLESHOOTING.zh-CN.md \
  MCP-AGENT-GUIDE.zh-CN.md mcp.env.example docs; do
  grep -Fq "$release_asset" "${SCRIPT_DIR}/lib/common.sh" ||
    fail "installed release does not preserve: $release_asset"
done

mkdir -p "${TEMP_DIR}/release"
cat > "${TEMP_DIR}/release/release.env" <<'EOF'
DATABENCH_VERSION=1.2.3
DATABENCH_API_IMAGE=databench-api:1.2.3
DATABENCH_WEB_IMAGE=databench-web:1.2.3
DATABENCH_WORKER_IMAGE=databench-worker:1.2.3
DATABENCH_POSTGRES_IMAGE=databench-offline/postgres:1111111111111111
DATABENCH_MINIO_IMAGE=databench-offline/minio:2222222222222222
DATABENCH_MINIO_MC_IMAGE=databench-offline/minio-mc:3333333333333333
EOF

cat > "${TEMP_DIR}/release/images.lock" <<'EOF'
# databench offline images lock v1
databench-api:1.2.3|sha256:1111111111111111111111111111111111111111111111111111111111111111|linux/amd64|git:1111111111111111111111111111111111111111
databench-web:1.2.3|sha256:2222222222222222222222222222222222222222222222222222222222222222|linux/amd64|git:1111111111111111111111111111111111111111
databench-worker:1.2.3|sha256:3333333333333333333333333333333333333333333333333333333333333333|linux/amd64|git:1111111111111111111111111111111111111111
databench-offline/postgres:1111111111111111|sha256:4444444444444444444444444444444444444444444444444444444444444444|linux/amd64|postgres:17.6-alpine
databench-offline/minio:2222222222222222|sha256:5555555555555555555555555555555555555555555555555555555555555555|linux/amd64|minio/minio:RELEASE.2025-09-07T16-13-09Z
databench-offline/minio-mc:3333333333333333|sha256:6666666666666666666666666666666666666666666666666666666666666666|linux/amd64|minio/mc:RELEASE.2025-08-13T08-35-41Z
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
grep -Fq "stat -c '%U:%G'" "${SCRIPT_DIR}/lib/config.sh" ||
  fail 'offline MCP configuration does not enforce root ownership'
grep -Fq 'DATABENCH_MCP_ENABLED=true' "${SCRIPT_DIR}/mcp.env.example" ||
  fail 'offline MCP example is not explicitly enabled'
grep -Fq 'DATABENCH_MCP_AUTH_MODE=none' "${SCRIPT_DIR}/mcp.env.example" ||
  fail 'offline MCP example does not declare anonymous mode'
grep -Fq 'DATABENCH_MIN_WORKSPACE_FREE_GB' "${SCRIPT_DIR}/lib/preflight.sh" ||
  fail 'offline preflight does not check the Databench data filesystem'
grep -Fq 'DATABENCH_MIN_CPUS:-8' "${SCRIPT_DIR}/lib/preflight.sh" ||
  fail 'offline preflight does not enforce the Worker CPU floor'
grep -Fq 'DATABENCH_MIN_MEMORY_GB:-30' "${SCRIPT_DIR}/lib/preflight.sh" ||
  fail 'offline preflight does not enforce the Worker memory floor'
grep -Fq 'DATABENCH_MIN_FREE_GB:-40' "${SCRIPT_DIR}/lib/preflight.sh" ||
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
  ! release_has_worker "${TEMP_DIR}/legacy-release"
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
  sed -i.bak "s#/etc/databench/databench.env#${TEMP_DIR}/databench.env#g" \
    "${TEMP_DIR}/release/compose.yml"
  sed -i.bak "s#/etc/databench/mcp.env#${TEMP_DIR}/mcp.env#g" \
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
PORT=8000
EOF
  cat > "${TEMP_DIR}/mcp.env" <<'EOF'
DATABENCH_MCP_ENABLED=true
DATABENCH_MCP_AUTH_MODE=none
DATABENCH_MCP_PUBLIC_BASE_URL=http://databench.internal/api
DATABENCH_MCP_ORIGINS=
EOF
  docker compose --env-file "${TEMP_DIR}/release/release.env" \
    --env-file "${TEMP_DIR}/databench.env" --file "${TEMP_DIR}/release/compose.yml" config --quiet

  (
    # shellcheck source=../lib/common.sh
    source "${SCRIPT_DIR}/lib/common.sh"
    export DATABENCH_CONFIG_FILE="${TEMP_DIR}/databench.env"
    export DATABENCH_API_IMAGE='wrong-api:ambient-variable-must-not-win'
    export DATABENCH_WEB_IMAGE='wrong-web:ambient-variable-must-not-win'
    export DATABENCH_WORKER_IMAGE='wrong-worker:ambient-variable-must-not-win'
    rendered="$(compose_for_release "${TEMP_DIR}/release" config)"
    grep -q 'image: databench-api:1.2.3' <<< "$rendered" ||
      fail 'ambient variables overrode the selected API release'
    grep -q 'image: databench-web:1.2.3' <<< "$rendered" ||
      fail 'ambient variables overrode the selected Web release'
    grep -q 'image: databench-worker:1.2.3' <<< "$rendered" ||
      fail 'ambient variables overrode the selected Worker release'
    ! grep -q 'ambient-variable-must-not-win' <<< "$rendered" ||
      fail 'ambient release variables leaked into Compose interpolation'
  )
fi

printf 'offline deployment static tests passed\n'
