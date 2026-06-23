from __future__ import annotations

import json

import polars as pl
import pytest

import databench as db
from databench import ops


def _sft(user: str, assistant: str, source: str = "seed") -> db.SFTSample:
    return db.SFTSample(
        source=source,
        messages=[
            db.Message(role="user", content=user),
            db.Message(role="assistant", content=assistant),
        ],
    )


def _pref(prompt: str) -> db.PreferenceSample:
    return db.PreferenceSample(
        prompt=[db.Message(role="user", content=prompt)],
        chosen=db.Message(role="assistant", content="good"),
        rejected=db.Message(role="assistant", content="bad"),
    )


# -- schema / identity -------------------------------------------------------


def test_sample_id_is_content_addressed():
    a = _sft("hi", "hello", source="A")
    b = _sft("hi", "hello", source="B")  # same content, different provenance
    assert a.id == b.id  # source is excluded from identity


def test_enrichment_does_not_change_id():
    s = _sft("hi", "hello")
    before = s.id
    s.signals = {"quality": 0.9}
    assert s.id == before


def test_kinds_roundtrip():
    samples = [_sft("a", "b"), _pref("q")]
    ds = db.Dataset.from_samples(samples)
    back = list(ds.to_samples())
    assert {s.kind for s in back} == {"sft", "preference"}
    assert isinstance(back[0], db.SFTSample)


# -- dataset versioning ------------------------------------------------------


def test_version_is_order_independent():
    s1, s2 = _sft("a", "b"), _sft("c", "d")
    assert db.Dataset.from_samples([s1, s2]).version == db.Dataset.from_samples([s2, s1]).version


def test_enrichment_changes_version_not_identity():
    s = _sft("a", "b")
    base = db.Dataset.from_samples([s])
    s.signals = {"quality": 0.5}
    enriched = db.Dataset.from_samples([s])
    assert enriched.version != base.version
    assert list(enriched.to_samples())[0].id == list(base.to_samples())[0].id


# -- store / workspace -------------------------------------------------------


@pytest.fixture()
def ws(tmp_path):
    return db.Workspace.open(tmp_path / "bench")


def test_store_roundtrip(ws):
    ds = ws.add_samples([_sft("a", "b"), _sft("c", "d")], name="raw")
    loaded = ws.get("raw")
    assert loaded.version == ds.version
    assert len(loaded) == 2


def test_dedup(ws):
    raw = ws.add_samples([_sft("a", "b"), _sft("a", "b"), _sft("c", "d")], name="raw")
    clean = ws.run(ops.dedup, raw, ref="clean")
    assert len(raw) == 3
    assert len(clean) == 2


def test_transform_cache_hit(ws):
    raw = ws.add_samples([_sft("a", "b"), _sft("a", "b")], name="raw")
    first = ws.run(ops.dedup, raw)
    # Second run with identical inputs/params must reuse the cached output.
    n_runs_before = len(ws.catalog.runs_producing(first.version))
    second = ws.run(ops.dedup, raw)
    assert first.version == second.version
    assert len(ws.catalog.runs_producing(first.version)) == n_runs_before  # no new run row


def test_enrich_and_filter(ws):
    raw = ws.add_samples(
        [_sft("hi", "x"), _sft("a longer user turn here", "a much longer assistant answer here")],
        name="raw",
    )
    enriched = ws.run(ops.enrich_length, raw, ref="enriched")
    assert enriched.version != raw.version
    kept = ws.run(ops.filter_by_signal, enriched, key="word_len", min=5.0)
    assert len(kept) == 1


def test_lineage(ws):
    raw = ws.add_samples([_sft("a", "b"), _sft("a", "b")], name="raw")
    enriched = ws.run(ops.enrich_length, raw)
    clean = ws.run(ops.dedup, enriched, ref="clean")

    tree = ws.lineage("clean")
    assert tree["produced_by"]["op"] == "dedup"
    assert tree["inputs"][0]["produced_by"]["op"] == "enrich_length"
    assert tree["inputs"][0]["inputs"][0]["version"] == raw.version


# -- recipe / export ---------------------------------------------------------


def test_recipe_materialize_reproducible(ws):
    ws.add_samples([_sft(f"u{i}", f"a{i}") for i in range(10)], name="sft")
    ws.add_samples([_pref(f"q{i}") for i in range(10)], name="pref")

    recipe = db.Recipe(
        name="mix-v1",
        sources=[
            db.RecipeSource(dataset="sft", weight=3, max_samples=6),
            db.RecipeSource(dataset="pref", weight=1, max_samples=6),
        ],
        target_size=8,
        seed=42,
    )
    m1 = ws.materialize(recipe, ref="train")
    m2 = ws.materialize(recipe)
    assert m1.version == m2.version  # reproducible mixture

    lineage = ws.lineage("train")
    assert lineage["produced_by"]["op"] == "recipe:mix-v1"


def test_export_jsonl(ws, tmp_path):
    ws.add_samples([_sft("hi", "hello"), _pref("q")], name="raw")
    out = ws.export("raw", tmp_path / "train.jsonl")
    lines = [json.loads(l) for l in out.read_text().splitlines()]
    assert len(lines) == 2
    assert any("messages" in r for r in lines)
    assert any("chosen" in r for r in lines)
