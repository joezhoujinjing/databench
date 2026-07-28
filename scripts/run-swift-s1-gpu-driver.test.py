#!/usr/bin/env python3
"""CPU-only unit coverage for S1 GPU driver compatibility helpers."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
DRIVER_PATH = SCRIPT_DIRECTORY / "run-swift-s1-gpu-driver.py"


def load_driver():
    fake_psutil = types.ModuleType("psutil")
    fake_psutil.AccessDenied = type("AccessDenied", (Exception,), {})
    fake_psutil.NoSuchProcess = type("NoSuchProcess", (Exception,), {})
    fake_psutil.ZombieProcess = type("ZombieProcess", (Exception,), {})
    fake_psutil.process_iter = lambda _attributes: []
    fake_torch = types.ModuleType("torch")
    fake_client_module = types.ModuleType("gradio_client")
    fake_client_module.Client = object

    stubs = {
        "psutil": fake_psutil,
        "torch": fake_torch,
        "gradio_client": fake_client_module,
    }
    previous = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        spec = importlib.util.spec_from_file_location("databench_swift_s1_gpu_driver", DRIVER_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load S1 GPU driver")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


DRIVER = load_driver()


class FakeProcess:
    def __init__(self, pid: int, cmdline: list[str]):
        self.info = {"pid": pid, "cmdline": cmdline}


class DriverCompatibilityTests(unittest.TestCase):
    def test_matches_python_shebang_swift_process(self) -> None:
        output = Path("/var/lib/databench-swift-studio/outputs/gs1-gpu-gate/complete/v0")
        DRIVER.psutil.process_iter = lambda _attributes: [
            FakeProcess(
                41,
                [
                    "/opt/conda/bin/python",
                    "/opt/conda/bin/swift",
                    "sft",
                    "--output_dir",
                    str(output),
                ],
            ),
            FakeProcess(42, ["python", "unrelated.py", "sft", str(output)]),
        ]

        self.assertEqual(DRIVER.processes_for_path(output, "sft"), [41])

    def test_excludes_hidden_gradio_state_from_public_inputs(self) -> None:
        studio = DRIVER.NativeStudio.__new__(DRIVER.NativeStudio)
        studio.components = {
            1: {"id": 1, "type": "textbox", "skip_api": False},
            2: {"id": 2, "type": "state", "skip_api": True},
            3: {"id": 3, "type": "slider", "skip_api": False},
        }

        dependency = {"inputs": [1, 2, 3]}
        self.assertEqual(studio.input_ids(dependency), [1, 3])
        studio.components[1]["props"] = {"value": "prompt"}
        studio.components[2]["props"] = {"value": "hidden"}
        studio.components[3]["props"] = {"value": 0.5}
        self.assertEqual(studio.values(dependency), ["prompt", 0.5])

    def test_parses_zombie_exit_status_with_parentheses_in_command(self) -> None:
        fields = ["Z", *(["0"] * 49)]
        fields[19] = "12345"
        fields[49] = "1792"

        stat = DRIVER.parse_proc_stat(f"123 (python worker) {' '.join(fields)}")

        self.assertEqual(stat, {"state": "Z", "starttime": 12345, "raw_exit_code": 1792})

    def test_rejects_nonfinite_final_training_loss(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            checkpoint = output / "checkpoint-2"
            checkpoint.mkdir()
            (checkpoint / "trainer_state.json").write_text(
                '{"global_step":2,"log_history":[{"step":1,"loss":1.0},{"step":2,"loss":NaN}]}',
                encoding="utf-8",
            )
            (checkpoint / "adapter_config.json").write_text("{}", encoding="utf-8")
            (checkpoint / "adapter_model.safetensors").write_bytes(b"adapter")
            (checkpoint / "args.json").write_text(
                '{"model_revision":"7ae557604adf67be50417f59c2c2f167def9a775"}',
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, "non-finite loss"):
                DRIVER.training_result(output, 2)

    def test_redacts_payload_keys_and_absolute_paths(self) -> None:
        payload_log, _ = DRIVER.sanitize_log("swift error {'messages': ['private']}")
        path_log, redactions = DRIVER.sanitize_log("swift loaded model from /opt/private/model")

        self.assertEqual(payload_log, "")
        self.assertNotIn("/opt/private/model", path_log)
        self.assertIn("<path>", path_log)
        self.assertGreater(redactions, 0)

    def test_waits_for_gpu_after_the_first_native_runtime_log(self) -> None:
        self.assertFalse(
            DRIVER.stop_observation_complete(
                native_log_observed=True,
                gpu_process_seen=False,
                process_running=True,
            )
        )
        self.assertTrue(
            DRIVER.stop_observation_complete(
                native_log_observed=True,
                gpu_process_seen=True,
                process_running=True,
            )
        )
        with self.assertRaisesRegex(RuntimeError, "before both native Runtime log and GPU context"):
            DRIVER.stop_observation_complete(
                native_log_observed=True,
                gpu_process_seen=False,
                process_running=False,
            )


if __name__ == "__main__":
    unittest.main()
