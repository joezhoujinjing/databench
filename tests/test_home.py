from __future__ import annotations

from pathlib import Path

import databench as db
from databench.config import DEFAULT_HOME, ENV_HOME, resolve_root


def test_explicit_root_wins(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path / "from-env"))
    assert resolve_root(tmp_path / "explicit") == (tmp_path / "explicit").resolve()


def test_env_home_used_when_no_arg(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path / "hub"))
    assert resolve_root() == (tmp_path / "hub").resolve()


def test_default_home_when_unset(tmp_path, monkeypatch):
    monkeypatch.delenv(ENV_HOME, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))  # expanduser reads $HOME
    assert resolve_root() == (tmp_path / ".databench").resolve()


def test_expands_user_and_vars(tmp_path, monkeypatch):
    monkeypatch.setenv("MYDATA", str(tmp_path))
    assert resolve_root("$MYDATA/db") == (tmp_path / "db").resolve()


def test_open_no_arg_uses_env_hub(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path / "hub"))
    ws = db.Workspace.open()
    ws.add_samples(
        [db.SFTSample(messages=[db.Message(role="user", content="hi")])], name="raw"
    )
    assert (tmp_path / "hub" / "catalog.db").exists()
    assert (tmp_path / "hub" / "store").is_dir()
    assert ws.get("raw") is not None


def test_default_home_constant():
    assert DEFAULT_HOME == "~/.databench"
