#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ECS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

bash -n "${ECS_DIR}/cleanup.sh"
bash -n "${ECS_DIR}/deploy.sh"
bash -n "${ECS_DIR}/configure-cdn-evalscope.sh"
grep -Fq 'DATABENCH_EVALSCOPE_IMAGE=' "${ECS_DIR}/deploy.sh"
grep -Fq 'DATABENCH_EVALSCOPE_ENABLED: "true"' "${ECS_DIR}/docker-compose.yml"
grep -Fq 'mem_limit: 1536m' "${ECS_DIR}/docker-compose.yml"
grep -Fq 'EVALSCOPE_MAX_CONCURRENT_EVALS=1' "${ECS_DIR}/evalscope.env.example"
if grep -Fq '"9000:9000"' "${ECS_DIR}/docker-compose.yml"; then
  echo 'EvalScope must not publish port 9000 on the ECS host' >&2
  exit 1
fi

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT
mkdir -p "${TEST_ROOT}/bin" "${TEST_ROOT}/app/releases"

cat > "${TEST_ROOT}/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$1 $2" in
  'ps -aq')
    echo running-container
    ;;
  'inspect --format')
    [[ "$3" == '{{.Image}}' && "$4" == 'running-container' ]]
    echo sha256:current
    ;;
  'image ls')
    case "$5" in
      databench-api)
        printf '%s\n' \
          databench-api:aaaaaaa \
          databench-api:bbbbbbb \
          databench-api:ccccccc \
          databench-api:ddddddd
        ;;
      databench-evalscope)
        printf '%s\n' \
          databench-evalscope:aaaaaaa \
          databench-evalscope:bbbbbbb \
          databench-evalscope:ccccccc \
          databench-evalscope:ddddddd
        ;;
      *) exit 1 ;;
    esac
    ;;
  'image inspect')
    if [[ "$3" == '--format' ]]; then
      case "$5" in
        *:aaaaaaa) echo '2026-07-01T00:00:00Z|sha256:oldest' ;;
        *:bbbbbbb) echo '2026-07-02T00:00:00Z|sha256:previous' ;;
        *:ccccccc) echo '2026-07-03T00:00:00Z|sha256:current' ;;
        *:ddddddd) echo '2026-07-04T00:00:00Z|sha256:incoming' ;;
        *) exit 1 ;;
      esac
    elif [[ "$3" == *':ddddddd' ]]; then
      exit 0
    else
      exit 1
    fi
    ;;
  'image rm')
    echo "$3" >> "${FAKE_DOCKER_REMOVED}"
    ;;
  *)
    echo "unexpected fake docker invocation: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${TEST_ROOT}/bin/docker"

touch -t 202607010000 "${TEST_ROOT}/app/releases/databench-release-aaaaaaa.tar.gz"
touch -t 202607020000 "${TEST_ROOT}/app/releases/databench-release-bbbbbbb.tar.gz"
touch -t 202607030000 "${TEST_ROOT}/app/releases/databench-release-ccccccc.tar.gz"
touch -t 202607040000 "${TEST_ROOT}/app/releases/databench-release-ddddddd.tar.gz"
touch "${TEST_ROOT}/app/releases/databench-release-abandoned.tar.gz.part"
touch "${TEST_ROOT}/app/releases/janus-api-unrelated.tar.gz"

export APP_DIR="${TEST_ROOT}/app"
export DATABENCH_DOCKER_BIN="${TEST_ROOT}/bin/docker"
export DATABENCH_DEPLOY_CLEANUP_MODE=auto
export DATABENCH_DEPLOY_KEEP_RELEASES=2
export DATABENCH_DEPLOY_MIN_FREE_MIB=512
export FAKE_DOCKER_REMOVED="${TEST_ROOT}/removed-images"

"${ECS_DIR}/cleanup.sh" ddddddd \
  "${TEST_ROOT}/app/releases/databench-release-ddddddd.tar.gz" test

test -f "${TEST_ROOT}/app/releases/databench-release-ddddddd.tar.gz"
test -f "${TEST_ROOT}/app/releases/databench-release-ccccccc.tar.gz"
test ! -e "${TEST_ROOT}/app/releases/databench-release-bbbbbbb.tar.gz"
test ! -e "${TEST_ROOT}/app/releases/databench-release-aaaaaaa.tar.gz"
test ! -e "${TEST_ROOT}/app/releases/databench-release-abandoned.tar.gz.part"
test -f "${TEST_ROOT}/app/releases/janus-api-unrelated.tar.gz"
sort "${FAKE_DOCKER_REMOVED}" > "${TEST_ROOT}/removed-images.sorted"
printf '%s\n' \
  databench-api:aaaaaaa \
  databench-api:bbbbbbb \
  databench-evalscope:aaaaaaa \
  databench-evalscope:bbbbbbb > "${TEST_ROOT}/expected-images"
cmp "${TEST_ROOT}/expected-images" "${TEST_ROOT}/removed-images.sorted"

echo 'ecs cleanup tests passed'
