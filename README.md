# databench

Infrastructure for managing **LLM post-training data** — versioned datasets,
automatic lineage, and reproducible training mixtures. The goal is to answer one
question reliably: *"what data did this checkpoint actually eat?"*

> Status: early. The M1 core (asset spine) is implemented; synthetic/annotation
> workflows (M2) and exploration UI (M3) are on the roadmap below.

## Design in one screen

databench is a **thin control plane over a content-addressed data plane**. It
borrows ideas, not implementations:

- **git / DVC / lakeFS** — everything is immutable and content-addressed; small
  versioned metadata is separated from large blobs.
- **dbt** — transforms are declarative and lineage is *derived automatically*
  from their inputs, not hand-annotated.
- **Lilac** — enrichment is non-destructive: transforms append to a sample's
  open `signals` dict without changing its identity.
- **TRL / Axolotl** — the data forms (messages / preference) follow training
  conventions, and a **recipe** (mixture) is a first-class, hashable artifact.

### Six first-class citizens

| Concept | What it is |
|---|---|
| `Sample` | Atomic unit. Discriminated union over `sft` / `preference` / `rl` / `trajectory`. `id` is a hash of content only. |
| `Dataset` | Immutable, content-addressed collection of samples (Polars/Arrow backed). |
| `Transform` | Pure `Dataset -> Dataset` function. Execution records a lineage edge automatically. |
| `Enrichment` | A transform that only adds `signals` — never changes row identity. |
| `Recipe` | Declarative, hashable mixture of dataset versions → the bridge to training. |
| `Lineage` | The DAG over datasets/transforms/recipes. Answers "what went in?". |

### Architecture

```
control plane (catalog)   SQLite  — datasets, runs (=lineage+cache), refs
        │ references by hash
data plane (store)        Parquet — content-addressed, write-once
engine                    Polars (lazy) + Arrow as the interchange boundary
```

Backends are pluggable: SQLite→Postgres, local Parquet→S3, single-node
Polars→Ray Data, all behind the same surface.

## Add your first dataset

JSONL is the first-class ingestion path. Kind is auto-detected per line, and the
common shorthand layouts (e.g. `chosen`/`rejected` as plain strings) are
normalised into the unified schema:

```python
ws = db.Workspace.open("./bench")
sft  = ws.add_jsonl("data/sft.jsonl",        name="sft-raw")   # {"messages": [...]}
pref = ws.add_jsonl("data/preference.jsonl", name="pref-raw")  # {"prompt","chosen","rejected"}
rl   = ws.add_jsonl("data/rl.jsonl",         name="rl-raw")    # {"prompt","rollouts":[...]}
```

A runnable end-to-end demo (ingest → enrich → dedup → lineage → recipe → export)
lives in [`examples/load_demo.py`](examples/load_demo.py) with sample data under
[`examples/demo/`](examples/demo):

```bash
uv run python examples/load_demo.py
```

## Quickstart

```python
import databench as db
from databench import ops

ws = db.Workspace.open("./bench")

raw = ws.add_samples([
    db.SFTSample(messages=[
        db.Message(role="user", content="hi"),
        db.Message(role="assistant", content="hello"),
    ]),
], name="raw")

enriched = ws.run(ops.enrich_length, raw)            # non-destructive signals
clean    = ws.run(ops.dedup, enriched, ref="clean")  # auto-cached + lineage

ws.lineage("clean")                                  # provenance DAG

recipe = db.Recipe(name="sft-v1", sources=[db.RecipeSource(dataset="clean")])
train = ws.materialize(recipe, ref="train")          # reproducible mixture
ws.export(train, "train.jsonl")                       # training-ready
```

## Development

```bash
uv venv && uv pip install -e ".[dev]"
uv run pytest
```

## Roadmap

- **M1 — asset spine (done):** schema, immutable versioned datasets, CAS store,
  catalog, `@transform` with automatic lineage + caching, recipes, export.
- **M2 — synthesis & annotation:** distilabel-backed synthetic transforms;
  Argilla-style "feedback as a data state" annotation loop.
- **M3 — exploration:** Lance backend + web UI for browse / slice / cluster.
