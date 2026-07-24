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

if rg -n 'docker compose down -v|image:.*latest|build:' \
  "${SCRIPT_DIR}/compose.yml" "${SCRIPT_DIR}"/*.sh "${SCRIPT_DIR}/databenchctl"; then
  fail 'offline runtime contains a forbidden destructive, latest, or build directive'
fi

if rg -n 'docker image inspect --platform' "${SCRIPT_DIR}/lib" "${SCRIPT_DIR}"/{install,upgrade,rollback,backup,restore}.sh; then
  fail 'target runtime uses inspect --platform, which is newer than Docker Engine 24'
fi

grep -q 'pull_policy: never' "${SCRIPT_DIR}/compose.yml" || fail 'pull_policy is not disabled'
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
grep -Fq '/datasets/system-offline-smoke-v2' "${SCRIPT_DIR}/smoke/gateway.mjs" ||
  fail 'offline smoke does not cover the dataset SPA page path'
grep -Fq '/api/v2/datasets/system-offline-smoke-v2' "${SCRIPT_DIR}/smoke/gateway.mjs" ||
  fail 'offline smoke does not cover the distinct v2 API path'
grep -Fq "document.servers[0]?.url !== '/api'" "${SCRIPT_DIR}/smoke/gateway.mjs" ||
  fail 'offline smoke does not verify the external OpenAPI server URL'

for document in README.zh-CN.md DEPLOYMENT-GUIDE.zh-CN.md TROUBLESHOOTING.zh-CN.md; do
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
  docs/deployment/offline-single-host-plan.zh-CN.md \
  docs/decisions/0012-offline-single-host-deployment.md \
  'docs/ADR-0012.md'; do
  grep -Fq "$bundle_asset" "${SCRIPT_DIR}/build-bundle.sh" ||
    fail "bundle builder does not include: $bundle_asset"
done
for release_asset in DEPLOYMENT-GUIDE.zh-CN.md TROUBLESHOOTING.zh-CN.md docs; do
  grep -Fq "$release_asset" "${SCRIPT_DIR}/lib/common.sh" ||
    fail "installed release does not preserve: $release_asset"
done

mkdir -p "${TEMP_DIR}/release"
cat > "${TEMP_DIR}/release/release.env" <<'EOF'
DATABENCH_VERSION=1.2.3
DATABENCH_API_IMAGE=databench-api:1.2.3
DATABENCH_WEB_IMAGE=databench-web:1.2.3
DATABENCH_POSTGRES_IMAGE=databench-offline/postgres:1111111111111111
DATABENCH_MINIO_IMAGE=databench-offline/minio:2222222222222222
DATABENCH_MINIO_MC_IMAGE=databench-offline/minio-mc:3333333333333333
EOF

cat > "${TEMP_DIR}/release/images.lock" <<'EOF'
# databench offline images lock v1
databench-api:1.2.3|sha256:1111111111111111111111111111111111111111111111111111111111111111|linux/amd64|git:1111111111111111111111111111111111111111
databench-web:1.2.3|sha256:2222222222222222222222222222222222222222222222222222222222222222|linux/amd64|git:1111111111111111111111111111111111111111
databench-offline/postgres:1111111111111111|sha256:3333333333333333333333333333333333333333333333333333333333333333|linux/amd64|postgres:17.6-alpine
databench-offline/minio:2222222222222222|sha256:4444444444444444444444444444444444444444444444444444444444444444|linux/amd64|minio/minio:RELEASE.2025-09-07T16-13-09Z
databench-offline/minio-mc:3333333333333333|sha256:5555555555555555555555555555555555555555555555555555555555555555|linux/amd64|minio/mc:RELEASE.2025-08-13T08-35-41Z
EOF

if command -v sha256sum >/dev/null 2>&1; then
  LOCK_SHA="$(sha256sum "${TEMP_DIR}/release/images.lock" | awk '{print $1}')"
else
  LOCK_SHA="$(shasum -a 256 "${TEMP_DIR}/release/images.lock" | awk '{print $1}')"
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
  docker compose --env-file "${TEMP_DIR}/release/release.env" \
    --env-file "${TEMP_DIR}/databench.env" --file "${TEMP_DIR}/release/compose.yml" config --quiet

  (
    # shellcheck source=../lib/common.sh
    source "${SCRIPT_DIR}/lib/common.sh"
    export DATABENCH_CONFIG_FILE="${TEMP_DIR}/databench.env"
    export DATABENCH_API_IMAGE='wrong-api:ambient-variable-must-not-win'
    export DATABENCH_WEB_IMAGE='wrong-web:ambient-variable-must-not-win'
    rendered="$(compose_for_release "${TEMP_DIR}/release" config)"
    grep -q 'image: databench-api:1.2.3' <<< "$rendered" ||
      fail 'ambient variables overrode the selected API release'
    grep -q 'image: databench-web:1.2.3' <<< "$rendered" ||
      fail 'ambient variables overrode the selected Web release'
    ! grep -q 'ambient-variable-must-not-win' <<< "$rendered" ||
      fail 'ambient release variables leaked into Compose interpolation'
  )
fi

printf 'offline deployment static tests passed\n'
