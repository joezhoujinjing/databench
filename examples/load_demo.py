"""Add your first demo dataset to databench, end to end.

Run it:

    uv run python examples/load_demo.py

It ingests the bundled JSONL demo data, enriches and dedups it, prints the
provenance DAG, then builds a reproducible training mixture and exports it.
"""

from __future__ import annotations

import json
from pathlib import Path

import databench as db
from databench import ops

DEMO = Path(__file__).parent / "demo"
WORKSPACE = Path(__file__).parent / ".bench-demo"


def main() -> None:
    ws = db.Workspace.open(WORKSPACE)

    # 1. Ingest each JSONL file as its own dataset (kind is auto-detected).
    sft = ws.add_jsonl(DEMO / "sft.jsonl", name="sft-raw")
    pref = ws.add_jsonl(DEMO / "preference.jsonl", name="pref-raw")
    rl = ws.add_jsonl(DEMO / "rl.jsonl", name="rl-raw")
    print(f"ingested: sft={len(sft)}  preference={len(pref)}  rl={len(rl)}")

    # 2. Enrich (non-destructive signals) then dedup the SFT set.
    enriched = ws.run(ops.enrich_length, sft)
    clean = ws.run(ops.dedup, enriched, ref="sft-clean")
    print(f"sft after enrich+dedup: {len(sft)} -> {len(clean)} rows")

    # 3. Provenance: what produced `sft-clean`?
    print("\nlineage of sft-clean:")
    print(json.dumps(ws.lineage("sft-clean"), indent=2, ensure_ascii=False))

    # 4. A reproducible training mixture across forms.
    recipe = db.Recipe(
        name="demo-mix-v1",
        sources=[
            db.RecipeSource(dataset="sft-clean", weight=2),
            db.RecipeSource(dataset="pref-raw", weight=1),
        ],
        target_size=6,
        seed=7,
    )
    train = ws.materialize(recipe, ref="train")
    print(f"\nmaterialized recipe '{recipe.name}': {len(train)} rows, version {train.version[:12]}")

    out = ws.export("train", WORKSPACE / "train.jsonl")
    print(f"exported training file -> {out}")


if __name__ == "__main__":
    main()
