# Design QA — v2 product cutover

## Comparison target

- Source visual truth: `/Users/hanlu/.codex/generated_images/019f930f-b61e-72a3-97db-cb286da8d862/exec-c56890bd-e338-4167-b0f6-e88c3b30cb2f.png`
- Source pixels: `1774 × 887`
- Browser-rendered implementation: `artifacts/design-qa-datasets-1774x887-pass2-loaded.png`
- Implementation pixels: `1759 × 880`
- CSS viewport: `1774 × 887`; `devicePixelRatio: 1`
- Density normalization: source downsampled with Lanczos to `1759 × 880` as
  `artifacts/design-qa-source-normalized-1759x880.png`
- Combined full-view evidence: `artifacts/design-qa-comparison-pass2.png` (`3518 × 880`),
  source on the left and implementation on the right
- State: Chinese, dark theme, connected local API, populated dataset ref list

The live backend had 11 refs while the visual target captured 8. That difference is expected live product data,
not a layout or copy mismatch. User-created ref names and stable protocol metadata may still contain `v2`.

## Visual thesis and interaction thesis

- Visual thesis: a restrained, dark data workspace with purple reserved for brand and active navigation.
- Content plan: one 80px application header, page title/action, search/count, then a dense ref table.
- Interaction thesis: active-nav underline, row hover/focus state, and compact language/connection popovers.

## Comparison history

### Pass 1 — blocked

Evidence: `artifacts/design-qa-datasets-1774x887.png`.

- [P1] The implementation inherited a centered `100rem` shell, moving the brand and table about 70px inward
  compared with the source's 32px edge rhythm.
- [P1] A 64px header and smaller typography made the entire first viewport visibly denser and weaker than the
  selected 80px single-header composition.
- [P2] Search, primary action, table header, and rows were too short; only seven rows fit where the source showed
  eight.
- [P2] The loaded-ref count was missing from the search row.

Fixes: expanded the shell to `120rem` with 32px gutters, changed the desktop header to 80px, increased the
heading/control typography, made search and the primary action 56px, set table headers to 52px and rows to 64px,
and added the accurate loaded/total ref count.

### Pass 2 — passed

Evidence: `artifacts/design-qa-comparison-pass2.png`.

The revised implementation matches the source's main proportions, hierarchy, density, navigation state,
search/action placement, table rhythm, and dark/purple token balance. After the comparison, the four table
tracks were additionally aligned to `32fr / 35fr / 14fr / 19fr`; this was a P3 refinement and did not change
the accepted region structure.

No actionable P0, P1, or P2 difference remains.

## Required fidelity surfaces

- Fonts and typography: both use a neutral system/Inter-style sans stack. Brand, navigation, 36px page title,
  17px support copy, table labels, monospaced versions, weights, line heights, wrapping, and truncation were
  checked in the combined image.
- Spacing and layout rhythm: 80px header, 32px desktop gutters, centered primary navigation, right-side tools,
  56px controls, 52px table header, and 64px rows match the source composition. Table tracks share the same grid
  definition for headers and rows.
- Colors and visual tokens: near-black background, subtle neutral borders, restrained surfaces, muted secondary
  text, green connection state, and purple brand/active state match the target. Contrast remains readable.
- Image and asset fidelity: the target contains no photography or raster illustration. The database mark uses
  the existing Lucide vector asset, with no handcrafted SVG, emoji, CSS drawing, or placeholder substitution.
- Copy and content: `训练后数据集`, `通过引用管理不可变的数据集版本。`, `数据集 / 导入 / 转换`,
  `新建数据集`, filter text, count, and the four table labels match the selected direction. Product-level
  `V2 / refs` and v1/v2 switch copy are absent.

Focused region comparison was not needed: the high-resolution combined evidence keeps the header, search/action
row, table labels, and first eight rows legible in one normalized view. No small logo artwork, dense chart legend,
or fine control state required a separate crop.

## Responsive and interaction evidence

- Mobile evidence: `artifacts/design-qa-datasets-mobile-390x844-css-passed.png`.
- Mobile CSS viewport: `390 × 844`; `devicePixelRatio: 1.86`; browser capture returned `382 × 563` visible pixels.
- The 390px layout has `scrollWidth === clientWidth` (`381px`), so there is no horizontal page overflow.
- Header remains a single product shell: brand icon and tools on row one, the same three primary links on row two.
- Search filters the live list from 11 refs to one and updates the count to `共 1 个引用`.
- Dataset detail, valid 20-record list, record detail, lineage, export, ingest, and transforms all opened against
  the real local API using unversioned Web URLs.
- Direct refresh restored `/export/<exact-version>`; `/recipe` rendered the product 404.
- An HTML request to `/v2/datasets` returned API JSON `404`, proving `/v2` is no longer a SPA namespace.
- Language and connection controls stayed reachable; console warning/error log was empty.

## Open questions

None for R1. Irreversible deletion of persisted v1 Postgres rows or object keys remains a separate operator-confirmed
step and is intentionally outside visual QA.

## Follow-up polish

- P3: split the large production JS bundle in a later performance step; the current Vite build only emits the
  existing chunk-size warning and functionality is unaffected.

