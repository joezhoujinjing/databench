#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ECS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

bash -n "${ECS_DIR}/cleanup.sh"
bash -n "${ECS_DIR}/deploy.sh"

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
    printf '%s\n' \
      databench-api:aaaaaaa \
      databench-api:bbbbbbb \
      databench-api:ccccccc \
      databench-api:ddddddd
    ;;
  'image inspect')
    if [[ "$3" == '--format' ]]; then
      case "$5" in
        databench-api:aaaaaaa) echo '2026-07-01T00:00:00Z|sha256:oldest' ;;
        databench-api:bbbbbbb) echo '2026-07-02T00:00:00Z|sha256:previous' ;;
        databench-api:ccccccc) echo '2026-07-03T00:00:00Z|sha256:current' ;;
        databench-api:ddddddd) echo '2026-07-04T00:00:00Z|sha256:incoming' ;;
        *) exit 1 ;;
      esac
    elif [[ "$3" == 'databench-api:ddddddd' ]]; then
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

touch -t 202607010000 "${TEST_ROOT}/app/releases/databench-api-aaaaaaa.tar.gz"
touch -t 202607020000 "${TEST_ROOT}/app/releases/databench-api-bbbbbbb.tar.gz"
touch -t 202607030000 "${TEST_ROOT}/app/releases/databench-api-ccccccc.tar.gz"
touch -t 202607040000 "${TEST_ROOT}/app/releases/databench-api-ddddddd.tar.gz"
touch "${TEST_ROOT}/app/releases/databench-api-abandoned.tar.gz.part"
touch "${TEST_ROOT}/app/releases/janus-api-unrelated.tar.gz"

export APP_DIR="${TEST_ROOT}/app"
export DATABENCH_DOCKER_BIN="${TEST_ROOT}/bin/docker"
export DATABENCH_DEPLOY_CLEANUP_MODE=auto
export DATABENCH_DEPLOY_KEEP_RELEASES=2
export DATABENCH_DEPLOY_MIN_FREE_MIB=512
export FAKE_DOCKER_REMOVED="${TEST_ROOT}/removed-images"

"${ECS_DIR}/cleanup.sh" ddddddd \
  "${TEST_ROOT}/app/releases/databench-api-ddddddd.tar.gz" test

test -f "${TEST_ROOT}/app/releases/databench-api-ddddddd.tar.gz"
test -f "${TEST_ROOT}/app/releases/databench-api-ccccccc.tar.gz"
test ! -e "${TEST_ROOT}/app/releases/databench-api-bbbbbbb.tar.gz"
test ! -e "${TEST_ROOT}/app/releases/databench-api-aaaaaaa.tar.gz"
test ! -e "${TEST_ROOT}/app/releases/databench-api-abandoned.tar.gz.part"
test -f "${TEST_ROOT}/app/releases/janus-api-unrelated.tar.gz"
sort "${FAKE_DOCKER_REMOVED}" > "${TEST_ROOT}/removed-images.sorted"
printf '%s\n' databench-api:aaaaaaa databench-api:bbbbbbb > "${TEST_ROOT}/expected-images"
cmp "${TEST_ROOT}/expected-images" "${TEST_ROOT}/removed-images.sorted"

echo 'ecs cleanup tests passed'
