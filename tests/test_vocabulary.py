"""Tests for the Vocabulary concept: core type, label-driven ops, and endpoints.

The core type is dataset-agnostic: ``dimension`` is an open namespace label and
*how* to read labels out of a sample is an :class:`Extractor` passed at call
time. These fixtures mimic the ``material-sft`` shape - each SFT sample's
assistant turn is a JSON object ``{raw_brand, std_brand, raw_unit, std_unit,
params{}}`` - and the brand/unit extractors below name the keys to read.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import databench as db
from databench import Extractor, Term, Vocabulary
from databench.service.app import create_app
from databench.service.deps import get_workspace
from databench.vocabulary import normalize_samples, validate_samples

BRAND = Extractor(raw_key="raw_brand", std_key="std_brand")
UNIT = Extractor(raw_key="raw_unit", std_key="std_unit")


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
    # different name + status + per-term meta + reordered terms/aliases -> identical id
    b = Vocabulary(
        name="renamed",
        dimension="brand",
        status="draft",
        terms=[
            Term(canonical="特变电工", aliases=["TBEA"], meta={"count": 9}),
            Term(canonical="远东电缆", aliases=["远东"]),
        ],
    )
    assert a.id == b.id

    c = Vocabulary(dimension="unit", terms=a.terms)  # different dimension -> different id
    assert c.id != a.id


def test_dimension_is_an_open_namespace():
    # Any string is a valid dimension; nothing is enumerated in code.
    v = Vocabulary(dimension="material_category", terms=[Term(canonical="导线")])
    assert v.dimension == "material_category"
    assert v.id


def test_alias_conflict_invariant_raises():
    with pytest.raises(ValidationError):
        Vocabulary(
            dimension="brand",
            terms=[Term(canonical="A", aliases=["x"]), Term(canonical="B", aliases=["x"])],
        )


def test_duplicate_canonical_invariant_raises():
    with pytest.raises(ValidationError):
        Vocabulary(dimension="brand", terms=[Term(canonical="A"), Term(canonical="A")])


def test_alias_overlapping_a_canonical_raises():
    # A value that is any term's canonical may not be any term's alias.
    with pytest.raises(ValidationError):
        Vocabulary(
            dimension="unit",
            terms=[Term(canonical="个"), Term(canonical="包", aliases=["个"])],
        )


def test_status_defaults_to_curated_and_is_not_in_id():
    plain = Vocabulary(dimension="brand", terms=[Term(canonical="A")])
    assert plain.status == "curated"
    draft = Vocabulary(dimension="brand", status="draft", terms=[Term(canonical="A")])
    assert draft.id == plain.id  # status excluded from identity


def test_normalize_and_index():
    v = Vocabulary(dimension="brand", terms=[Term(canonical="远东电缆", aliases=["远东", "远东集团"])])
    assert v.alias_index() == {"远东": "远东电缆", "远东集团": "远东电缆"}
    assert v.normalize("远东") == "远东电缆"
    assert v.normalize("远东电缆") == "远东电缆"  # already canonical
    assert v.normalize("nope") is None


# -- derive ------------------------------------------------------------------


def test_derive_groups_std_and_collects_aliases():
    v = db.derive_vocabulary(FIXTURE, dimension="brand", extractor=BRAND, name="brand")
    by_canon = {t.canonical: t for t in v.terms}
    assert set(by_canon) == {"远东电缆", "特变电工", "亚星"}
    # raw != std becomes an alias; raw == std does not
    assert by_canon["远东电缆"].aliases == ["远东"]
    assert by_canon["远东电缆"].meta["count"] == 2
    assert by_canon["远东电缆"].meta["alias_counts"] == {"远东": 1}
    assert by_canon["特变电工"].aliases == ["TBEA"]
    assert by_canon["亚星"].aliases == ["YX亚星"]


def test_derive_marks_draft_and_records_extractor_provenance():
    v = db.derive_vocabulary(FIXTURE, dimension="brand", extractor=BRAND)
    assert v.status == "draft"
    assert v.meta["derived"] is True
    assert v.meta["extractor"] == {"source": "assistant_json", "raw_key": "raw_brand", "std_key": "std_brand"}
    # the recorded extractor round-trips and is replayable
    assert v.extractor() == BRAND


def test_derive_accepts_a_plain_callable_extractor():
    def reader(sample):
        obj = json.loads(sample.messages[-1].content)
        return obj.get("raw_brand"), obj.get("std_brand")

    v = db.derive_vocabulary(FIXTURE, dimension="brand", extractor=reader)
    assert {t.canonical for t in v.terms} == {"远东电缆", "特变电工", "亚星"}
    assert "extractor" not in v.meta  # a bare callable cannot be serialized as provenance


def test_derive_unit_dimension():
    samples = [_sft("X", "X", raw_unit="m", std_unit="米"), _sft("X", "X", raw_unit="米", std_unit="米")]
    v = db.derive_vocabulary(samples, dimension="unit", extractor=UNIT)
    assert {t.canonical for t in v.terms} == {"米"}
    assert v.terms[0].aliases == ["m"]


def test_derive_resolves_alias_labelled_to_two_canonicals():
    # Real noise: the same raw form is labelled against two different standards.
    # Derive must still emit a valid vocab (majority wins, conflict recorded).
    samples = [_sft("中超控股", "中超"), _sft("中超控股", "中超"), _sft("中超控股", "江苏中超控股")]
    v = db.derive_vocabulary(samples, dimension="brand", extractor=BRAND)
    assert v.normalize("中超控股") == "中超"  # majority (2 vs 1) wins, deterministically

    by_canon = {t.canonical: t for t in v.terms}
    assert "中超控股" not in by_canon["江苏中超控股"].aliases  # never added to the loser
    conflict = by_canon["中超"].meta["alias_conflicts"]["中超控股"]
    assert conflict["chosen"] == "中超"
    assert conflict["also_seen"] == ["江苏中超控股"]
    assert conflict["counts"] == {"中超": 2, "江苏中超控股": 1}


def test_derive_raw_that_is_also_a_canonical_stays_canonical():
    # '个' is its own canonical (count 1) yet one row labels raw '个' -> std '包'.
    # '个' must remain a canonical and never become an alias of '包'.
    samples = [
        _sft("X", "X", raw_unit="个", std_unit="个"),
        _sft("X", "X", raw_unit="个", std_unit="包"),
        _sft("X", "X", raw_unit="只", std_unit="包"),
    ]
    v = db.derive_vocabulary(samples, dimension="unit", extractor=UNIT)
    assert "个" in v.canonical_set()
    assert v.alias_index().get("个") is None  # not an alias of anything
    assert v.normalize("个") == "个"

    by_canon = {t.canonical: t for t in v.terms}
    assert "个" not in by_canon["包"].aliases
    assert "只" in by_canon["包"].aliases  # a genuine alias still maps
    conflict = by_canon["个"].meta["alias_conflicts"]["个"]
    assert conflict["chosen"] == "个"
    assert conflict["also_seen"] == ["包"]


def test_derive_never_raises_on_dense_conflicts():
    # A pile of contradictory labels must not raise: derive always returns a vocab.
    samples = []
    for std in ("A", "B", "C"):
        for _ in range(3):
            samples.append(_sft("messy", std))
    v = db.derive_vocabulary(samples, dimension="brand", extractor=BRAND)
    assert v.id  # constructed successfully (invariant satisfied)
    assert sum(1 for t in v.terms if "messy" in t.aliases) == 1  # exactly one owner


# -- normalize ---------------------------------------------------------------


def test_normalize_rewrites_std_from_raw():
    # std is stale ("远东"); the vocab maps raw "远东" -> canonical "远东电缆"
    sample = _sft("远东", "远东")
    vocab = Vocabulary(dimension="brand", terms=[Term(canonical="远东电缆", aliases=["远东"])])
    (out,) = normalize_samples([sample], vocab, BRAND)
    payload = json.loads(out.messages[-1].content)
    assert payload["std_brand"] == "远东电缆"


def test_normalize_leaves_unmapped_unchanged():
    sample = _sft("未知品牌", "未知品牌")
    vocab = Vocabulary(dimension="brand", terms=[Term(canonical="远东电缆", aliases=["远东"])])
    (out,) = normalize_samples([sample], vocab, BRAND)
    assert out is sample  # untouched, identity preserved
    assert json.loads(out.messages[-1].content)["std_brand"] == "未知品牌"


# -- validate ----------------------------------------------------------------


def test_validate_signal_is_non_destructive():
    good = _sft("远东", "远东电缆")
    bad = _sft("怪牌", "怪牌")
    bad.signals = {"existing": 123}  # must survive enrichment
    vocab = Vocabulary(dimension="brand", terms=[Term(canonical="远东电缆", aliases=["远东"])])

    out, summary = validate_samples([good, bad], vocab, BRAND)
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
    vocab = ws.derive_vocabulary("raw", dimension="brand", extractor=BRAND, name="brand")
    runs = ws.catalog.runs_producing(vocab.id)
    assert runs and runs[0]["op"] == "vocabulary:derive"
    assert runs[0]["inputs"] == [raw.version]


def test_curation_is_a_new_version_with_lineage(ws):
    draft = ws.derive_vocabulary("raw", dimension="brand", extractor=BRAND, name="brand")
    assert draft.status == "draft"
    curated = draft.model_copy(update={"terms": draft.terms + [Term(canonical="新牌")]})
    saved = ws.save_vocabulary(curated)

    assert saved.id != draft.id  # content changed -> new version
    assert saved.status == "curated"  # saving promotes out of draft
    assert ws.get_vocabulary("brand").id == saved.id  # ref now points at curated
    runs = ws.catalog.runs_producing(saved.id)
    assert runs and runs[0]["op"] == "vocabulary:curate"
    assert runs[0]["inputs"] == [draft.id]


def test_normalize_lineage_chains_through_vocab(ws):
    # No extractor passed: normalize replays the one the derived vocab recorded.
    vocab = ws.derive_vocabulary("raw", dimension="brand", extractor=BRAND, name="brand")
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
    # No body: the server preset for dimension "brand" supplies the extractor.
    r = client.post("/v1/vocabularies/brand:derive", params={"dataset": "raw", "dimension": "brand"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dimension"] == "brand"
    assert body["status"] == "draft"
    assert body["id"]
    assert {t["canonical"] for t in body["terms"]} == {"远东电缆", "特变电工", "亚星"}

    r = client.get("/v1/vocabularies/brand")
    assert r.status_code == 200
    assert r.json()["id"] == body["id"]

    page = client.get("/v1/vocabularies").json()
    assert page["total"] == 1
    assert page["items"][0]["name"] == "brand"
    assert page["items"][0]["num_terms"] == 3


def test_endpoint_derive_with_explicit_extractor_body(client):
    # An unknown dimension has no preset, so the request supplies the extractor.
    r = client.post(
        "/v1/vocabularies/myunit:derive",
        params={"dataset": "raw", "dimension": "myunit"},
        json={"source": "assistant_json", "raw_key": "raw_unit", "std_key": "std_unit"},
    )
    assert r.status_code == 200, r.text
    assert {t["canonical"] for t in r.json()["terms"]} == {"米"}


def test_endpoint_derive_unknown_dimension_without_extractor_400(client):
    r = client.post("/v1/vocabularies/mystery:derive", params={"dataset": "raw", "dimension": "mystery"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "bad_request"


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
    assert new["status"] == "curated"
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
