from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from databench.worker.v1 import worker_pb2

from ..registry import ArtifactContract, CapabilityDescriptor, RunContext
from ..runtime.artifacts import (
    MAX_ARTIFACT_BYTES,
    ArtifactTransferError,
    ArtifactTransferStopped,
    download_artifact,
    upload_artifact,
)
from ..runtime.subprocess import run_controlled_process


MEDIA_TYPE = "application/x-ndjson"
PARAMETER_SCHEMA = "databench.worker.data-juicer-batch-parameters"
PARAMETER_VERSION = "1"
RECORD_ID = re.compile(r"^rec_[0-9a-f]{64}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
FIXED_PROCESS = (
    {"whitespace_normalization_mapper": {}},
    {"text_length_filter": {"min_len": 40}},
    {"document_deduplicator": {"lowercase": False}},
)


@dataclass(frozen=True)
class DataJuicerBatchParameters:
    np: int
    process: tuple[dict[str, object], ...]


class AdapterFailure(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class AdapterCancelled(Exception):
    pass


class DataJuicerBatchAdapter:
    descriptor = CapabilityDescriptor(
        name="data_juicer.batch",
        version="1",
        parameter_schema_name=PARAMETER_SCHEMA,
        parameter_schema_version=PARAMETER_VERSION,
        inputs=(ArtifactContract("input", MEDIA_TYPE),),
        outputs=(ArtifactContract("output", MEDIA_TYPE),),
    )

    def __init__(self, temp_root: Path | None = None) -> None:
        configured = os.environ.get("DATABENCH_WORKER_TEMP_ROOT")
        self._temp_root = temp_root or (
            Path(configured) if configured else Path("/tmp/databench-worker-v1")
        )

    def validate_parameters(self, payload: worker_pb2.JsonPayload) -> DataJuicerBatchParameters:
        if payload.schema_name != PARAMETER_SCHEMA or payload.schema_version != PARAMETER_VERSION:
            raise ValueError("unsupported Data-Juicer parameter schema")
        try:
            value = json.loads(payload.utf8_json.decode("utf-8"), object_pairs_hook=_strict_object)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise ValueError("Data-Juicer parameters must be strict UTF-8 JSON") from exc
        if not isinstance(value, dict) or set(value) != {"np", "process"}:
            raise ValueError("Data-Juicer parameters have an invalid shape")
        if type(value["np"]) is not int or value["np"] != 1:
            raise ValueError("Data-Juicer np must be exactly 1")
        if value["process"] != list(FIXED_PROCESS):
            raise ValueError("Data-Juicer process is not allowlisted")
        return DataJuicerBatchParameters(np=1, process=FIXED_PROCESS)

    async def run(
        self,
        context: RunContext,
        parameters: object,
    ):
        if not isinstance(parameters, DataJuicerBatchParameters):
            raise TypeError("Data-Juicer parameters were not validated")
        yield _started_event()
        job_dir: Path | None = None
        try:
            input_artifact, output_target = _validate_artifact_contract(context)
            _raise_if_stopped(context)
            self._temp_root.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(self._temp_root, 0o700)
            job_dir = Path(tempfile.mkdtemp(prefix="job-", dir=self._temp_root))
            os.chmod(job_dir, 0o700)
            input_path = job_dir / "input.jsonl"
            processed_path = job_dir / "processed.jsonl"
            retained_path = job_dir / "output.jsonl"
            config_path = job_dir / "config.json"

            await asyncio.to_thread(
                download_artifact,
                input_artifact.read_url,
                input_path,
                expected_size=input_artifact.size,
                expected_digest=input_artifact.digest,
                expected_media_type=MEDIA_TYPE,
                timeout_seconds=_transfer_timeout(context),
                stop_requested=lambda: _is_stopped(context),
            )
            input_count = await asyncio.to_thread(_validate_input, input_path)
            yield _progress_event("input_ready", 0, input_count)
            _raise_if_stopped(context)

            _write_config(config_path, input_path, processed_path)
            heartbeats: asyncio.Queue[None] = asyncio.Queue()
            process_task = asyncio.create_task(
                run_controlled_process(
                    _data_juicer_command(config_path),
                    cwd=job_dir,
                    env=_child_environment(job_dir),
                    cancellation=context.cancellation,
                    deadline_unix_ms=context.request.deadline_unix_ms,
                    heartbeats=heartbeats,
                )
            )
            while not process_task.done():
                try:
                    await asyncio.wait_for(heartbeats.get(), timeout=0.25)
                except TimeoutError:
                    continue
                yield _heartbeat_event()
            result = await process_task
            if result.status == "cancelled":
                yield _cancelled_event()
                return
            if result.status == "deadline":
                raise AdapterFailure("deadline_exceeded", "Data-Juicer execution exceeded its deadline")
            if result.returncode != 0:
                raise AdapterFailure("data_juicer_failed", "Data-Juicer execution failed")

            output_count = await asyncio.to_thread(
                _write_retained_output,
                processed_path,
                retained_path,
                output_target.max_size,
            )
            yield _progress_event("output_ready", input_count, input_count)
            _raise_if_stopped(context)
            descriptor = await asyncio.to_thread(
                upload_artifact,
                output_target.write_url,
                retained_path,
                media_type=MEDIA_TYPE,
                max_size=output_target.max_size,
                timeout_seconds=_transfer_timeout(context),
                stop_requested=lambda: _is_stopped(context),
            )
            _raise_if_stopped(context)
            yield worker_pb2.JobEvent(
                completed=worker_pb2.CompletedEvent(
                    timestamp_unix_ms=_now_ms(),
                    outputs=[
                        worker_pb2.OutputArtifact(
                            name="output",
                            size=descriptor.size,
                            digest=descriptor.digest,
                            record_count=output_count,
                        )
                    ],
                )
            )
        except AdapterCancelled:
            yield _cancelled_event()
        except AdapterFailure as exc:
            yield _failed_event(exc.code, exc.message, exc.retryable)
        except ArtifactTransferStopped:
            if context.cancellation.is_set():
                yield _cancelled_event()
            else:
                yield _failed_event(
                    "deadline_exceeded", "Data-Juicer execution exceeded its deadline"
                )
        except ArtifactTransferError:
            yield _failed_event("artifact_transfer_failed", "Worker artifact transfer failed", True)
        except (OSError, ValueError, json.JSONDecodeError, UnicodeDecodeError):
            yield _failed_event("invalid_execution_input", "Data-Juicer execution input is invalid")
        finally:
            if job_dir is not None:
                await asyncio.to_thread(shutil.rmtree, job_dir, True)


def _validate_artifact_contract(context: RunContext):
    request = context.request
    if len(request.inputs) != 1 or len(request.outputs) != 1:
        raise AdapterFailure("invalid_execution_input", "Data-Juicer requires one input and output")
    input_artifact = request.inputs[0]
    output_target = request.outputs[0]
    if input_artifact.name != "input" or input_artifact.media_type != MEDIA_TYPE:
        raise AdapterFailure("invalid_execution_input", "Data-Juicer input contract is invalid")
    if output_target.name != "output" or output_target.media_type != MEDIA_TYPE:
        raise AdapterFailure("invalid_execution_input", "Data-Juicer output contract is invalid")
    if input_artifact.size > MAX_ARTIFACT_BYTES or output_target.max_size > MAX_ARTIFACT_BYTES:
        raise AdapterFailure("invalid_execution_input", "Data-Juicer artifact limit is invalid")
    return input_artifact, output_target


def _validate_input(path: Path) -> int:
    count = 0
    seen: set[str] = set()
    with path.open("rb") as stream:
        for line_number, raw in enumerate(stream, start=1):
            if not raw.endswith(b"\n") or raw == b"\n":
                raise ValueError(f"invalid input line {line_number}")
            value = json.loads(raw[:-1].decode("utf-8"), object_pairs_hook=_strict_object)
            if not isinstance(value, dict) or set(value) != {"record_id", "record_digest", "text"}:
                raise ValueError(f"invalid input shape at line {line_number}")
            record_id = value["record_id"]
            record_digest = value["record_digest"]
            if not isinstance(record_id, str) or RECORD_ID.fullmatch(record_id) is None:
                raise ValueError(f"invalid record ID at line {line_number}")
            if not isinstance(record_digest, str) or DIGEST.fullmatch(record_digest) is None:
                raise ValueError(f"invalid record digest at line {line_number}")
            if not isinstance(value["text"], str) or record_id in seen:
                raise ValueError(f"invalid record text or duplicate ID at line {line_number}")
            seen.add(record_id)
            count += 1
    return count


def _write_retained_output(source: Path, destination: Path, max_size: int) -> int:
    count = 0
    size = 0
    seen: set[str] = set()
    with source.open("rb") as input_stream, destination.open("xb") as output_stream:
        os.chmod(destination, 0o600)
        for line_number, raw in enumerate(input_stream, start=1):
            if not raw.endswith(b"\n") or raw == b"\n":
                raise ValueError(f"invalid Data-Juicer output line {line_number}")
            value = json.loads(raw[:-1].decode("utf-8"), object_pairs_hook=_strict_object)
            if not isinstance(value, dict) or set(value) != {"record_id", "record_digest", "text"}:
                raise ValueError(f"invalid Data-Juicer output shape at line {line_number}")
            record_id = value["record_id"]
            record_digest = value["record_digest"]
            if (
                not isinstance(record_id, str)
                or RECORD_ID.fullmatch(record_id) is None
                or not isinstance(record_digest, str)
                or DIGEST.fullmatch(record_digest) is None
                or not isinstance(value["text"], str)
                or record_id in seen
            ):
                raise ValueError(f"invalid Data-Juicer output identity at line {line_number}")
            encoded = (
                json.dumps(
                    {"record_id": record_id, "record_digest": record_digest},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            if len(encoded) > max_size - size:
                raise AdapterFailure("output_limit_exceeded", "Data-Juicer output exceeds its limit")
            output_stream.write(encoded)
            size += len(encoded)
            seen.add(record_id)
            count += 1
        output_stream.flush()
        os.fsync(output_stream.fileno())
    return count


def _write_config(path: Path, input_path: Path, output_path: Path) -> None:
    config = {
        "project_name": "databench-basic-clean-v1",
        "dataset_path": str(input_path),
        "export_path": str(output_path),
        "export_type": "jsonl",
        "executor_type": "default",
        "np": 1,
        "text_keys": "text",
        "use_cache": False,
        "open_monitor": False,
        "keep_stats_in_res_ds": False,
        "op_fusion": False,
        "process": list(FIXED_PROCESS),
    }
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(config, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")


def _data_juicer_command(config_path: Path) -> tuple[str, ...]:
    child = Path(__file__).resolve().parents[1] / "data_juicer_child.py"
    return (sys.executable, "-I", str(child), "--config", str(config_path))


def _child_environment(job_dir: Path) -> dict[str, str]:
    executable_dir = str(Path(sys.executable).resolve().parent)
    return {
        "PATH": f"{executable_dir}:/usr/bin:/bin",
        "HOME": str(job_dir),
        "TMPDIR": str(job_dir),
        "XDG_CACHE_HOME": str(job_dir / "cache"),
        "HF_HOME": str(job_dir / "cache" / "huggingface"),
        "HF_DATASETS_CACHE": str(job_dir / "cache" / "datasets"),
        "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "LANG": "C.UTF-8",
    }


def _strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _raise_if_stopped(context: RunContext) -> None:
    if context.cancellation.is_set():
        raise AdapterCancelled
    if context.request.deadline_unix_ms <= _now_ms():
        raise AdapterFailure("deadline_exceeded", "Data-Juicer execution exceeded its deadline")


def _is_stopped(context: RunContext) -> bool:
    return context.cancellation.is_set() or context.request.deadline_unix_ms <= _now_ms()


def _transfer_timeout(context: RunContext) -> float:
    remaining = (context.request.deadline_unix_ms - _now_ms()) / 1000
    if remaining <= 0:
        raise AdapterFailure("deadline_exceeded", "Data-Juicer execution exceeded its deadline")
    return max(0.25, min(2.0, remaining))


def _started_event() -> worker_pb2.JobEvent:
    return worker_pb2.JobEvent(started=worker_pb2.StartedEvent(timestamp_unix_ms=_now_ms()))


def _heartbeat_event() -> worker_pb2.JobEvent:
    return worker_pb2.JobEvent(heartbeat=worker_pb2.HeartbeatEvent(timestamp_unix_ms=_now_ms()))


def _progress_event(phase: str, completed: int, total: int) -> worker_pb2.JobEvent:
    return worker_pb2.JobEvent(
        progress=worker_pb2.ProgressEvent(
            timestamp_unix_ms=_now_ms(),
            phase=phase,
            completed_units=completed,
            total_units=total,
        )
    )


def _failed_event(code: str, message: str, retryable: bool = False) -> worker_pb2.JobEvent:
    return worker_pb2.JobEvent(
        failed=worker_pb2.FailedEvent(
            timestamp_unix_ms=_now_ms(),
            code=code,
            message=message,
            retryable=retryable,
        )
    )


def _cancelled_event() -> worker_pb2.JobEvent:
    return worker_pb2.JobEvent(
        cancelled=worker_pb2.CancelledEvent(
            timestamp_unix_ms=_now_ms(),
            message="execution cancelled",
        )
    )


def _now_ms() -> int:
    return time.time_ns() // 1_000_000
