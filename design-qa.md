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

final result: passed
