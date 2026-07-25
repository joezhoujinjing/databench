from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest

from databench_worker.runtime import subprocess as controlled


async def test_controlled_process_reports_heartbeats_and_bounded_failure_tail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(controlled, "HEARTBEAT_SECONDS", 0.01)
    heartbeats: asyncio.Queue[None] = asyncio.Queue()
    cancellation = asyncio.Event()
    result = await controlled.run_controlled_process(
        (
            sys.executable,
            "-I",
            "-c",
            "import sys,time; print('x'*70000); time.sleep(0.04); sys.exit(7)",
        ),
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin"},
        cancellation=cancellation,
        deadline_unix_ms=_now_ms() + 5_000,
        heartbeats=heartbeats,
    )
    assert result.status == "completed"
    assert result.returncode == 7
    assert 0 < heartbeats.qsize()
    assert len(result.log_tail) == controlled.LOG_TAIL_BYTES
    assert result.log_tail.endswith(b"\n")


async def test_controlled_process_enforces_deadline(tmp_path: Path) -> None:
    result = await controlled.run_controlled_process(
        (sys.executable, "-I", "-c", "import time; time.sleep(30)"),
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin"},
        cancellation=asyncio.Event(),
        deadline_unix_ms=_now_ms() + 50,
        heartbeats=asyncio.Queue(),
    )
    assert result.status == "deadline"
    assert result.returncode < 0


async def test_cancellation_terminates_the_process_group(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(controlled, "TERMINATE_GRACE_SECONDS", 1.0)
    parent_marker = tmp_path / "parent-stopped"
    child_marker = tmp_path / "child-stopped"
    child_ready = tmp_path / "child-ready"
    child_code = (
        "import signal,time,pathlib;"
        f"marker=pathlib.Path({str(child_marker)!r});"
        f"pathlib.Path({str(child_ready)!r}).write_text('ready');"
        "signal.signal(signal.SIGTERM,lambda *_:(marker.write_text('stopped'),exit(0)));"
        "time.sleep(30)"
    )
    parent_code = (
        "import signal,subprocess,sys,time,pathlib;"
        f"marker=pathlib.Path({str(parent_marker)!r});"
        "signal.signal(signal.SIGTERM,lambda *_:(marker.write_text('stopped'),exit(0)));"
        f"subprocess.Popen([sys.executable,'-I','-c',{child_code!r}]);"
        "time.sleep(30)"
    )
    cancellation = asyncio.Event()
    task = asyncio.create_task(
        controlled.run_controlled_process(
            (sys.executable, "-I", "-c", parent_code),
            cwd=tmp_path,
            env={"PATH": "/usr/bin:/bin"},
            cancellation=cancellation,
            deadline_unix_ms=_now_ms() + 5_000,
            heartbeats=asyncio.Queue(),
        )
    )
    for _ in range(200):
        if child_ready.exists():
            break
        await asyncio.sleep(0.01)
    assert child_ready.exists()
    cancellation.set()
    result = await task
    assert result.status == "cancelled"
    assert parent_marker.read_text() == "stopped"
    assert child_marker.read_text() == "stopped"


def _now_ms() -> int:
    return time.time_ns() // 1_000_000
