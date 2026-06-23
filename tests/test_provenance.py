from __future__ import annotations

import databench as db
from databench import ops, transform
from databench.provenance import code_version, git_sha


# -- code_version ------------------------------------------------------------


def test_code_version_is_stable_and_sensitive():
    def a(ds):
        return ds

    def b(ds):
        x = 1  # noqa: F841 - different body on purpose
        return ds

    assert code_version(a) == code_version(a)  # stable
    assert code_version(a) != code_version(b)  # sensitive to body
    assert code_version(a).startswith("code:")


def test_transform_auto_version():
    @transform()
    def my_op(ds):
        return ds

    assert my_op.version is None
    assert my_op.effective_version == my_op.code_version
    assert my_op.effective_version.startswith("code:")


def test_transform_manual_override():
    @transform(version="pinned-7")
    def my_op(ds):
        return ds

    assert my_op.effective_version == "pinned-7"


def test_builtin_ops_use_code_hash():
    assert ops.dedup.effective_version.startswith("code:")
    assert ops.dedup.effective_version != ops.enrich_length.effective_version


# -- git_sha (best-effort, never raises) -------------------------------------


def test_git_sha_outside_repo_is_none(tmp_path):
    assert git_sha(str(tmp_path)) is None


def test_git_sha_returns_str_or_none():
    val = git_sha()  # cwd is the databench repo during tests
    assert val is None or isinstance(val, str)


# -- lineage records op_version + code_ref -----------------------------------


def test_lineage_records_code_version(tmp_path):
    ws = db.Workspace.open(tmp_path / "bench")
    raw = ws.add_samples(
        [db.SFTSample(messages=[db.Message(role="user", content="hi")])], name="raw"
    )
    ws.run(ops.enrich_length, raw, ref="enriched")

    node = ws.lineage("enriched")
    produced = node["produced_by"]
    assert produced["op"] == "enrich_length"
    assert produced["op_version"].startswith("code:")
    assert "code_ref" in produced  # present (value may be a sha or None)
