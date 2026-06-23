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


def test_full_lifecycle(client):
    # 1. ingest SFT via JSON body
    r = client.post("/datasets", json={"name": "sft-raw", "samples": SFT_SAMPLES})
    assert r.status_code == 200, r.text
    sft = r.json()
    assert sft["num_rows"] == 3
    assert sft["kinds"] == {"sft": 3}

    # 2. ingest preference data via JSONL upload
    r = client.post(
        "/datasets:ingest-jsonl",
        params={"name": "pref-raw"},
        files={"file": ("preference.jsonl", io.BytesIO(PREF_JSONL), "application/x-ndjson")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["num_rows"] == 2

    # provenance defaults to the uploaded filename, not a temp path
    pref_items = client.get("/datasets/pref-raw/samples").json()["items"]
    assert all(s["source"] == "preference" for s in pref_items)

    # 3. inspect + paginate
    r = client.get("/datasets/sft-raw")
    assert r.status_code == 200
    assert r.json()["version"] == sft["version"]

    r = client.get("/datasets/sft-raw/samples", params={"limit": 2, "offset": 1})
    assert r.status_code == 200
    page = r.json()
    assert page["total"] == 3 and page["offset"] == 1 and len(page["items"]) == 2

    # 4. transforms: list, enrich, then dedup (chained on output version)
    names = {t["name"] for t in client.get("/transforms").json()}
    assert {"dedup", "enrich_length", "filter_by_signal", "sample_n"} <= names

    r = client.post("/transforms/enrich_length/run", json={"inputs": ["sft-raw"]})
    assert r.status_code == 200, r.text
    enriched_version = r.json()["version"]

    r = client.post(
        "/transforms/dedup/run",
        json={"inputs": [enriched_version], "ref": "sft-clean"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["num_rows"] == 2  # one duplicate dropped

    # 5. lineage of the cleaned set traces back through enrich -> raw
    lin = client.get("/lineage/sft-clean").json()
    assert lin["produced_by"]["op"] == "dedup"
    assert lin["inputs"][0]["produced_by"]["op"] == "enrich_length"

    # 6. refs
    refs = client.get("/refs").json()
    assert "sft-clean" in refs
    assert client.get("/refs/sft-clean").json()["version"] == refs["sft-clean"]

    # 7. materialize a mixture
    r = client.post(
        "/recipes:materialize",
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
    r = client.get("/datasets/train/export")
    assert r.status_code == 200
    lines = [l for l in r.text.splitlines() if l.strip()]
    assert len(lines) == 4


def test_error_mapping(client):
    # unknown dataset -> 404
    assert client.get("/datasets/does-not-exist").status_code == 404
    # unknown transform -> 404
    assert client.post("/transforms/nope/run", json={"inputs": ["x"]}).status_code == 404
    # bad sample payload -> 422
    assert client.post("/datasets", json={"samples": [{"kind": "sft"}]}).status_code == 422
    # unknown ref -> 404
    assert client.get("/refs/missing").status_code == 404


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173"])
def test_cors_allows_local_dev(client, origin):
    # CORS preflight
    r = client.options(
        "/datasets",
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


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example.com",
        # OSS HK is a shared multi-tenant domain: a random bucket there must NOT
        # be trusted by default — only the exact origin set via env is allowed.
        "https://someone-elses-bucket.oss-cn-hongkong.aliyuncs.com",
    ],
)
def test_cors_rejects_unconfigured_origin(client, origin):
    r = client.get("/health", headers={"Origin": origin})
    assert r.status_code == 200  # request itself succeeds...
    assert "access-control-allow-origin" not in r.headers  # ...but no CORS grant


def test_cors_env_override_allows_exact_origin(tmp_path, monkeypatch):
    # The production OSS bucket origin is whitelisted exactly, via env, not regex.
    prod = "https://databench-ui.oss-cn-hongkong.aliyuncs.com"
    monkeypatch.setenv("DATABENCH_CORS_ORIGINS", f"{prod}, https://app.databench.dev")
    ws = Workspace.open(tmp_path / "bench")
    app = create_app()
    app.dependency_overrides[get_workspace] = lambda: ws
    c = TestClient(app)

    r = c.get("/health", headers={"Origin": prod})
    assert r.headers["access-control-allow-origin"] == prod

    # a different bucket on the same shared domain is still rejected
    other = "https://attacker.oss-cn-hongkong.aliyuncs.com"
    r = c.get("/health", headers={"Origin": other})
    assert "access-control-allow-origin" not in r.headers
