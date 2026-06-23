"""Tests for the Vocabulary concept: core type, label-driven ops, and endpoints.

Fixtures mimic the ``material-sft`` shape: each SFT sample's assistant turn is a
JSON object ``{raw_brand, std_brand, raw_unit, std_unit, params{}}``.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import databench as db
from databench import Term, Vocabulary
from databench.service.app import create_app
from databench.service.deps import get_workspace
from databench.vocabulary import normalize_samples, validate_samples


def _sft(raw_brand: str, std_brand: str, raw_unit: str = "m", std_unit: str = "米") -> db.SFTSample:
    payload = {
        "raw_brand": raw_brand,
        "std_brand": std_brand,
        "raw_unit": raw_unit,
        "std_unit": std_unit,
        "params": {},
    }
    return db.SFTSample(
        messages=[
            db.Message(role="user", content="normalize this"),
            db.Message(role="assistant", content=json.dumps(payload, ensure_ascii=False)),
        ]
    )


FIXTURE = [
    _sft("远东", "远东电缆"),
    _sft("远东电缆", "远东电缆"),
    _sft("TBEA", "特变电工"),
    _sft("特变电工", "特变电工"),
    _sft("YX亚星", "亚星"),
]


# -- identity / invariants ---------------------------------------------------


def test_id_is_content_addressed_and_order_independent():
    a = Vocabulary(
        dimension="brand",
        terms=[Term(canonical="远东电缆", aliases=["远东"]), Term(canonical="特变电工", aliases=["TBEA"])],
    )
    # different name + per-term meta + reordered terms/aliases -> identical id
    b = Vocabulary(
        name="renamed",
        dimension="brand",
        terms=[
            Term(canonical="特变电工", aliases=["TBEA"], meta={"count": 9}),
            Term(canonical="远东电缆", aliases=["远东"]),
        ],
    )
    assert a.id == b.id

    c = Vocabulary(dimension="unit", terms=a.terms)  # different dimension -> different id
    assert c.id != a.id


def test_alias_conflict_invariant_raises():
    with pytest.raises(ValidationError):
        Vocabulary(
            dimension="brand",
            terms=[Term(canonical="A", aliases=["x"]), Term(canonical="B", aliases=["x"])],
        )


def test_duplicate_canonical_invariant_raises():
    with pytest.raises(ValidationError):
        Vocabulary(dimension="brand", terms=[Term(canonical="A"), Term(canonical="A")])


def test_normalize_and_index():
    v = Vocabulary(dimension="brand", terms=[Term(canonical="远东电缆", aliases=["远东", "远东集团"])])
    assert v.alias_index() == {"远东": "远东电缆", "远东集团": "远东电缆"}
    assert v.normalize("远东") == "远东电缆"
    assert v.normalize("远东电缆") == "远东电缆"  # already canonical
    assert v.normalize("nope") is None


# -- derive ------------------------------------------------------------------


def test_derive_groups_std_and_collects_aliases():
    v = db.derive_vocabulary(FIXTURE, dimension="brand", name="brand")
    by_canon = {t.canonical: t for t in v.terms}
    assert set(by_canon) == {"远东电缆", "特变电工", "亚星"}
    # raw != std becomes an alias; raw == std does not
    assert by_canon["远东电缆"].aliases == ["远东"]
    assert by_canon["远东电缆"].meta["count"] == 2
    assert by_canon["远东电缆"].meta["alias_counts"] == {"远东": 1}
    assert by_canon["特变电工"].aliases == ["TBEA"]
    assert by_canon["亚星"].aliases == ["YX亚星"]


def test_derive_unit_dimension():
    samples = [_sft("X", "X", raw_unit="m", std_unit="米"), _sft("X", "X", raw_unit="米", std_unit="米")]
    v = db.derive_vocabulary(samples, dimension="unit")
    assert {t.canonical for t in v.terms} == {"米"}
    assert v.terms[0].aliases == ["m"]


# -- normalize ---------------------------------------------------------------


def test_normalize_rewrites_std_from_raw():
    # std is stale ("远东"); the vocab maps raw "远东" -> canonical "远东电缆"
    sample = _sft("远东", "远东")
    vocab = Vocabulary(dimension="brand", terms=[Term(canonical="远东电缆", aliases=["远东"])])
    (out,) = normalize_samples([sample], vocab)
    payload = json.loads(out.messages[-1].content)
    assert payload["std_brand"] == "远东电缆"


def test_normalize_leaves_unmapped_unchanged():
    sample = _sft("未知品牌", "未知品牌")
    vocab = Vocabulary(dimension="brand", terms=[Term(canonical="远东电缆", aliases=["远东"])])
    (out,) = normalize_samples([sample], vocab)
    assert out is sample  # untouched, identity preserved
    assert json.loads(out.messages[-1].content)["std_brand"] == "未知品牌"


# -- validate ----------------------------------------------------------------


def test_validate_signal_is_non_destructive():
    good = _sft("远东", "远东电缆")
    bad = _sft("怪牌", "怪牌")
    bad.signals = {"existing": 123}  # must survive enrichment
    vocab = Vocabulary(dimension="brand", terms=[Term(canonical="远东电缆", aliases=["远东"])])

    out, summary = validate_samples([good, bad], vocab)
    g, b = out
    assert g.signals["vocab_brand_valid"] is True
    assert b.signals["vocab_brand_valid"] is False
    assert b.signals["existing"] == 123  # not overwritten
    assert summary == {"checked": 2, "invalid": 1, "offending_values": {"怪牌": 1}}


# -- workspace lineage / curation -------------------------------------------


@pytest.fixture()
def ws(tmp_path):
    w = db.Workspace.open(tmp_path / "bench")
    w.add_samples(FIXTURE, name="raw")
    return w


def test_derive_records_lineage_to_source(ws):
    raw = ws.get("raw")
    vocab = ws.derive_vocabulary("raw", dimension="brand", name="brand")
    runs = ws.catalog.runs_producing(vocab.id)
    assert runs and runs[0]["op"] == "vocabulary:derive"
    assert runs[0]["inputs"] == [raw.version]


def test_curation_is_a_new_version_with_lineage(ws):
    draft = ws.derive_vocabulary("raw", dimension="brand", name="brand")
    curated = draft.model_copy(update={"terms": draft.terms + [Term(canonical="新牌")]})
    saved = ws.save_vocabulary(curated)

    assert saved.id != draft.id  # content changed -> new version
    assert ws.get_vocabulary("brand").id == saved.id  # ref now points at curated
    runs = ws.catalog.runs_producing(saved.id)
    assert runs and runs[0]["op"] == "vocabulary:curate"
    assert runs[0]["inputs"] == [draft.id]


def test_normalize_lineage_chains_through_vocab(ws):
    vocab = ws.derive_vocabulary("raw", dimension="brand", name="brand")
    ws.normalize_vocabulary("raw", vocab, ref="norm")
    lin = ws.lineage("norm")
    assert lin["produced_by"]["op"] == "vocabulary:normalize"
    # the vocab id is one of the inputs, and it traces back to its derive run
    vocab_nodes = [n for n in lin["inputs"] if n.get("produced_by", {}).get("op") == "vocabulary:derive"]
    assert vocab_nodes


# -- endpoints ---------------------------------------------------------------


@pytest.fixture()
def client(tmp_path):
    w = db.Workspace.open(tmp_path / "bench")
    w.add_samples(FIXTURE, name="raw")
    app = create_app()
    app.dependency_overrides[get_workspace] = lambda: w
    return TestClient(app)


def test_endpoint_derive_get_list(client):
    r = client.post("/v1/vocabularies/brand:derive", params={"dataset": "raw", "dimension": "brand"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dimension"] == "brand"
    assert body["id"]
    assert {t["canonical"] for t in body["terms"]} == {"远东电缆", "特变电工", "亚星"}

    r = client.get("/v1/vocabularies/brand")
    assert r.status_code == 200
    assert r.json()["id"] == body["id"]

    page = client.get("/v1/vocabularies").json()
    assert page["total"] == 1
    assert page["items"][0]["name"] == "brand"
    assert page["items"][0]["num_terms"] == 3


def test_endpoint_put_curated_version(client):
    derived = client.post(
        "/v1/vocabularies/brand:derive", params={"dataset": "raw", "dimension": "brand"}
    ).json()

    curated = dict(derived)
    curated["terms"] = derived["terms"] + [{"canonical": "新牌", "aliases": []}]
    r = client.put("/v1/vocabularies/brand", json=curated)
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["id"] != derived["id"]
    assert client.get("/v1/vocabularies/brand").json()["id"] == new["id"]


def test_endpoint_missing_vocabulary_404_envelope(client):
    r = client.get("/v1/vocabularies/does-not-exist")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_endpoint_alias_conflict_is_enveloped(client):
    bad = {"dimension": "brand", "terms": [
        {"canonical": "A", "aliases": ["x"]},
        {"canonical": "B", "aliases": ["x"]},
    ]}
    r = client.put("/v1/vocabularies/bad", json=bad)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
