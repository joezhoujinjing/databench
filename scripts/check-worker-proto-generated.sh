#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

TS_GENERATED="${REPO_ROOT}/packages/workspace/src/internal/worker/generated"
PY_GENERATED="${REPO_ROOT}/workers/python/src/databench/worker/v1"

test -d "${TS_GENERATED}"
test -f "${PY_GENERATED}/worker_pb2.py"
test -f "${PY_GENERATED}/worker_pb2_grpc.py"

cp -R "${TS_GENERATED}" "${TMP_DIR}/ts"
cp "${PY_GENERATED}/worker_pb2.py" "${TMP_DIR}/worker_pb2.py"
cp "${PY_GENERATED}/worker_pb2_grpc.py" "${TMP_DIR}/worker_pb2_grpc.py"

cd "${REPO_ROOT}"
pnpm codegen:worker

diff -ru "${TMP_DIR}/ts" "${TS_GENERATED}"
diff -u "${TMP_DIR}/worker_pb2.py" "${PY_GENERATED}/worker_pb2.py"
diff -u "${TMP_DIR}/worker_pb2_grpc.py" "${PY_GENERATED}/worker_pb2_grpc.py"
