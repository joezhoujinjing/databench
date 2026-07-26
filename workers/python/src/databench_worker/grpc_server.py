from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc

from databench.worker.v1 import worker_pb2_grpc

from . import __version__
from .adapters.data_juicer import DataJuicerBatchAdapter
from .fixture import FixtureCopyAdapter
from .registry import CapabilityRegistry
from .runner import WorkerService


async def serve(listen: str) -> None:
    registry = CapabilityRegistry()
    registry.register(DataJuicerBatchAdapter())
    if os.environ.get("DATABENCH_WORKER_ENABLE_TEST_CAPABILITIES") == "1":
        registry.register(FixtureCopyAdapter())

    server = grpc.aio.server(options=(("grpc.so_reuseport", 0),))
    service = WorkerService(registry, __version__)
    worker_pb2_grpc.add_WorkerServiceServicer_to_server(service, server)

    health_service = health.aio.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_service, server)
    await health_service.set("", health_pb2.HealthCheckResponse.SERVING)
    await health_service.set(
        "databench.worker.v1.WorkerService",
        health_pb2.HealthCheckResponse.SERVING,
    )

    port = server.add_insecure_port(listen)
    if port == 0:
        raise RuntimeError("failed to bind Worker gRPC server")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    await server.start()
    host = listen.rsplit(":", maxsplit=1)[0]
    print(json.dumps({"address": f"{host}:{port}"}), flush=True)
    await stop.wait()
    await health_service.enter_graceful_shutdown()
    await server.stop(grace=5)


def main() -> None:
    parser = argparse.ArgumentParser(description="Databench Python Worker")
    parser.add_argument(
        "--listen",
        default=os.environ.get("DATABENCH_WORKER_BIND", "127.0.0.1:50051"),
    )
    args = parser.parse_args()
    asyncio.run(serve(args.listen))


if __name__ == "__main__":
    main()
