#!/usr/bin/env python
"""Regenerate the committed OpenAPI artifact from the FastAPI app.

The schema in ``openapi/openapi.json`` is the single source of truth that the
frontend generates its client from, so it must be byte-for-byte reproducible.
This script writes it deterministically (sorted keys, fixed indent, trailing
newline).

Usage::

    python scripts/export_openapi.py            # write openapi/openapi.json
    python scripts/export_openapi.py --check     # exit 1 if it is out of date
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT = REPO_ROOT / "openapi" / "openapi.json"


def render() -> str:
    # Imported lazily so --help works without the service extra installed.
    from databench.service.app import create_app

    schema = create_app().openapi()
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the committed artifact is up to date instead of writing it",
    )
    args = parser.parse_args()

    rendered = render()

    if args.check:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != rendered:
            print(
                f"OpenAPI schema is out of date: {OUTPUT.relative_to(REPO_ROOT)}\n"
                "Run `python scripts/export_openapi.py` and commit the result.",
                file=sys.stderr,
            )
            return 1
        print("OpenAPI schema is up to date.")
        return 0

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(rendered, encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
