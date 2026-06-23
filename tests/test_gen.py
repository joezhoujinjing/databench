from __future__ import annotations

import pytest

import databench as db
from databench import gen
from databench.llm import last_user_text


def _sft(user: str, assistant: str | None = None) -> db.SFTSample:
    msgs = [db.Message(role="user", content=user)]
    if assistant is not None:
        msgs.append(db.Message(role="assistant", content=assistant))
    return db.SFTSample(messages=msgs)


@pytest.fixture()
def ws(tmp_path):
    return db.Workspace.open(tmp_path / "bench")


# -- TestLLM -----------------------------------------------------------------


def test_testllm_deterministic_and_identified():
    llm = db.TestLLM(template="A: {prompt}")
    msgs = [db.Message(role="user", content="hi")]
    assert llm.generate(msgs) == "A: hi"
    assert llm.generate(msgs) == "A: hi"  # deterministic
    assert llm.id == "test:echo"


def test_last_user_text():
    assert last_user_text([db.Message(role="user", content="q")]) == "q"


# -- generation transforms ---------------------------------------------------


def test_generate_responses(ws):
    prompts = ws.add_samples([_sft("What is 2+2?"), _sft("Capital of Japan?")], name="prompts")
    llm = db.TestLLM(template="Answer: {prompt}")
    out = ws.run(gen.generate_responses, prompts, llm=llm, ref="sft")
    samples = list(out.to_samples())
    assert all(s.messages[-1].role == "assistant" for s in samples)
    assert samples[0].messages[-1].content == "Answer: What is 2+2?"
    assert samples[0].meta["generated_by"] == "test:echo"


def test_make_preference_pairs(ws):
    sft = ws.add_samples([_sft("Define entropy.", "Entropy measures disorder.")], name="sft")
    llm = db.TestLLM(template="meh: {prompt}")
    out = ws.run(gen.make_preference_pairs, sft, llm=llm, ref="pref")
    s = list(out.to_samples())[0]
    assert isinstance(s, db.PreferenceSample)
    assert s.chosen.content == "Entropy measures disorder."  # original kept as chosen
    assert s.rejected.content.startswith("meh:")


def test_judge_writes_signal(ws):
    sft = ws.add_samples([_sft("Q", "A")], name="sft")
    llm = db.TestLLM(fn=lambda messages, **o: "4", id="judge")
    out = ws.run(gen.judge, sft, llm=llm, signal="quality")
    assert list(out.to_samples())[0].signals["quality"] == 4.0


# -- caching / pin-once semantics --------------------------------------------


def test_generation_is_pinned_once(ws):
    prompts = ws.add_samples([_sft("hi")], name="prompts")
    llm = db.TestLLM(template="r: {prompt}")
    first = ws.run(gen.generate_responses, prompts, llm=llm)
    runs_before = len(ws.catalog.runs_producing(first.version))
    second = ws.run(gen.generate_responses, prompts, llm=llm)  # same llm+inputs -> cached
    assert first.version == second.version
    assert len(ws.catalog.runs_producing(first.version)) == runs_before


def test_changing_llm_changes_version(ws):
    prompts = ws.add_samples([_sft("hi")], name="prompts")
    a = ws.run(gen.generate_responses, prompts, llm=db.TestLLM(template="a: {prompt}", id="a"))
    b = ws.run(gen.generate_responses, prompts, llm=db.TestLLM(template="b: {prompt}", id="b"))
    assert a.version != b.version


def test_generator_requires_llm(ws):
    prompts = ws.add_samples([_sft("hi")], name="prompts")
    with pytest.raises(TypeError):
        ws.run(gen.generate_responses, prompts)  # no llm=


def test_lineage_records_llm(ws):
    prompts = ws.add_samples([_sft("hi")], name="prompts")
    llm = db.TestLLM(id="mymodel")
    ws.run(gen.generate_responses, prompts, llm=llm, ref="sft")
    node = ws.lineage("sft")
    assert node["produced_by"]["op"] == "generate_responses"
    assert node["produced_by"]["params"]["__llm__"] == "test:mymodel"
