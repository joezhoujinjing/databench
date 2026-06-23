from __future__ import annotations

from pathlib import Path

import pytest

import databench as db
from databench import detect_kind, read_jsonl, record_to_sample

DEMO = Path(__file__).resolve().parents[1] / "examples" / "demo"


# -- kind detection ----------------------------------------------------------


def test_detect_kind():
    assert detect_kind({"messages": [{"role": "user", "content": "hi"}]}) == "sft"
    assert detect_kind({"prompt": "q", "chosen": "a", "rejected": "b"}) == "preference"
    assert detect_kind({"prompt": "q", "rollouts": [{"text": "x", "reward": 1.0}]}) == "rl"
    assert detect_kind(
        {"messages": [{"role": "assistant", "tool_calls": [{"name": "search"}]}]}
    ) == "trajectory"
    with pytest.raises(ValueError):
        detect_kind({"foo": "bar"})


# -- shorthand normalization -------------------------------------------------


def test_preference_string_shorthand():
    s = record_to_sample({"prompt": "q", "chosen": "good", "rejected": "bad"})
    assert isinstance(s, db.PreferenceSample)
    assert s.prompt[0].role == "user" and s.prompt[0].content == "q"
    assert s.chosen.role == "assistant" and s.chosen.content == "good"


def test_rl_record():
    s = record_to_sample({"prompt": "2+2?", "answer": "4", "rollouts": [{"text": "4", "reward": 1.0}]})
    assert isinstance(s, db.RLSample)
    assert s.answer == "4"
    assert s.rollouts[0].reward == 1.0


def test_source_tagging():
    s = record_to_sample({"messages": [{"role": "user", "content": "hi"}]}, source="seed")
    assert s.source == "seed"


# -- jsonl ingestion ---------------------------------------------------------


def test_read_demo_jsonl():
    sft = list(read_jsonl(DEMO / "sft.jsonl"))
    assert len(sft) == 5
    assert all(s.kind == "sft" for s in sft)

    pref = list(read_jsonl(DEMO / "preference.jsonl"))
    assert len(pref) == 3
    assert all(s.kind == "preference" for s in pref)


def test_add_jsonl_into_workspace(tmp_path):
    ws = db.Workspace.open(tmp_path / "bench")
    ds = ws.add_jsonl(DEMO / "sft.jsonl", name="sft")
    assert len(ds) == 5
    assert ws.get("sft").version == ds.version
    # the duplicate row collapses once we dedup
    from databench import ops

    clean = ws.run(ops.dedup, ds)
    assert len(clean) == 4
