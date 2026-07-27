# E1 `evalscope-general-qa` Projection Evidence

- **Databench branch:** `feat/evalscope-integration-design`
- **EvalScope baseline:** `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`
- **Converter:** `evalscope-general-qa@1.0.0`
- **Date:** 2026-07-27

## Contract

The converter remains inside the existing Databench registry and exact-version export chain:

```text
Dataset exact version
  → inspect strict target_source
  → eligibility + fidelity digest
  → exact digest approval when semantic changes exist
  → stream application/x-ndjson as databench.jsonl
  → EvalScope general_qa / subset databench
```

The only normalized option is:

```json
{"target_source":"selected-candidate|verification-ground-truth|none"}
```

No field mapping, JSON Pointer, prompt template, user script, path or URL option is accepted.

## Fixed bytes

The committed fixture
[`evalscope-general-qa.expected.json`](../../../packages/io/test/golden/fixtures/v2/evalscope-general-qa.expected.json)
locks the actual Dataset version, complete fidelity plan/digest and UTF-8 bytes for all three profiles.

| target source | rows | fidelity digest |
|---|---:|---|
| selected candidate | 2 | `98a9bfba73cb0221050d745444c98b98f8f48ffca42231c046bafb5da1ed8d0f` |
| verification ground truth | 1 | `69eb53c8cf38644f27af134d052ab0729e1db36caf74bb412225dff101a02400` |
| none | 1 | `a695e9b6ad38b5fae3a3fcb811171685a1bbae0ced3227d71b2c0c8473e982af` |

The selected profile proves multi-selected expansion and candidate locator retention. Additional tests prove exact
Unicode, leading/trailing whitespace, embedded newlines and empty prompt/response strings without trim or
normalization. The no-reference row omits `response`; it does not emit `null` or an invented answer.

Each row contains `_databench.dataset_version`, `record_id` and `record_digest`; selected-candidate rows additionally
contain `candidate_id`. These fields are not part of model input. E3 will patch the locked adapter to copy the locator
into `Sample.metadata`; E1 deliberately does not modify EvalScope.

## Eligibility matrix

`excluded_by_reason` is limited to this enum and contains counts only:

| reason | rejected shape |
|---|---|
| `prompt_empty` | no shared contents |
| `prompt_not_user_terminated` | last shared role is not user |
| `prompt_not_text_only` | multipart, file, function trajectory or thought text |
| `tools_not_supported` | non-empty tool registry with otherwise text-only prompt |
| `selected_candidate_missing` | no `selected=true` candidate |
| `selected_candidate_not_text_only` | selected candidate is not one AI content with one ordinary text part |
| `verification_missing` | no verification object |
| `verification_ground_truth_not_string` | ground truth is another canonical JSON type |

The test matrix covers every reason. A selected record with both compatible and incompatible selected candidates
keeps the compatible rows and records a semantic fidelity drop for the incompatible candidate; an entirely
incompatible record contributes one bounded exclusion reason.

## Locked EvalScope compatibility smoke

The locked source implementation at
`evalscope/benchmarks/general_qa/general_qa_adapter.py` reads `messages` and `response`; absent `response` becomes the
empty target required by no-reference/Judge mode. On 2026-07-27 the exact locked module was loaded with controlled
minimal dependency stubs and its unmodified `GeneralQAAdapter.record_to_sample` method was invoked for every row in
the committed three-profile fixture:

```text
locked EvalScope adapter compatibility: 3/3 profiles accepted
```

The assertions checked message roles/content and targets for both selected rows, the ground-truth row and the
no-reference row. This smoke verifies the pinned adapter field contract; it does not claim E3 service packaging or a
model inference run.

## Cross-boundary evidence

- IO fixed bytes and negative eligibility matrix: 49 tests;
- Schema/OpenAPI/generated Web client include the converter and `evaluation-qa` task view;
- Workspace unit tests cover exact inspect→stream binding, locator bytes, semantic approval and digest mismatch;
- real Postgres/MinIO Workspace test exports a persisted exact Dataset through a fresh Workspace;
- real API and CLI suites cover registry show and `target_source=none` inspect;
- Web type/unit test accepts EvalScope normalized options, nested config hints and semantic fidelity review.

E1 adds no Prisma table, EvalScope process, gateway or `/evaluations/*` route. All UI capability manifest entries
remain `planned`, so GE7 green mode must continue to fail.
