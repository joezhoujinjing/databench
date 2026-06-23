"""Synthetic-data generation transforms.

Each is a ``@generator`` — a transform that takes an :class:`LLM` and produces a
new dataset version with automatic lineage. Generation is pinned-once by the
cache (same inputs/params/llm reuse the prior output); bump ``seed`` or change
the model to regenerate.

Run them via ``Workspace.run(op, ds, llm=my_llm, ...)``.
"""

from __future__ import annotations

import re
from typing import Optional

from pydantic import BaseModel

from .dataset import Dataset
from .llm import LLM
from .ops import _sample_text
from .schema import Message, PreferenceSample, SFTSample
from .transform import generator


class GenerateParams(BaseModel):
    system: Optional[str] = None
    seed: int = 0


@generator(params=GenerateParams)
def generate_responses(ds: Dataset, llm: LLM, p: GenerateParams) -> Dataset:
    """Generate an assistant reply for each conversation → new SFT samples.

    Input samples should be prompts (ending in a user turn). The generated
    assistant turn is appended.
    """

    out = []
    for s in ds.to_samples():
        msgs = list(getattr(s, "messages", []))
        if p.system:
            msgs = [Message(role="system", content=p.system)] + msgs
        reply = llm.generate(msgs, seed=p.seed)
        new_msgs = list(getattr(s, "messages", [])) + [Message(role="assistant", content=reply)]
        out.append(
            SFTSample(messages=new_msgs, source=s.source, meta={**s.meta, "generated_by": llm.id})
        )
    return Dataset.from_samples(out, name=ds.name)


class PreferenceParams(BaseModel):
    instruction: str = "Give a brief, lower-effort answer to the question."
    seed: int = 0


@generator(params=PreferenceParams)
def make_preference_pairs(ds: Dataset, llm: LLM, p: PreferenceParams) -> Dataset:
    """Turn SFT conversations into preference pairs.

    The existing final assistant turn becomes ``chosen``; the llm generates a
    contrasting ``rejected`` response.
    """

    out = []
    for s in ds.to_samples():
        msgs = list(getattr(s, "messages", []))
        if not msgs or msgs[-1].role != "assistant":
            continue
        prompt, chosen = msgs[:-1], msgs[-1]
        rejected_text = llm.generate(
            prompt + [Message(role="user", content=p.instruction)], seed=p.seed
        )
        out.append(
            PreferenceSample(
                prompt=prompt,
                chosen=chosen,
                rejected=Message(role="assistant", content=rejected_text),
                source=s.source,
                meta={**s.meta, "rejected_by": llm.id},
            )
        )
    return Dataset.from_samples(out, name=ds.name)


class JudgeParams(BaseModel):
    criteria: str = "overall quality on a scale of 1 to 5"
    signal: str = "judge_score"
    seed: int = 0


@generator(params=JudgeParams)
def judge(ds: Dataset, llm: LLM, p: JudgeParams) -> Dataset:
    """LLM-as-judge: score each sample and write it into ``signals`` (enrichment)."""

    out = []
    for s in ds.to_samples():
        prompt = (
            f"Rate the following on {p.criteria}. Reply with a single number only.\n\n"
            f"{_sample_text(s)}"
        )
        score = _parse_number(llm.generate([Message(role="user", content=prompt)], seed=p.seed))
        s.signals = {**s.signals, p.signal: score}
        out.append(s)
    return Dataset.from_samples(out, name=ds.name)


def _parse_number(text: str) -> Optional[float]:
    m = re.search(r"-?\d+(?:\.\d+)?", text or "")
    return float(m.group()) if m else None
