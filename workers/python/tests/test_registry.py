from databench.worker.v1 import worker_pb2, worker_pb2_grpc
from databench_worker.adapters.data_juicer import DataJuicerBatchAdapter
from databench_worker.fixture import FixtureCopyAdapter
from databench_worker.registry import CapabilityRegistry


def test_generated_protocol_imports_from_installed_package() -> None:
    assert worker_pb2.DESCRIPTOR.package == "databench.worker.v1"
    assert hasattr(worker_pb2_grpc, "WorkerServiceStub")


def test_registry_is_sorted_and_rejects_duplicates() -> None:
    registry = CapabilityRegistry()
    adapter = FixtureCopyAdapter()
    registry.register(adapter)
    data_juicer = DataJuicerBatchAdapter()
    registry.register(data_juicer)
    assert registry.descriptors() == (data_juicer.descriptor, adapter.descriptor)

    try:
        registry.register(adapter)
    except ValueError as exc:
        assert "duplicate capability" in str(exc)
    else:
        raise AssertionError("duplicate capability was accepted")
