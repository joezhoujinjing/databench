from __future__ import annotations

import os

import grpc
from grpc_health.v1 import health_pb2, health_pb2_grpc


def main() -> None:
    target = os.environ.get("DATABENCH_WORKER_HEALTH_TARGET", "127.0.0.1:50051")
    try:
        with grpc.insecure_channel(target) as channel:
            response = health_pb2_grpc.HealthStub(channel).Check(
                health_pb2.HealthCheckRequest(service="databench.worker.v1.WorkerService"),
                timeout=3,
            )
    except grpc.RpcError as error:
        raise SystemExit(1) from error
    if response.status != health_pb2.HealthCheckResponse.SERVING:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
