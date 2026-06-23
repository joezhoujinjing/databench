"""End-to-end tests for the FastAPI service.

Drives the full data lifecycle through HTTP: ingest (JSON + JSONL upload) ->
transform -> lineage -> materialize -> export, plus the error-mapping contract.
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from databench import Workspace
from databench.service.app import create_app
from databench.service.deps import get_workspace

SFT_SAMPLES = [
    {
        "kind": "sft",
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello there"},
        ],
    },
    {
        "kind": "sft",
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello there"},
        ],
    },  # exact duplicate -> exercises dedup
    {
        "kind": "sft",
        "messages": [
            {"role": "user", "content": "what is 2+2"},
            {"role": "assistant", "content": "4"},
        ],
    },
]

PREF_JSONL = (
    b'{"prompt": "q1", "chosen": "good", "rejected": "bad"}\n'
    b'{"prompt": "q2", "chosen": "yes", "rejected": "no"}\n'
)


@pytest.fixture
def client(tmp_path):
    ws = Workspace.open(tmp_path / "bench")
    app = create_app()
    app.dependency_overrides[get_workspace] = lambda: ws
    return TestClient(app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_version_handshake(client):
    # Unversioned, at root. The frontend pins these on connect.
    r = client.get("/version")
    assert r.status_code == 200
    body = r.json()
    assert body["api_version"] == "v1"
    assert set(body) == {"api_version", "service_version", "schema_version"}
    assert body["service_version"]  # from databench.__version__


def test_capabilities_handshake(client):
    r = client.get("/capabilities")
    assert r.status_code == 200
    body = r.json()
    assert body["api_version"] == "v1"
    assert body["min_client"]
    features = body["features"]
    # Wired-up modules feature-detect to True for this deployment...
    assert features["transforms"] is True
    assert features["recipes"] is True
    assert features["lineage"] is True
    assert features["vocabularies"] is True
    # ...while modules this deployment does not ship stay False (not hardcoded).
    assert features["synthesis"] is False
    assert features["annotation"] is False


def test_full_lifecycle(client):
    # 1. ingest SFT via JSON body
    r = client.post("/v1/datasets", json={"name": "sft-raw", "samples": SFT_SAMPLES})
    assert r.status_code == 200, r.text
    sft = r.json()
    assert sft["num_rows"] == 3
    assert sft["kinds"] == {"sft": 3}

    # 2. ingest preference data via JSONL upload
    r = client.post(
        "/v1/datasets:ingest-jsonl",
        params={"name": "pref-raw"},
        files={"file": ("preference.jsonl", io.BytesIO(PREF_JSONL), "application/x-ndjson")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["num_rows"] == 2

    # provenance defaults to the uploaded filename, not a temp path
    pref_items = client.get("/v1/datasets/pref-raw/samples").json()["items"]
    assert all(s["source"] == "preference" for s in pref_items)

    # 3. inspect + paginate
    r = client.get("/v1/datasets/sft-raw")
    assert r.status_code == 200
    assert r.json()["version"] == sft["version"]

    r = client.get("/v1/datasets/sft-raw/samples", params={"limit": 2, "offset": 1})
    assert r.status_code == 200
    page = r.json()
    assert page["total"] == 3 and page["offset"] == 1 and len(page["items"]) == 2

    # 4. transforms: list (paginated), enrich, then dedup (chained on output version)
    names = {t["name"] for t in client.get("/v1/transforms").json()["items"]}
    assert {"dedup", "enrich_length", "filter_by_signal", "sample_n"} <= names

    r = client.post("/v1/transforms/enrich_length/run", json={"inputs": ["sft-raw"]})
    assert r.status_code == 200, r.text
    enriched_version = r.json()["version"]

    r = client.post(
        "/v1/transforms/dedup/run",
        json={"inputs": [enriched_version], "ref": "sft-clean"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["num_rows"] == 2  # one duplicate dropped

    # 5. lineage of the cleaned set traces back through enrich -> raw
    lin = client.get("/v1/lineage/sft-clean").json()
    assert lin["produced_by"]["op"] == "dedup"
    assert lin["inputs"][0]["produced_by"]["op"] == "enrich_length"

    # 6. refs (paginated list of {name, version})
    refs = {r["name"]: r["version"] for r in client.get("/v1/refs").json()["items"]}
    assert "sft-clean" in refs
    assert client.get("/v1/refs/sft-clean").json()["version"] == refs["sft-clean"]

    # 7. materialize a mixture
    r = client.post(
        "/v1/recipes:materialize",
        json={
            "recipe": {
                "name": "demo-mix",
                "sources": [
                    {"dataset": "sft-clean", "weight": 2},
                    {"dataset": "pref-raw", "weight": 1},
                ],
            },
            "ref": "train",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["num_rows"] == 4

    # 8. export streams JSONL
    r = client.get("/v1/datasets/train/export")
    assert r.status_code == 200
    lines = [l for l in r.text.splitlines() if l.strip()]
    assert len(lines) == 4


def test_error_envelope(client):
    # Every error shares one shape: {error: {code, message, detail?}}.
    r = client.get("/v1/datasets/does-not-exist")
    assert r.status_code == 404
    err = r.json()["error"]
    assert err["code"] == "not_found"
    assert "message" in err

    # unknown transform -> 404 via HTTPException, still enveloped
    r = client.post("/v1/transforms/nope/run", json={"inputs": ["x"]})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"

    # bad sample payload -> 422 with structured detail
    r = client.post("/v1/datasets", json={"samples": [{"kind": "sft"}]})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "validation_error"
    assert isinstance(err["detail"], list)

    # unknown ref -> 404
    r = client.get("/v1/refs/missing")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_pagination_cap_enforced(client):
    client.post("/v1/datasets", json={"name": "sft-raw", "samples": SFT_SAMPLES})
    # A client cannot request more than the hard server-side cap (500).
    r = client.get("/v1/datasets/sft-raw/samples", params={"limit": 5000})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"

    # The cap itself is accepted.
    r = client.get("/v1/datasets/sft-raw/samples", params={"limit": 500})
    assert r.status_code == 200
    assert r.json()["limit"] == 500


def test_legacy_unversioned_paths_removed(client):
    # The /v1 cutover is clean: old unprefixed domain routes no longer exist.
    assert client.post("/datasets", json={"name": "x", "samples": SFT_SAMPLES}).status_code == 404
    assert client.get("/refs").status_code == 404


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173"])
def test_cors_allows_local_dev(client, origin):
    # CORS preflight
    r = client.options(
        "/v1/datasets",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == origin

    # actual request also echoes the allowed origin
    r = client.get("/health", headers={"Origin": origin})
    assert r.headers["access-control-allow-origin"] == origin


PROD_ORIGIN = "https://databench.jinjing.me"


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example.com",
        # not the configured prod origin -> must not be trusted by default
        "https://databench.jinjing.me.attacker.com",
    ],
)
def test_cors_rejects_unconfigured_origin(client, origin):
    r = client.get("/health", headers={"Origin": origin})
    assert r.status_code == 200  # request itself succeeds...
    assert "access-control-allow-origin" not in r.headers  # ...but no CORS grant


def _client_with_prod_origin(tmp_path) -> TestClient:
    ws = Workspace.open(tmp_path / "bench")
    app = create_app()
    app.dependency_overrides[get_workspace] = lambda: ws
    return TestClient(app)


def test_cors_env_override_allows_exact_origin(tmp_path, monkeypatch):
    # The production origin is whitelisted exactly, via env, not regex.
    monkeypatch.setenv("DATABENCH_CORS_ORIGINS", f"{PROD_ORIGIN}, https://app.databench.dev")
    c = _client_with_prod_origin(tmp_path)

    r = c.get("/health", headers={"Origin": PROD_ORIGIN})
    assert r.headers["access-control-allow-origin"] == PROD_ORIGIN

    # a look-alike origin is still rejected (exact match, not prefix/suffix)
    r = c.get("/health", headers={"Origin": "https://databench.jinjing.me.evil.com"})
    assert "access-control-allow-origin" not in r.headers


def test_pna_preflight_sets_allow_private_network(tmp_path, monkeypatch):
    # Chrome's Private Network Access preflight: a public HTTPS page hitting a
    # loopback backend must get Access-Control-Allow-Private-Network: true, plus
    # the usual exact-origin echo.
    monkeypatch.setenv("DATABENCH_CORS_ORIGINS", PROD_ORIGIN)
    c = _client_with_prod_origin(tmp_path)

    r = c.options(
        "/v1/refs",
        headers={
            "Origin": PROD_ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == PROD_ORIGIN
    assert r.headers["access-control-allow-private-network"] == "true"


def test_pna_header_absent_without_request(tmp_path, monkeypatch):
    # A normal preflight (no PNA request header) must NOT advertise PNA.
    monkeypatch.setenv("DATABENCH_CORS_ORIGINS", PROD_ORIGIN)
    c = _client_with_prod_origin(tmp_path)

    r = c.options(
        "/v1/refs",
        headers={"Origin": PROD_ORIGIN, "Access-Control-Request-Method": "GET"},
    )
    assert r.status_code == 200
    assert "access-control-allow-private-network" not in r.headers
