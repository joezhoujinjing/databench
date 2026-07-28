"""PID 1 launcher for the Provider and the native Gradio process."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time

from .config import RuntimeConfig


def _environment(config: RuntimeConfig) -> dict[str, str]:
    env = dict(os.environ)
    session_label = env.get('DATABENCH_SWIFT_SESSION_LABEL', '').strip()
    env.update(
        {
            'DATABENCH_SWIFT_ROOT_PATH': config.root_path,
            'DATABENCH_SWIFT_WORKSPACE_ROOT': str(config.workspace_root),
            'GRADIO_ANALYTICS_ENABLED': 'False',
            'HF_HUB_DISABLE_TELEMETRY': '1',
            'HF_HOME': str(config.workspace_root / 'cache' / 'huggingface'),
            'MODELSCOPE_CACHE': str(config.workspace_root / 'cache' / 'modelscope'),
            'SWIFT_UI_LANG': env.get('SWIFT_UI_LANG', 'zh'),
            'DATABENCH_SWIFT_SESSION_LABEL': session_label or 'Databench Swift Studio',
            'WEBUI_PORT': str(config.gradio_port),
            'WEBUI_SERVER': config.gradio_host,
            'WEBUI_SHARE': 'false',
        }
    )
    return env


def _start(command: list[str], env: dict[str, str]) -> subprocess.Popen[bytes]:
    return subprocess.Popen(command, env=env, start_new_session=True)


def _terminate(process: subprocess.Popen[bytes], timeout: float = 20) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    process.wait(timeout=5)


def main() -> int:
    config = RuntimeConfig.from_env()
    config.prepare()
    env = _environment(config)
    provider = _start(
        [
            sys.executable,
            '-m',
            'uvicorn',
            'databench_swift_studio.app:create_app',
            '--factory',
            '--host',
            config.provider_host,
            '--port',
            str(config.provider_port),
            '--no-access-log',
        ],
        env,
    )
    gradio = _start([sys.executable, '-m', 'swift.cli.web_ui'], env)
    stopping = False

    def request_stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        while not stopping:
            provider_status = provider.poll()
            gradio_status = gradio.poll()
            if provider_status is not None or gradio_status is not None:
                return provider_status if provider_status is not None else (gradio_status or 0)
            time.sleep(0.25)
        return 0
    finally:
        _terminate(gradio)
        _terminate(provider)


if __name__ == '__main__':
    raise SystemExit(main())
