"""Synthetic data generation, end to end, fully offline.

Run it:

    uv run python examples/synth_demo.py

Uses the deterministic TestLLM so it runs without any API key. Swap in a real
LLM adapter (anything implementing `id` + `generate`) to generate for real.
"""

from __future__ import annotations

import json
from pathlib import Path

import databench as db
from databench import gen

WORKSPACE = Path(__file__).parent / ".bench-synth"


def main() -> None:
    ws = db.Workspace.open(WORKSPACE)
    llm = db.TestLLM(template="A concise answer to: {prompt}", id="demo-model")

    # 1. Start from prompts (user turns only).
    prompts = ws.add_samples(
        [
            db.SFTSample(messages=[db.Message(role="user", content="What is the capital of France?")]),
            db.SFTSample(messages=[db.Message(role="user", content="Explain entropy briefly.")]),
        ],
        name="prompts",
    )

    # 2. Generate SFT responses, then derive preference pairs, then judge.
    sft = ws.run(gen.generate_responses, prompts, llm=llm, ref="sft")
    pref = ws.run(gen.make_preference_pairs, sft, llm=llm, ref="pref")
    judged = ws.run(gen.judge, sft, llm=db.TestLLM(fn=lambda m, **o: "4", id="judge"), ref="sft-judged")

    print(f"prompts={len(prompts)}  sft={len(sft)}  preference={len(pref)}")
    print("first preference pair:")
    p = list(pref.to_samples())[0]
    print(f"  chosen:   {p.chosen.content}")
    print(f"  rejected: {p.rejected.content}")
    print(f"judge signal on first sft sample: {list(judged.to_samples())[0].signals}")

    print("\nlineage of pref (note the recorded __llm__):")
    print(json.dumps(ws.lineage("pref"), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
