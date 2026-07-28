#!/usr/bin/env python3
"""Run the S1 native Gradio LoRA, stop, and Adapter Infer proof inside the image."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from typing import Any

import psutil
import torch
from gradio_client import Client


GATE_ID = "swift-s1-gpu@1"
STUDIO_URL = "http://127.0.0.1:7860/swift-studio/"
PROVIDER_URL = "http://127.0.0.1:7861"
WORKSPACE_ROOT = Path("/var/lib/databench-swift-studio")
FIXTURE_PATH = WORKSPACE_ROOT / "inputs/gs1-sft.jsonl"
OUTPUT_ROOT = WORKSPACE_ROOT / "outputs/gs1-gpu-gate"
EVIDENCE_ROOT = WORKSPACE_ROOT / "evidence/gs1-gpu-gate"
MODEL = os.environ.get("DATABENCH_SWIFT_GATE_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")
MODEL_REVISION = os.environ.get(
    "DATABENCH_SWIFT_GATE_MODEL_REVISION", "7ae557604adf67be50417f59c2c2f167def9a775"
)
COMPLETE_STEPS = int(os.environ.get("DATABENCH_SWIFT_GATE_STEPS", "2"))
TIMEOUT_SECONDS = int(os.environ.get("DATABENCH_SWIFT_GATE_TIMEOUT_SECONDS", "3600"))
MEMORY_RELEASE_TOLERANCE_MIB = 512

ALLOWED_MODELS = {
    "Qwen/Qwen2.5-0.5B-Instruct": "7ae557604adf67be50417f59c2c2f167def9a775",
    "Qwen/Qwen3-0.6B": "c1899de289a04d12100db370d81485cdf75e47ca",
}
LOG_DENY = re.compile(
    r"(?i)(authorization|bearer\s|api[_-]?key|access[_-]?token|secret|"
    r"[\"'](?:messages|content|prompt)[\"']\s*:|(?:^|\s)prompt\s*[:=])"
)
LOG_ALLOW = re.compile(
    r"(?i)(swift|train|step|loss|global_step|adapter|lora|cuda|gpu|memory|model|server|started|running|loaded|saving|checkpoint|error|exception|traceback)"
)
PATH_REDACTIONS = (
    (re.compile(re.escape(str(WORKSPACE_ROOT))), "<workspace>"),
    (re.compile(r"/root/\.cache/(?:huggingface|modelscope)[^\s\"']*"), "<model-cache>"),
    (re.compile(r"(^|[\s=:(])/(?!swift-studio(?:/|\b))[^\s\"']+"), r"\1<path>"),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stable_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def read_json_url(url: str, timeout: float = 10) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run(argv: list[str], *, timeout: float = 30, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    if check and result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {argv[0]}: {result.stderr.strip()}")
    return result


def nvidia_snapshot() -> list[dict[str, Any]]:
    result = run(
        [
            "nvidia-smi",
            "--query-gpu=index,name,uuid,driver_version,memory.total,memory.used",
            "--format=csv,noheader,nounits",
        ]
    )
    devices = []
    for line in result.stdout.splitlines():
        fields = [field.strip() for field in line.split(",")]
        if len(fields) != 6:
            raise RuntimeError("unexpected nvidia-smi GPU row")
        index, name, uuid, driver, total, used = fields
        devices.append(
            {
                "index": int(index),
                "name": name,
                "uuid": uuid,
                "driver_version": driver,
                "memory_total_mib": int(total),
                "memory_used_mib": int(used),
            }
        )
    if not devices:
        raise RuntimeError("nvidia-smi returned no GPU")
    return devices


def processes_for_path(path: Path, command: str) -> list[int]:
    matches: list[int] = []
    needle = str(path)
    for process in psutil.process_iter(["pid", "cmdline"]):
        try:
            argv = process.info.get("cmdline") or []
        except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
            continue
        has_swift_executable = any(Path(argument).name == "swift" for argument in argv)
        if has_swift_executable and command in argv and needle in argv:
            matches.append(int(process.info["pid"]))
    return matches


def process_tree_pids(pid: int) -> set[int]:
    try:
        process = psutil.Process(pid)
        return {pid, *(child.pid for child in process.children(recursive=True))}
    except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
        return {pid}


def parse_proc_stat(raw: str) -> dict[str, Any]:
    command_end = raw.rfind(")")
    if command_end < 0:
        raise RuntimeError("process stat has no command terminator")
    fields = raw[command_end + 1 :].strip().split()
    if len(fields) < 50:
        raise RuntimeError("process stat is truncated")
    return {
        "state": fields[0],
        "starttime": int(fields[19]),
        "raw_exit_code": int(fields[49]),
    }


def read_process_stat(pid: int) -> dict[str, Any] | None:
    try:
        return parse_proc_stat(Path(f"/proc/{pid}/stat").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def task_process_identity(task: str, path: Path, command: str) -> dict[str, int]:
    match = re.match(r"pid:(\d+)/", task)
    if not match:
        raise RuntimeError("native Runtime task has no PID")
    pid = int(match.group(1))
    if pid not in processes_for_path(path, command):
        raise RuntimeError(f"native Runtime PID is not the expected swift {command} process")
    stat = read_process_stat(pid)
    if stat is None or stat["state"] == "Z":
        raise RuntimeError(f"swift {command} process exited before its identity was captured")
    return {"pid": pid, "starttime": stat["starttime"]}


def exited_process_status(identity: dict[str, int], command: str) -> int:
    stat = read_process_stat(identity["pid"])
    if stat is None:
        raise RuntimeError(f"swift {command} exit status disappeared before verification")
    if stat["starttime"] != identity["starttime"]:
        raise RuntimeError(f"swift {command} PID was reused before exit verification")
    if stat["state"] != "Z":
        raise RuntimeError(f"swift {command} process is not in a terminal zombie state")
    return os.waitstatus_to_exitcode(stat["raw_exit_code"])


def process_identity_sha256(identity: dict[str, int]) -> str:
    return sha256_bytes(f"{identity['pid']}:{identity['starttime']}".encode())


def nvidia_compute_processes() -> list[dict[str, int]]:
    result = run(
        [
            "nvidia-smi",
            "--query-compute-apps=pid,used_memory",
            "--format=csv,noheader,nounits",
        ]
    )
    processes = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        fields = [field.strip() for field in line.split(",")]
        if len(fields) != 2:
            raise RuntimeError("unexpected nvidia-smi compute process row")
        processes.append({"pid": int(fields[0]), "memory_used_mib": int(fields[1])})
    return processes


def wait_for_memory_release(baseline_mib: int, deadline: float) -> int:
    last_used = -1
    while time.monotonic() < deadline:
        devices = nvidia_snapshot()
        last_used = max(device["memory_used_mib"] for device in devices)
        if last_used <= baseline_mib + MEMORY_RELEASE_TOLERANCE_MIB:
            return last_used
        time.sleep(1)
    raise RuntimeError(
        f"GPU memory did not return to the gate baseline within {MEMORY_RELEASE_TOLERANCE_MIB} MiB"
    )


def sanitize_log(raw: str) -> tuple[str, int]:
    kept: list[str] = []
    redactions = 0
    for line in raw.splitlines()[-4000:]:
        if LOG_DENY.search(line):
            redactions += 1
            continue
        if not LOG_ALLOW.search(line):
            continue
        for pattern, replacement in PATH_REDACTIONS:
            line, count = pattern.subn(replacement, line)
            redactions += count
        line, count = re.subn(
            r"(?i)((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+",
            r"\1<redacted>",
            line,
        )
        redactions += count
        kept.append(line[:2000])
        if len(kept) == 500:
            break
    return "\n".join(kept) + ("\n" if kept else ""), redactions


def sanitize_diagnostic(raw: str) -> str:
    if LOG_DENY.search(raw):
        return "<sensitive diagnostic redacted>"
    redacted = raw
    for pattern, replacement in PATH_REDACTIONS:
        redacted = pattern.sub(replacement, redacted)
    redacted = re.sub(
        r"(?i)((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+",
        r"\1<redacted>",
        redacted,
    )
    return redacted[:4000]


def bounded_text(path: Path, limit: int = 8 * 1024 * 1024) -> str:
    if not path.is_file() or path.is_symlink():
        return ""
    with path.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - limit))
        return handle.read(limit).decode("utf-8", errors="replace")


class NativeStudio:
    def __init__(self) -> None:
        self.config = read_json_url(STUDIO_URL + "config", timeout=30)
        self.components = {component["id"]: component for component in self.config["components"]}
        self.dependencies = self.config["dependencies"]
        self.client = Client(
            STUDIO_URL,
            verbose=False,
            analytics_enabled=False,
            download_files=False,
        )

    def component_id(self, dependency: dict[str, Any], elem_id: str) -> int:
        matches = [
            component_id
            for component_id in dependency["inputs"]
            if self.components[component_id].get("props", {}).get("elem_id") == elem_id
        ]
        if len(matches) != 1:
            raise RuntimeError(f"expected one {elem_id} input, found {len(matches)}")
        return matches[0]

    def dependency(self, api_name: str) -> dict[str, Any]:
        matches = [item for item in self.dependencies if item.get("api_name") == api_name]
        if len(matches) != 1:
            raise RuntimeError(f"expected one /{api_name} callback, found {len(matches)}")
        return matches[0]

    def button_dependency(
        self, running_component_id: int, button_elem_id: str
    ) -> dict[str, Any]:
        matches = []
        for dependency in self.dependencies:
            if running_component_id not in dependency.get("inputs", []):
                continue
            if any(
                self.components.get(target[0], {}).get("props", {}).get("elem_id") == button_elem_id
                for target in dependency.get("targets", [])
            ):
                matches.append(dependency)
        if len(matches) != 1:
            raise RuntimeError(
                f"expected one {button_elem_id} callback for component {running_component_id}, "
                f"found {len(matches)}"
            )
        return matches[0]

    def model_change_dependency(
        self, action_dependency: dict[str, Any], model_component_id: int
    ) -> dict[str, Any]:
        required_outputs = {
            component_id
            for component_id in action_dependency["inputs"]
            if self.components[component_id].get("props", {}).get("elem_id")
            in {"model", "model_type", "template"}
        }
        matches = [
            dependency
            for dependency in self.dependencies
            if [model_component_id, "change"] in dependency.get("targets", [])
            and dependency.get("inputs") == [model_component_id]
            and required_outputs.issubset(set(dependency.get("outputs", [])))
        ]
        if len(matches) != 1:
            raise RuntimeError(f"expected one model change callback, found {len(matches)}")
        return matches[0]

    def output_ids(self, dependency: dict[str, Any]) -> list[int]:
        return [
            component_id
            for component_id in dependency.get("outputs", [])
            if not self.components[component_id].get("skip_api", False)
        ]

    def input_ids(self, dependency: dict[str, Any]) -> list[int]:
        return [
            component_id
            for component_id in dependency.get("inputs", [])
            if not self.components[component_id].get("skip_api", False)
        ]

    def output_map(self, dependency: dict[str, Any], result: Any) -> dict[int, Any]:
        values = result if isinstance(result, tuple) else (result,)
        output_ids = self.output_ids(dependency)
        if len(values) != len(output_ids):
            raise RuntimeError(
                f"callback {dependency['id']} returned {len(values)} values, expected {len(output_ids)}"
            )
        return dict(zip(output_ids, values))

    @staticmethod
    def update_value(value: Any) -> Any:
        return value.get("value") if isinstance(value, dict) and "value" in value else value

    def values(
        self,
        dependency: dict[str, Any],
        *,
        model: str | None = None,
        overrides: dict[str, Any] | None = None,
    ) -> list[Any]:
        current = {
            component_id: self.components[component_id].get("props", {}).get("value")
            for component_id in self.input_ids(dependency)
        }
        if model is not None:
            model_component_id = self.component_id(dependency, "model")
            change = self.model_change_dependency(dependency, model_component_id)
            change_result = self.client.predict(model, fn_index=change["id"])
            for component_id, value in self.output_map(change, change_result).items():
                if isinstance(value, dict) and "value" in value:
                    current[component_id] = value["value"]
            current[model_component_id] = model

        for elem_id, override in (overrides or {}).items():
            component_id = self.component_id(dependency, elem_id)
            current[component_id] = override
        return [current[component_id] for component_id in self.input_ids(dependency)]

    def invoke(self, dependency: dict[str, Any], *args: Any) -> dict[int, Any]:
        result = self.client.predict(*args, fn_index=dependency["id"])
        return self.output_map(dependency, result)

    def refresh_task(self, running_component_id: int, current: str | None = None) -> str | None:
        dependency = self.button_dependency(running_component_id, "refresh_tasks")
        output = self.invoke(dependency, current)
        return self.update_value(output[running_component_id])


def task_from_output(studio: NativeStudio, output: dict[int, Any], running_id: int) -> str | None:
    value = output.get(running_id)
    return studio.update_value(value) if value is not None else None


def wait_for_task(
    studio: NativeStudio, running_id: int, current: str | None, deadline: float
) -> str:
    while time.monotonic() < deadline:
        task = studio.refresh_task(running_id, current)
        if task:
            return task
        time.sleep(1)
    raise TimeoutError("native Runtime did not expose the task")


def wait_for_no_process(path: Path, command: str, deadline: float) -> None:
    while time.monotonic() < deadline:
        if not processes_for_path(path, command):
            return
        time.sleep(1)
    raise TimeoutError(f"swift {command} process did not exit")


def stop_observation_complete(
    *, native_log_observed: bool, gpu_process_seen: bool, process_running: bool
) -> bool:
    if native_log_observed and gpu_process_seen:
        return True
    if not process_running:
        raise RuntimeError(
            "long task exited before both native Runtime log and GPU context were observed"
        )
    return False


def parse_actual_output(logging_dir: str, allowed_parent: Path) -> Path:
    output = Path(logging_dir).resolve().parent
    parent = allowed_parent.resolve()
    if not output.is_relative_to(parent):
        raise RuntimeError("native callback returned an output directory outside the gate root")
    return output


def find_args_json(adapter_dir: Path, output_dir: Path) -> Path:
    for candidate in [adapter_dir / "args.json", *[parent / "args.json" for parent in adapter_dir.parents]]:
        if candidate.is_file() and candidate.resolve().is_relative_to(output_dir.resolve()):
            return candidate
        if candidate.parent == output_dir.parent:
            break
    matches = [path for path in output_dir.rglob("args.json") if path.is_file() and not path.is_symlink()]
    if not matches:
        raise RuntimeError("training output has no args.json")
    return sorted(matches)[0]


def training_result(output_dir: Path, expected_steps: int) -> dict[str, Any]:
    states = []
    for path in sorted(output_dir.rglob("trainer_state.json")):
        if path.is_file() and not path.is_symlink():
            value = read_json(path)
            if isinstance(value, dict):
                states.append(value)
    steps = max((int(state.get("global_step", 0)) for state in states), default=0)
    losses: list[dict[str, float]] = []
    for state in states:
        for entry in state.get("log_history", []):
            if isinstance(entry, dict) and isinstance(entry.get("loss"), (int, float)):
                loss = float(entry["loss"])
                if not math.isfinite(loss):
                    raise RuntimeError("training recorded a non-finite loss")
                step = entry.get("step")
                if not isinstance(step, (int, float)) or not math.isfinite(float(step)):
                    raise RuntimeError("training loss has no finite step")
                losses.append({"step": float(step), "loss": loss})
    if steps != expected_steps:
        raise RuntimeError(f"training completed {steps} steps, expected {expected_steps}")
    final_losses = [entry for entry in losses if entry["step"] == expected_steps]
    if not final_losses:
        raise RuntimeError("training did not record a finite loss at the final expected step")
    final_loss = final_losses[-1]

    adapters = []
    for config_path in output_dir.rglob("adapter_config.json"):
        adapter_dir = config_path.parent
        if config_path.is_symlink() or not config_path.is_file():
            continue
        model_files = sorted(adapter_dir.glob("adapter_model*.safetensors"))
        if model_files and all(path.is_file() and not path.is_symlink() for path in model_files):
            adapters.append(adapter_dir)
    if not adapters:
        raise RuntimeError("training produced no LoRA safetensors adapter")
    checkpoint_name = f"checkpoint-{expected_steps}"
    adapter_dir = next(
        (path for path in adapters if path.name == checkpoint_name),
        sorted(adapters, key=lambda value: (len(value.parts), str(value)))[0],
    )
    args_path = find_args_json(adapter_dir, output_dir)
    args = read_json(args_path)
    if args.get("model_revision") != MODEL_REVISION:
        raise RuntimeError("args.json does not retain the exact requested model revision")

    files = []
    for path in sorted(
        [adapter_dir / "adapter_config.json", *adapter_dir.glob("adapter_model*.safetensors")]
    ):
        data = path.read_bytes()
        files.append(
            {
                "name": path.name,
                "bytes": len(data),
                "sha256": sha256_bytes(data),
            }
        )
    return {
        "actual_steps": steps,
        "finite_loss_count": len(losses),
        "final_loss": final_loss["loss"],
        "final_loss_step": int(final_loss["step"]),
        "adapter_dir": adapter_dir,
        "adapter_files": files,
        "adapter_bundle_sha256": sha256_bytes(stable_json(files)),
        "model_dir_revision_matched": MODEL_REVISION in str(args.get("model_dir", "")),
    }


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def endpoint_ready(port: int) -> bool:
    for path in ("/health", "/v1/models"):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as response:
                if 200 <= response.status < 300:
                    return True
        except (OSError, urllib.error.URLError):
            continue
    return False


def assistant_text(chatbot: Any) -> str:
    if isinstance(chatbot, list):
        for item in reversed(chatbot):
            if isinstance(item, (list, tuple)) and len(item) == 2 and isinstance(item[1], str):
                if item[1].strip():
                    return item[1].strip()
            if isinstance(item, dict) and item.get("role") == "assistant":
                content = item.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
    return ""


def task_log_path(task: str) -> Path | None:
    match = re.search(r"(?:^|\s)--log_file\s+([^\s]+)", task)
    if not match:
        return None
    path = Path(match.group(1).strip("'\""))
    resolved = path.resolve()
    return resolved if resolved.is_relative_to(WORKSPACE_ROOT.resolve()) else None


def write_log(name: str, raw: str, evidence: dict[str, Any]) -> None:
    sanitized, redactions = sanitize_log(raw)
    path = EVIDENCE_ROOT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(sanitized, encoding="utf-8")
    data = path.read_bytes()
    evidence.setdefault("logs", {})[name] = {
        "bytes": len(data),
        "sha256": sha256_bytes(data),
        "redaction_count": redactions,
    }


def main() -> int:
    started_at = utc_now()
    evidence: dict[str, Any] = {
        "schema_version": 1,
        "gate_id": GATE_ID,
        "started_at": started_at,
        "finished_at": None,
        "result": "failed",
        "failure": None,
        "logs": {},
    }
    complete_task: str | None = None
    stop_task: str | None = None
    infer_task: str | None = None
    peak_memory = 0
    try:
        if MODEL not in ALLOWED_MODELS or ALLOWED_MODELS[MODEL] != MODEL_REVISION:
            raise RuntimeError("model and revision are not an approved S1 GPU fixture")
        if COMPLETE_STEPS < 2 or COMPLETE_STEPS > 5:
            raise RuntimeError("completed training steps must remain in the accepted 2..5 range")
        fixture = FIXTURE_PATH.read_bytes()
        lines = fixture.splitlines()
        if len(lines) != 32:
            raise RuntimeError("S1 fixture must contain exactly 32 JSONL records")
        for line in lines:
            value = json.loads(line)
            if not isinstance(value.get("messages"), list) or len(value["messages"]) < 2:
                raise RuntimeError("S1 fixture is not ms-swift messages JSONL")

        runtime = read_json_url(PROVIDER_URL + "/runtime", timeout=30)
        if runtime.get("gpu_available") is not True or not torch.cuda.is_available():
            raise RuntimeError("Provider and Torch must both report a real CUDA GPU")
        devices = nvidia_snapshot()
        idle_baseline = max(device["memory_used_mib"] for device in devices)
        peak_memory = idle_baseline
        evidence["runtime"] = {
            "process_uid": os.getuid(),
            "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "torch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "transformers": version("transformers"),
            "gradio": version("gradio"),
            "ms_swift": version("ms-swift"),
            "gpu_available": runtime.get("gpu_available"),
            "cuda_available": torch.cuda.is_available(),
            "capability_manifest_phase": runtime.get("capability_manifest_phase"),
            "capability_manifest_sha256": runtime.get("capability_manifest_sha256"),
        }
        evidence["gpu"] = {
            "devices": devices,
            "idle_baseline_mib": idle_baseline,
            "memory_release_tolerance_mib": MEMORY_RELEASE_TOLERANCE_MIB,
            "peak_memory_used_mib": peak_memory,
        }
        evidence["fixture"] = {
            "name": "swift-s1-gpu-sft.jsonl",
            "record_count": len(lines),
            "bytes": len(fixture),
            "sha256": sha256_bytes(fixture),
        }
        evidence["model"] = {"reference": MODEL, "revision": MODEL_REVISION, "hub": "huggingface"}

        studio = NativeStudio()
        train = studio.dependency("train_local")
        train_running_id = next(
            component_id
            for component_id in train["outputs"]
            if studio.components[component_id].get("props", {}).get("elem_id") == "running_tasks"
        )
        train_kill = studio.button_dependency(train_running_id, "kill_task")
        train_wait = next(
            dependency
            for dependency in studio.dependencies
            if dependency.get("api_name") == "wait" and train_running_id in dependency.get("inputs", [])
        )
        evidence["gradio"] = {
            "root_path": studio.config.get("root"),
            "version": studio.config.get("version"),
            "component_count": len(studio.config["components"]),
            "dependency_count": len(studio.dependencies),
            "callbacks": {
                "train_local": train["id"],
                "train_kill_task": train_kill["id"],
                "train_wait": train_wait["id"],
            },
        }

        complete_requested_root = OUTPUT_ROOT / "complete"
        complete_overrides = {
            "train_stage": "sft",
            "tuner_type": "lora",
            "torch_dtype": "float16",
            "gpu_id": ["0"],
            "use_ddp": False,
            "dry_run": False,
            "more_params": json.dumps({"model_revision": MODEL_REVISION}),
            "dataset": [str(FIXTURE_PATH)],
            "split_dataset_ratio": 0.0,
            "max_length": 128,
            "lora_rank": 8,
            "lora_alpha": 16,
            "per_device_train_batch_size": 1,
            "per_device_eval_batch_size": 1,
            "gradient_accumulation_steps": 1,
            "save_steps": "1",
            "logging_steps": "1",
            "max_steps": str(COMPLETE_STEPS),
            "output_dir": str(complete_requested_root),
            "report_to": ["tensorboard"],
        }
        complete_output = studio.invoke(
            train, *studio.values(train, model=MODEL, overrides=complete_overrides)
        )
        logging_id = studio.component_id(train, "logging_dir")
        logging_dir = str(studio.update_value(complete_output[logging_id]))
        complete_actual_root = parse_actual_output(logging_dir, complete_requested_root)
        complete_task = task_from_output(studio, complete_output, train_running_id)
        deadline = time.monotonic() + TIMEOUT_SECONDS
        complete_task = wait_for_task(studio, train_running_id, complete_task, min(deadline, time.monotonic() + 60))
        complete_identity = task_process_identity(complete_task, complete_actual_root, "sft")
        process_seen = True
        training_gpu_process_seen = False
        training_gate_compute_pids: set[int] = set()
        while time.monotonic() < deadline:
            running = processes_for_path(complete_actual_root, "sft")
            compute_pids = {item["pid"] for item in nvidia_compute_processes()}
            training_gate_compute_pids.update(
                compute_pids.intersection(process_tree_pids(complete_identity["pid"]))
            )
            training_gpu_process_seen = training_gpu_process_seen or bool(training_gate_compute_pids)
            devices = nvidia_snapshot()
            peak_memory = max(peak_memory, *(device["memory_used_mib"] for device in devices))
            if complete_identity["pid"] not in running:
                break
            time.sleep(2)
        else:
            raise TimeoutError("completed LoRA task exceeded the gate timeout")
        complete_exit_code = exited_process_status(complete_identity, "sft")
        if complete_exit_code != 0:
            raise RuntimeError(f"completed LoRA process exited with status {complete_exit_code}")
        if not training_gpu_process_seen:
            raise RuntimeError("completed LoRA process was never observed as a GPU compute process")
        training_compute_processes_after = len(
            training_gate_compute_pids.intersection(
                {item["pid"] for item in nvidia_compute_processes()}
            )
        )
        if training_compute_processes_after != 0:
            raise RuntimeError("completed LoRA process tree still owns a GPU compute context")
        training_memory_after = wait_for_memory_release(idle_baseline, time.monotonic() + 60)
        complete = training_result(complete_actual_root, COMPLETE_STEPS)
        train_log = bounded_text(Path(logging_dir) / "run.log")
        write_log("training.sanitized.log", train_log, evidence)
        evidence["training"] = {
            "callback": {"api_name": "train_local", "fn_index": train["id"]},
            "process_seen": process_seen,
            "gpu_process_seen": training_gpu_process_seen,
            "pid_starttime_sha256": process_identity_sha256(complete_identity),
            "exit_code": complete_exit_code,
            "terminal": "completed",
            "gate_compute_processes_after": training_compute_processes_after,
            "memory_after_mib": training_memory_after,
            "parameters": {
                "tuner_type": "lora",
                "rank": 8,
                "max_steps": COMPLETE_STEPS,
                "max_length": 128,
                "batch_size": 1,
                "gradient_accumulation_steps": 1,
                "save_steps": 1,
            },
            "actual_steps": complete["actual_steps"],
            "finite_loss_count": complete["finite_loss_count"],
            "final_loss": complete["final_loss"],
            "final_loss_step": complete["final_loss_step"],
            "adapter_files": complete["adapter_files"],
            "adapter_bundle_sha256": complete["adapter_bundle_sha256"],
            "model_dir_revision_matched": complete["model_dir_revision_matched"],
        }

        stop_requested_root = OUTPUT_ROOT / "stop"
        stop_overrides = dict(complete_overrides)
        stop_overrides.update(
            {
                "max_steps": "1000",
                "save_steps": "500",
                "output_dir": str(stop_requested_root),
            }
        )
        stop_output = studio.invoke(train, *studio.values(train, model=MODEL, overrides=stop_overrides))
        stop_logging_dir = str(studio.update_value(stop_output[logging_id]))
        stop_actual_root = parse_actual_output(stop_logging_dir, stop_requested_root)
        stop_task = task_from_output(studio, stop_output, train_running_id)
        stop_task = wait_for_task(
            studio, train_running_id, stop_task, time.monotonic() + min(90, TIMEOUT_SECONDS)
        )
        stop_identity = task_process_identity(stop_task, stop_actual_root, "sft")
        stop_process_seen = bool(processes_for_path(stop_actual_root, "sft"))
        if not stop_process_seen:
            raise RuntimeError("long task was not live before native stop")
        stop_gate_compute_pids = {
            item["pid"] for item in nvidia_compute_processes()
        }.intersection(process_tree_pids(stop_identity["pid"]))
        stop_gpu_process_seen = bool(stop_gate_compute_pids)
        wait_job = studio.client.submit(stop_logging_dir, stop_task, fn_index=train_wait["id"])
        log_deadline = time.monotonic() + 90
        native_log_observed = False
        while time.monotonic() < log_deadline:
            native_log_observed = native_log_observed or bool(wait_job.outputs())
            stop_gate_compute_pids.update(
                {item["pid"] for item in nvidia_compute_processes()}.intersection(
                    process_tree_pids(stop_identity["pid"])
                )
            )
            stop_gpu_process_seen = stop_gpu_process_seen or bool(stop_gate_compute_pids)
            process_running = bool(processes_for_path(stop_actual_root, "sft"))
            if stop_observation_complete(
                native_log_observed=native_log_observed,
                gpu_process_seen=stop_gpu_process_seen,
                process_running=process_running,
            ):
                break
            time.sleep(1)
        if not native_log_observed:
            raise RuntimeError("native Runtime wait callback did not stream training log output")
        if not stop_gpu_process_seen:
            raise RuntimeError("long task was never observed as a GPU compute process before stop")
        studio.invoke(train_kill, stop_task)
        wait_for_no_process(stop_actual_root, "sft", time.monotonic() + 60)
        stop_exit_code = exited_process_status(stop_identity, "sft")
        if stop_exit_code >= 0:
            raise RuntimeError("native stop did not terminate the long task with a signal")
        stop_compute_processes_after = len(
            stop_gate_compute_pids.intersection(
                {item["pid"] for item in nvidia_compute_processes()}
            )
        )
        if stop_compute_processes_after != 0:
            raise RuntimeError("stopped training process still owns a GPU compute context")
        stop_memory_after = wait_for_memory_release(idle_baseline, time.monotonic() + 60)
        wait_job.result(timeout=60)
        stop_task = None
        stopped_log = bounded_text(Path(stop_logging_dir) / "run.log")
        write_log("stop.sanitized.log", stopped_log, evidence)
        evidence["stop"] = {
            "callback": {"api_name": train_kill.get("api_name"), "fn_index": train_kill["id"]},
            "runtime_log_callback": {"api_name": train_wait.get("api_name"), "fn_index": train_wait["id"]},
            "configured_max_steps": 1000,
            "process_seen": stop_process_seen,
            "gpu_process_seen": stop_gpu_process_seen,
            "pid_starttime_sha256": process_identity_sha256(stop_identity),
            "native_log_observed": native_log_observed,
            "process_exited": True,
            "exit_signal": -stop_exit_code,
            "gate_compute_processes_after": stop_compute_processes_after,
            "memory_after_mib": stop_memory_after,
            "terminal": "stopped",
        }

        adapter_dir: Path = complete["adapter_dir"]
        deploy = studio.dependency("deploy_model")
        infer_running_id = next(
            component_id
            for component_id in deploy["outputs"]
            if studio.components[component_id].get("props", {}).get("elem_id") == "running_tasks"
        )
        infer_kill = studio.button_dependency(infer_running_id, "kill_task")
        port = free_port()
        deploy_overrides = {
            "gpu_id": ["0"],
            "port": str(port),
            "infer_backend": "transformers",
            "max_new_tokens": "32",
            "temperature": 0.1,
            "top_k": 20,
            "top_p": 0.7,
            "repetition_penalty": 1.0,
        }
        deploy_values = studio.values(deploy, model=str(adapter_dir), overrides=deploy_overrides)
        deploy_component_values = dict(zip(studio.input_ids(deploy), deploy_values))
        deploy_output = studio.invoke(deploy, *deploy_values)
        infer_task = task_from_output(studio, deploy_output, infer_running_id)
        infer_task = wait_for_task(
            studio, infer_running_id, infer_task, time.monotonic() + min(120, TIMEOUT_SECONDS)
        )
        infer_identity = task_process_identity(infer_task, adapter_dir, "deploy")
        infer_gpu_process_seen = False
        infer_gate_compute_pids: set[int] = set()
        infer_deadline = time.monotonic() + TIMEOUT_SECONDS
        while time.monotonic() < infer_deadline:
            infer_gate_compute_pids.update(
                {item["pid"] for item in nvidia_compute_processes()}.intersection(
                    process_tree_pids(infer_identity["pid"])
                )
            )
            infer_gpu_process_seen = infer_gpu_process_seen or bool(infer_gate_compute_pids)
            devices = nvidia_snapshot()
            peak_memory = max(peak_memory, *(device["memory_used_mib"] for device in devices))
            if endpoint_ready(port):
                break
            if not processes_for_path(adapter_dir, "deploy"):
                raise RuntimeError("native Adapter deployment exited before becoming ready")
            time.sleep(2)
        else:
            raise TimeoutError("native Adapter deployment did not become ready")
        if not infer_gpu_process_seen:
            raise RuntimeError("Adapter deployment was never observed as a GPU compute process")

        send = studio.dependency("send_message")
        send_input_ids = studio.input_ids(send)
        send_state_input_count = len(send["inputs"]) - len(send_input_ids)
        send_values = {
            component_id: deploy_component_values.get(
                component_id, studio.components[component_id].get("props", {}).get("value")
            )
            for component_id in send_input_ids
        }
        send_values[infer_running_id] = infer_task
        for component_id in send_input_ids:
            elem_id = studio.components[component_id].get("props", {}).get("elem_id")
            if elem_id == "prompt":
                send_values[component_id] = "Reply with one short word confirming readiness."
            elif elem_id == "max_new_tokens":
                send_values[component_id] = "32"
            elif elem_id == "temperature":
                send_values[component_id] = 0.1
            elif elem_id == "repetition_penalty":
                send_values[component_id] = 1.0
        send_output = studio.invoke(send, *(send_values[component_id] for component_id in send_input_ids))
        chatbot_id = next(
            component_id
            for component_id in send["outputs"]
            if studio.components[component_id].get("props", {}).get("elem_id") == "chatbot"
        )
        response = assistant_text(send_output[chatbot_id])
        if not response:
            raise RuntimeError("native send_message callback returned no assistant text")
        infer_log_path = task_log_path(infer_task)
        write_log(
            "infer.sanitized.log",
            bounded_text(infer_log_path) if infer_log_path is not None else "",
            evidence,
        )
        studio.invoke(infer_kill, infer_task)
        wait_for_no_process(adapter_dir, "deploy", time.monotonic() + 60)
        infer_exit_code = exited_process_status(infer_identity, "deploy")
        if infer_exit_code >= 0:
            raise RuntimeError("native infer kill did not terminate Adapter deployment with a signal")
        infer_compute_processes_after = len(
            infer_gate_compute_pids.intersection(
                {item["pid"] for item in nvidia_compute_processes()}
            )
        )
        if infer_compute_processes_after != 0:
            raise RuntimeError("stopped Adapter deployment still owns a GPU compute context")
        infer_memory_after = wait_for_memory_release(idle_baseline, time.monotonic() + 60)
        server_deadline = time.monotonic() + 60
        while time.monotonic() < server_deadline and endpoint_ready(port):
            time.sleep(1)
        if endpoint_ready(port):
            raise RuntimeError("native Adapter deployment remained reachable after kill_task")
        infer_task = None
        evidence["infer"] = {
            "deploy_callback": {"api_name": "deploy_model", "fn_index": deploy["id"]},
            "message_callback": {"api_name": "send_message", "fn_index": send["id"]},
            "kill_callback": {"api_name": infer_kill.get("api_name"), "fn_index": infer_kill["id"]},
            "backend": "transformers",
            "adapter_bundle_sha256": complete["adapter_bundle_sha256"],
            "endpoint_ready": True,
            "gpu_process_seen": infer_gpu_process_seen,
            "pid_starttime_sha256": process_identity_sha256(infer_identity),
            "response_char_count": len(response),
            "response_sha256": sha256_bytes(response.encode()),
            "exit_signal": -infer_exit_code,
            "gate_compute_processes_after": infer_compute_processes_after,
            "memory_after_mib": infer_memory_after,
            "deployment_stopped": True,
        }
        evidence["gradio"]["callbacks"].update(
            {
                "deploy_model": deploy["id"],
                "send_message": send["id"],
                "infer_kill_task": infer_kill["id"],
            }
        )
        evidence["gradio"].update(
            {
                "send_message_input_count": len(send["inputs"]),
                "send_message_public_input_count": len(send_input_ids),
                "send_message_state_input_count": send_state_input_count,
            }
        )
        evidence["gpu"]["peak_memory_used_mib"] = peak_memory
        evidence["result"] = "passed"
        return 0
    except Exception as error:
        evidence["failure"] = {
            "type": type(error).__name__,
            "message": sanitize_diagnostic(str(error))[:1000],
        }
        sys.stderr.write(sanitize_diagnostic(traceback.format_exc()) + "\n")
        return 1
    finally:
        evidence["finished_at"] = utc_now()
        write_json(EVIDENCE_ROOT / "driver-evidence.json", evidence)


if __name__ == "__main__":
    raise SystemExit(main())
