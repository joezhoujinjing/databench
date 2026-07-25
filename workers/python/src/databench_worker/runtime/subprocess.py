from __future__ import annotations

import asyncio
import os
import signal
import time
from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from ..registry import Cancellation


LOG_TAIL_BYTES = 64 * 1024
HEARTBEAT_SECONDS = 2.0
TERMINATE_GRACE_SECONDS = 5.0


@dataclass(frozen=True)
class ControlledProcessResult:
    status: str
    returncode: int
    log_tail: bytes


async def run_controlled_process(
    command: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    cancellation: Cancellation,
    deadline_unix_ms: int,
    heartbeats: asyncio.Queue[None],
) -> ControlledProcessResult:
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=cwd,
        env=dict(env),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    output_task = asyncio.create_task(_read_bounded_tail(process.stdout))
    cancel_task = asyncio.create_task(cancellation.wait())
    wait_task = asyncio.create_task(process.wait())
    status = "completed"
    try:
        while not wait_task.done():
            remaining = (deadline_unix_ms - _now_ms()) / 1000
            if remaining <= 0:
                status = "deadline"
                await _terminate_process_group(process)
                break
            done, _ = await asyncio.wait(
                (wait_task, cancel_task),
                timeout=min(HEARTBEAT_SECONDS, remaining),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if wait_task in done:
                break
            if cancel_task in done:
                status = "cancelled"
                await _terminate_process_group(process)
                break
            heartbeats.put_nowait(None)
        returncode = await wait_task
        return ControlledProcessResult(
            status=status,
            returncode=returncode,
            log_tail=await output_task,
        )
    finally:
        cancel_task.cancel()
        await asyncio.gather(cancel_task, return_exceptions=True)
        if process.returncode is None:
            await _terminate_process_group(process)
        if not output_task.done():
            output_task.cancel()
            await asyncio.gather(output_task, return_exceptions=True)


async def _terminate_process_group(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=TERMINATE_GRACE_SECONDS)
        return
    except TimeoutError:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    await process.wait()


async def _read_bounded_tail(stream: asyncio.StreamReader | None) -> bytes:
    if stream is None:
        return b""
    chunks: deque[bytes] = deque()
    size = 0
    while True:
        chunk = await stream.read(8192)
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        while size > LOG_TAIL_BYTES and chunks:
            overflow = size - LOG_TAIL_BYTES
            first = chunks[0]
            if len(first) <= overflow:
                chunks.popleft()
                size -= len(first)
            else:
                chunks[0] = first[overflow:]
                size -= overflow
    return b"".join(chunks)


def _now_ms() -> int:
    return time.time_ns() // 1_000_000