archived result: passed

---

# Design QA — transform guidance

## Comparison target

- Source visual truth:
  `/Users/hanlu/.codex/generated_images/019f977d-b350-7643-94b0-a3a17e472914/exec-21253caf-64a6-42e8-91b7-cca5eb514613.png`
- Source pixels: `1874 × 839`
- Browser-rendered implementation:
  `/Users/hanlu/.codex/visualizations/2026/07/25/019f977d-b350-7643-94b0-a3a17e472914/transform-subset-final-1450x650.png`
- Implementation pixels: `1435 × 643`
- CSS viewport: `1450 × 650`; document client size `1435 × 650`; `devicePixelRatio: 1`
- Density normalization: the source was resized to `1435 × 643` for the full-view comparison.
- Combined full-view evidence:
  `/Users/hanlu/.codex/visualizations/2026/07/25/019f977d-b350-7643-94b0-a3a17e472914/transform-guidance-full-comparison.png`
  (`2870 × 643`, source on the left and implementation on the right)
- Focused comparison evidence:
  `/Users/hanlu/.codex/visualizations/2026/07/25/019f977d-b350-7643-94b0-a3a17e472914/transform-guidance-focused-comparison.png`
  (`2005 × 458`, the selected transform header, guidance column, input, and parameter editor)
- State: Chinese, dark theme, connected local API, `subset` selected, page at scroll position `0`

The selected visual is a product-direction mock for the transform work area rather than a replacement for the
existing application shell. The implementation therefore retains Databench navigation, the page heading, the
existing input semantics, and result-save options while matching the selected list + guidance + form composition.

## Comparison history

### Pass 1 — passed

The implementation matches the source's three-region hierarchy:

1. fixed transform registry on the left;
2. purpose, input requirements, output behavior, and parameter example in the middle;
3. fixed-role execution form on the right.

No actionable P0, P1, or P2 difference was found, so no visual fix iteration was required.

Expected product constraints account for the visible differences:

- the live page includes the established app shell and result-save controls;
- the input remains a dataset name/version text field rather than the mock's select-like control;
- the subset example uses a complete schema-valid record ID instead of the mock's shortened display-only ID;
- colors, font stack, controls, borders, and the run action continue to use the existing Databench design tokens.

## Required fidelity surfaces

- Fonts and typography: the existing Databench sans and monospace stacks are preserved. Transform name, badges,
  section titles, body copy, JSON keys, line numbers, hints, wrapping, and hierarchy remain readable at the
  target desktop width and the narrow breakpoint.
- Spacing and layout rhythm: the registry and selected transform align on one desktop grid. The transform panel
  uses the selected guidance/form split, consistent section dividers, existing 4–6px radii, and the product's
  compact form rhythm. At narrow width the registry, guidance, and form stack in document order without overlap.
- Colors and visual tokens: the near-black background, muted borders, restrained surfaces, primary selected
  state, badges, focus treatment, and semantic connection indicator use existing product tokens with readable
  contrast.
- Image and asset fidelity: the target contains no photography, raster illustration, logo art, or decorative
  imagery that needs recreation. The only new icon is the existing Lucide reset icon; no handcrafted SVG, CSS
  drawing, emoji, or placeholder asset was introduced.
- Copy and content: every built-in transform now has a concise purpose, fixed input requirement, output result,
  role-specific labels/hints, and either a valid parameter example or an explicit no-parameter state in Chinese
  and English.
- Icons and controls: the reset icon aligns with the action label, the selected transform remains visibly
  pressed, inputs keep labels and focus affordances, optional result fields preserve their disabled behavior,
  and the schema disclosure stays reachable.

## Responsive and interaction evidence

- Narrow-screen evidence:
  `/Users/hanlu/.codex/visualizations/2026/07/25/019f977d-b350-7643-94b0-a3a17e472914/transform-prompt-rewrite-mobile-390x844.png`
  (`375 × 812` browser capture from a `390 × 844` viewport).
- At the narrow breakpoint, document `scrollWidth` is `375px` for a `390px` inner viewport, so the page has no
  horizontal overflow. The transform registry appears before the selected panel, and the guidance/form columns
  stack cleanly.
- `sample`: edited parameter JSON and used `恢复示例`; the editor returned to
  `{ "count": 2, "seed": 7 }`.
- `append-evidence`: rendered exactly two immutable input roles, `基础数据集` and `证据补丁数据集`, with no
  parameter editor or reset action.
- `prompt-rewrite`: rendered exactly two immutable input roles, `基础数据集` and `改写数据集`, and the explicit
  no-parameter state.
- Switching from a filled `sample` form to `append-evidence` recreated the form with two empty fixed-role inputs,
  confirming that transform-specific state does not leak across selections.
- Browser console warning/error log was empty.

## Findings

No actionable P0, P1, or P2 findings remain.

## Open questions

None for this selected transform-guidance direction.

## Follow-up polish

- P3: a later product pass could add dataset-name autocomplete without changing the fixed `input_roles` contract.
- P3: the full valid subset record ID intentionally scrolls horizontally in the code editor; a separate
  display-only abbreviation could improve scanning, but must never replace the executable example.

final result: passed
