#!/usr/bin/env bash
set -euo pipefail

WORKER_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UV_BIN=${DATABENCH_UV:-$(command -v uv)}
PYTHON_BIN=${DATABENCH_PYTHON:-$("${UV_BIN}" python find 3.11.15)}
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

"${WORKER_ROOT}/scripts/native-preflight.sh" "${UV_BIN}" "${PYTHON_BIN}"
if "${WORKER_ROOT}/scripts/native-preflight.sh" /usr/local/bin/uv /usr/local/bin/python3.11 \
  >"${TMP_DIR}/rosetta.stdout" 2>"${TMP_DIR}/rosetta.stderr"; then
  echo "native preflight accepted /usr/local Rosetta tools" >&2
  exit 1
fi

"${UV_BIN}" sync --directory "${WORKER_ROOT}" --frozen
"${UV_BIN}" run --directory "${WORKER_ROOT}" pytest
"${UV_BIN}" build --directory "${WORKER_ROOT}" --out-dir "${TMP_DIR}/dist"
"${UV_BIN}" venv "${TMP_DIR}/venv" --python "${PYTHON_BIN}"
WHEEL=$(find "${TMP_DIR}/dist" -maxdepth 1 -name '*.whl' -print -quit)
test -n "${WHEEL}"
"${UV_BIN}" pip install --python "${TMP_DIR}/venv/bin/python" "${WHEEL}"
"${TMP_DIR}/venv/bin/python" -c \
  'from databench.worker.v1 import worker_pb2, worker_pb2_grpc; import databench_worker; assert worker_pb2.DESCRIPTOR.package == "databench.worker.v1"; assert worker_pb2_grpc.WorkerServiceStub; assert databench_worker.__version__ == "0.1.0"'
