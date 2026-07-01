# databench-ts 代码 Review(2026-07-01)

> 只审不改。评审基准:`AGENTS.md` 硬规则 + `docs/conventions.md` + `docs/migration/{inventory-domain,inventory-service}.md`;parity 语义真源:旧 Python `~/Desktop/databench/databench/`。范围:S0–S21(含 vocabularies)。

## 1. 总体健康度

这是一份**高质量、忠实度很高**的 Python→TS 迁移。硬规则(依赖 DAG、契约单一来源、错误映射、样本不入 PG)基本**全部遵守**;确定性纪律的核心机关(`canonicalJson` 代码点排序、`JsonNumberLexeme` 保浮点格式、`bankersRound`、`weight || 1.0`、空集 `hashText("empty")`、row-digest NUL 拼接、`hashUnordered` 排序+`\n`+不去重)都**逐条正确复刻**,且大量golden 值与旧 Python 一致。最强的一条闸门 `apps/api/test/parity.golden.test.ts` 会**真的启动旧 Python uvicorn** 并端到端对拍 version/samples/refs/lineage/export——本机全绿。

但有三类需要认真对待的问题:

1. **确定性存在两条真实(但触发条件明确)的 parity 裂缝**:HTTP `POST /v1/datasets` 入口丢弃 JSON number lexeme(整数值浮点在开放 dict 里会算错 id/version);vocabulary 内容哈希用 `localeCompare` 排序(依赖宿主 locale,和 Python `sorted()` code-point 序不一致)。
2. **golden 闸门的可复现性问题(假绿)**:几乎所有"live Python 对拍"块都被 `existsSync('/Users/hanlu/Desktop/databench/...python')` 门控,在 CI 里**静默跳过**;而 `store.golden`(读旧 bench store)和 `apps/api parity.golden`(spawn 旧 uvicorn)**硬编码绝对路径且无门控**,在 CI/他机上会**直接失败**。也就是说 `pnpm test` 作为闸门**只在作者本机可绿**。
3. 若干**中低危**域正确性/一致性问题(vocab 保存旁路校验、validate 不走缓存、char_len 用 UTF-16 长度等)。

## 2. 闸门结果(本机,docker compose 已 up)

| 闸门 | 结果 | 备注 |
|---|---|---|
| `docker compose up -d` | ✅ | postgres:17 + minio 均 healthy(:55432 / :9000) |
| `pnpm lint`(Biome) | ✅ exit 0 | 无告警 |
| `turbo run typecheck --force` | ✅ exit 0 | 全包通过(strict + exactOptionalPropertyTypes) |
| `turbo run test --force` | ✅ exit 0 | **仅本机**:20/20 包任务通过;`api` 19 tests 含 S20 Python parity;但见 [G-B] |
| `pnpm openapi:check` | ✅ exit 0 | FULL TURBO,契约确定性稳定 |

**结论:本机全绿。但 `pnpm test` 的绿在 CI/他机上不可复现(见 [G-B]),这是对"过闸门"最需要修正的认知。**

---

## 3. 分级发现

> 格式:`[级别] 区域 · 文件:位置 · 问题 · 为何重要 · 建议修法`。P0/P1/P3 优先。无 Critical。

### High

**[High] P0/确定性 · `apps/api/src/routes/datasets.ts:110` · HTTP `/v1/datasets` 摄取用 `context.req.json()`,丢弃 JSON number lexeme**
`ingestSamples` handler:`IngestSamplesRequestSchema.parse(await context.req.json())`。`req.json()` 走标准 `JSON.parse`,不保留数字源文本 → 开放 dict 里的**整数值浮点**(`meta`/`signals`/`rollout.meta`/`tool_call.arguments`)被折叠成整数。
- 例:`POST /v1/datasets` 提交 `signals:{"quality":1.0}` → TS canonical `{"quality":1}`;Python `content_dict` 保留 `{"quality":1.0}`。`signals`/`meta` 进 `row_digest` → **dataset version 与 Python 不一致**;`rollout.meta`/`arguments` 进 payload → **sample id 不一致**。
- 更糟:**同一份数据经 JSONL 摄取则正确**——`packages/io/src/read-jsonl.ts:32` 用 `parseJsonValue`(=`parseCanonicalJson`)捕获了 `1.0` lexeme。于是 HTTP 与 JSONL 两条入口对同一样本产出**不同 id**,直接破坏内容寻址与"跨入口一致"。
**为何重要**:内容寻址是整套 version/id/cache/lineage 的地基;这条使 HTTP 摄取的数据无法与旧 store / JSONL 摄取的数据对齐(缓存 miss、重复 version、dedup 失效)。`reward`/`score` 因 `content.ts:floatContent` 强制 `.0` 而**幸免**,但其它开放 dict 无此保护。
**建议**:handler 改为 `parseCanonicalJson(await context.req.text())` 再 `IngestSamplesRequestSchema.parse(...)`,让整个 body 走 lexeme 捕获(与 JSONL 路径统一);并补一条"含 `signals:{q:1.0}` / `rollout.meta:{s:2.0}` 的样本经 HTTP 与经 JSONL id 相同、且等于 Python"的 golden。

**[High] P0/P3 确定性 · `packages/schema/src/vocabulary.ts:109`(及 `:112`)· `vocabularyContent`(哈希输入)用 `localeCompare` 排序 canonical**
`vocabularyId = hashObj(vocabularyContent(input))`,而 `vocabularyContent` 对 terms 排序用 `left.canonical.localeCompare(right.canonical)`,对 aliases 用默认 `.sort()`。`String.localeCompare` 走 ICU 区域整理,**依赖宿主默认 locale**,与 Python `Vocabulary.content_dict` 的 `sorted()`(Unicode code-point)不一致。实测:`'Apple'.localeCompare('apple')=1` 但 code-point `'Apple'<'apple'`;`localeCompare` 排出 `['apple','Apple',…]`,Python/code-point 排出 `['Apple','apple',…]` → **term 数组顺序不同 → 哈希内容不同 → vocabularyId 不同**(大小写混排的 canonical 必中;某些 locale 下 CJK 亦中)。
**为何重要**:(a) 违反确定性纪律——哈希输入不得依赖宿主 locale(同一份 vocab 在 `LANG=zh_CN` 与 `en_US` 机器上 id 不同);(b) 与旧 Python `vocabulary.py` 的 id parity 存在裂缝。**且无任何测试拿 `vocabularyId` 与 Python 对拍**(见 [G-D])。反证:同文件 `stringifyLikePythonJsonDumps`(`:470`)和 `@databench/hashing` 都正确用了 `compareCodePoints`——此处 `localeCompare` 属遗漏。
**建议**:`vocabularyContent` 的 canonical 与 aliases 排序统一改用 code-point 比较器(复用文件内已有的 `compareCodePoints`),消除 locale 依赖并对齐 Python。

**[High] P6/闸门可复现性 · `apps/api/test/parity.golden.test.ts:12-13` + `packages/store/test/store.golden.test.ts:26-27,103-123` · 硬编码绝对路径、无门控 → CI/他机上失败**
`parity.golden`(`LEGACY_UVICORN=/Users/hanlu/.../.venv/bin/uvicorn`,`startLegacyService` 无 `existsSync` 门控)与 `store.golden` 的 `can read objects laid out like the legacy bench store`(`readFileSync('/Users/hanlu/.../bench/store/...')` 无门控)都直连作者本机的第二个仓库。缺此路径时:`store.golden` 直接 `ENOENT` 抛错、`parity.golden` 15s 后 `did not become healthy` 抛错 → **测试失败** → `pnpm test` 失败。CI(GitHub ubuntu)不存在该路径。
**为何重要**:CI 的 `pnpm test`(`.github/workflows/ci.yml:24`)**作为写死的闸门实际不可绿**;"S20 parity 已过闸门"这一结论**只在作者笔记本成立**。
**建议**:把 legacy 路径改为 env(如 `DATABENCH_LEGACY_REPO`)并对所有 live-Python/legacy-store 用例统一 `describe.runIf(...)` 门控;或把一小份 `bench/store` 对象与 Python 期望值作为**固定 fixture 提交进本仓** `test/golden/fixtures/`,让 CI 真能对拍(而非跳过)。

### Medium

**[Medium] P0/parity · `packages/ops/src/enrich-length.ts:12` · `char_len` 用 `text.length`(UTF-16 code unit)而非 Python `len(text)`(code point)**
`char_len: text.length`。对含非 BMP/astral 字符(emoji、CJK 扩展 B+)的文本,JS `.length` 比 Python `len()` 大 → signal 值不同 → `row_digest` 不同 → **enrich_length 的 dataset version 与 Python 不一致**。`word_len`(`text.ts:pythonWordCount`)已正确复刻 `str.split()`;唯 `char_len` 遗漏。现有 golden 全是 ASCII/BMP(`char_len:35`),覆盖不到。
**建议**:`char_len` 改 `[...text].length`(或 `Array.from(text).length`)取 code-point 数;补 astral 字符 golden。

**[Medium] P2/P3 · `packages/workspace/src/workspace.ts:315-316` · `saveVocabulary` 旁路不变式校验**
`saveVocabulary` 调 `withVocabularyId(input)`,而 `withVocabularyId`(`vocabulary.ts:91`)**不**跑 `VocabularyInputSchema.superRefine`(三大不变式在那里强制)。HTTP 路由 `routes/vocabularies.ts` 先 `parseVocabularyInput` 故 HTTP 入口安全;但任何**非 HTTP 域调用**(测试/未来内部批处理)可持久化"重复 canonical / 一 alias 两 canonical / alias 与 canonical 相交"的非法 vocab。Python 把不变式放在 `Vocabulary` 构造里,任何构造路径都挡得住。
**为何重要**:CLAUDE.md 明确要求服务端**强制**这些不变式;域方法能落非法 blob 是强制的漏洞。`deriveVocabulary` 已正确在 `:286` 复校,唯 `saveVocabulary` 漏。
**建议**:`saveVocabulary` 落库前先 `parseVocabularyInput`/`assertVocabularyInput`,或让 `withVocabularyId` 内部先 `.parse`。

**[Medium] P2/P3 · `packages/workspace/src/workspace.ts:426-463` · `validateVocabulary` 无缓存命中短路,每次都 `#persist`+`recordRun`**
`deriveVocabulary`(`:285`)与 `normalizeVocabulary`(`:398`)都有 `findRun`+`store.exists` 缓存命中路径;`validateVocabulary` 没有——每次调用都重算全量数据集、重写 store、`recordRun`(upsert)。结果确定故无正确性错误,但重复浪费且与另两者形态不一致;若 Python `validate_vocabulary` 走缓存则属 parity 缺口。
**建议**:补 `findRun`+`store.exists` 短路,与 derive/normalize 对齐。

**[Medium] P0/parity(cache-key/fingerprint 字节) · `packages/ops/src/filter-by-signal.ts` + `packages/schema/src/recipe.ts:34` · 整数值浮点参数序列化为 `5` 而非 Python `5.0`**
`buildParams` 用 zod-parsed 对象作 cache-key 输入;`filter_by_signal` 的 `min/max`(`z.number()`)与 recipe 的 `weight`(`toRecipeJson→jsonNumberValue`)是浮点。给整数值(`min:5`、`weight:2`)时 TS canonical 得 `5`/`2`,Python `model_dump(mode="json")` 得 `5.0`/`2.0` → **transform cache_key / recipe fingerprint 与 Python 不逐字一致**。
**为何重要**:TS catalog 与 Python 独立,内部缓存仍自洽,故**非功能性 bug**;但违反评审基准"cache_key 内容逐字一致"。注意 `parity.golden` 抓不到此裂缝:它比对的 `produced_by.params` 经 `response.json()` 时 `2.0` 又被 `JSON.parse` 折回 `2`,两侧都成 `2`。
**建议**:若要 fingerprint/params 与 Python 逐字对齐,对浮点字段套 `floatContent` 式 `.0` 归一(或统一走 lexeme);否则在文档明确"cache_key 仅内部自洽,不与 Python 对拍"。

### Low

**[Low] P1/纪律 · CI 无自动依赖-DAG/import-boundary 校验**
`conventions.md`/`AGENTS.md` 称"CI 应校验"依赖 DAG 与禁深 import,但仓库无 dependency-cruiser / eslint-boundaries,仅靠 package.json `exports` + 约定。**当前实际全合规**(见 §4),但缺自动闸门,后续易漂移。建议加 depcruise 规则进 CI。

**[Low] P1/约定 · `packages/engine/src/dataset.ts:64`、`packages/workspace/src/workspace.ts:579` 等 · 域层抛裸 `Error`/`TypeError` 而非类型化 `BadInputError`**
`Dataset.fromFrame` 缺 payload 抛裸 `Error`;`coerceDataset` 抛 `TypeError`。二者经 `middleware/error.ts:100` 的 `isPlainError`/`TypeError → 400` 正确落地(与 Python `ValueError/TypeError→400` 一致),但"裸 Error 一律 400"较宽:任何库偶发 `new Error()` 会被误报成 400 客户端错并**回显其 message**。建议 io/engine 的用户输入错误改抛 `BadInputError`,让"未分类=500"更稳。

**[Low] P4 · `apps/api/src/routes/datasets.ts:192-204` · NDJSON export 在 `start()` 里一次性抽干生成器,无背压**
`streamLines` 在 `ReadableStream.start` 内同步 `enqueue` 全部行,抵消了 `workspace.exportLines` 的惰性。export 是"拉全量"的官方路径(故有 `MAX_PAGE_LIMIT=500`),大数据集会整体入内存。建议改 `pull(controller)` 逐行推进。(来自 P4 子审。)

**[Low] P0/parity · `packages/io/src/export-record.ts:31` · 整数值 `reward` 导出为 `1` 而非 Python `1.0`**
导出 NDJSON 不参与哈希,仅训练输出字节与 Python 略异。可接受;若要严格对齐,导出前对浮点套 `.0` 归一。

**[Low] P5 · `apps/web` 若干打磨项(来自 P5 子审)**:`components/lineage/graph.ts:36` / `LineagePageView.tsx:197` 递归无 visited-set(后端已截断环,故有界非死循环);`api/capabilities.tsx:57` 的 `useMemo` 依赖每渲染新建的 query 对象,memo 失效(无害);`features/ingest/IngestPageView.tsx:265` 等有硬编码 mock 指标占位。均非功能缺陷。

**[Low] P4 · `apps/api/src/middleware/cors.ts:23` · 所有 `OPTIONS` 一律 204**,比 Starlette CORSMiddleware(只拦带 `Access-Control-Request-Method` 的真预检)略宽;当前无路由定义 OPTIONS,观测等价。allowlist/PNA echo/credentials-off/精确 origin 语义(SVC-02)均正确。

---

## 4. 硬规则(P1)合规核对 — 基本全绿

| 规则 | 结论 | 证据 |
|---|---|---|
| 依赖 DAG 无环、只向下 | ✅ | `apps/api` 只 import `@databench/{workspace,schema}`(grep 零 store/catalog/engine/ops/io);无深 import(grep `@databench/*/src|dist` 零命中) |
| `catalog` 只依赖 Prisma | ✅ | `catalog/src/*` 仅 import `@prisma/client` + 本包 |
| `hashing`/`schema` 保持纯 | ✅ | grep `nodejs-polars|@prisma|@aws-sdk|apache-arrow` 于 hashing/schema src 零命中 |
| 禁裸 `JSON.stringify` 做哈希输入 | ✅ | 全仓 `JSON.stringify` 命中均为:canonical 编码器内部字符串转义 / 错误消息·repr / store blob 序列化(blob 由独立 `canonicalJson` 计 id)/ export NDJSON / web 请求体——**无一是哈希输入** |
| 契约单一来源 → OpenAPI | ✅ | wire 类型仅在 `@databench/schema` zod 定义;`openapi:check` 绿;前端 `apps/web` grep `@databench/` 零命中(只吃生成 client) |
| 错误映射只在 apps/api | ✅ | 域层抛类型化 `DomainError`/裸 Error;`middleware/error.ts` 独家映射信封,含**兜底 500 且不回显 message/stack** |
| 样本绝不进 PG | ✅ | catalog 仅存 version/name/kinds/params 元数据;Parquet 在对象存储 |
| 三种 upsert 逐表正确 | ✅ | `registerDataset`=`createMany skipDuplicates`(DO NOTHING);`recordRun`=`upsert`(REPLACE);`setRef`/`setVocabularyRef`=`upsert`(DO UPDATE) |
| `capabilities.vocabularies` | ✅ | `apps/api/src/capabilities.ts:16` = `true` |

**加分项**:`catalog.runsProducing`(`catalog.ts:123`)加了 `orderBy [createdAt asc, cacheKey asc]`,消除了旧 Python `runs_producing` 无 ORDER BY 导致的 `producers[0]` 不确定性(inventory WS-08/CATALOG-06 建议的加固,已落实)。

---

## 5. Parity 覆盖缺口清单(哪些"绿"其实没对 Python)

- **[G-A] 所有 live-Python 对拍块被 `existsSync(PYTHON)` 门控 → CI 里静默跳过**:`canonical-json.golden`、`content.golden`、`dataset.golden`(Python 读 parquet)、`ops.golden`(含 sample_n)、`vocabulary.golden`。CI 只跑硬编码 golden 常量,从不 live diff Python。
- **[G-B] `store.golden` 读旧 bench store、`parity.golden` spawn 旧 uvicorn:硬编码绝对路径且无门控 → CI/他机直接失败**(见 High)。最强端到端 parity 只在作者本机可跑。
- **[G-C] 种子采样确定性(OPS-03/RECIPE-05,ADR 点名的 #1 风险)无 CI 级 golden**:`ops.golden` 里 seed=7 选中的具体 id 仅在 CI-跳过的 live 块与 Python 对比;CI 只断言 `sampledIds.length===3`。若 nodejs-polars 与 Python polars 的 seed→选择哪天分叉,CI 抓不到。
- **[G-D] `vocabularyId` 从未与 Python 对拍**:`vocabulary.test.ts` 的 `id is content-addressed` 只测 TS 内部序无关;live 块只比 **sample** id + summary。`localeCompare` 裂缝(High)因此无守护。
- **[G-E] HTTP 入口"开放 dict 整数值浮点"id parity 无覆盖**:`parity.golden` 的样本无 `signals`/`rollout.meta`/`arguments` 浮点,漏掉 High 裂缝。
- **[G-F] `char_len` astral 字符无覆盖**;`filter_by_signal`/recipe **浮点参数 cache_key** 未与 Python 对拍(仅测 TS 内部复现性)。
- **[G-G] vocab HTTP 错误信封(422 alias 冲突 / 400 缺 extractor)无 apps/api 路由测试**(旧 `test_vocabulary.py` 有);lineage `cycle:true` 无实际成环用例(内容寻址下罕见,低危)。

---

## 6. Top 5 优先修

1. **[High] HTTP `/v1/datasets` 改走 lexeme 捕获**(`routes/datasets.ts:110`:`parseCanonicalJson(await req.text())`),消除 HTTP-vs-JSONL-vs-Python 的 id/version 三方裂缝 + 补对应 golden。
2. **[High] `vocabularyContent` 排序改 code-point**(`vocabulary.ts:109/112` 用 `compareCodePoints`),去 locale 依赖 + 对齐 Python `sorted()`;并加一条 `vocabularyId` vs Python 的 golden [G-D]。
3. **[High] 让 parity 闸门在 CI 可复现**:legacy 路径 env 化 + 统一 `runIf` 门控,或把 `bench/store` 小 fixture 与 Python 期望值提交进本仓,使 `pnpm test` 在 CI 真能对拍而非跳过/失败 [G-B]。
4. **[Medium] `char_len` 用 code-point 计数**(`enrich-length.ts:12`)+ astral golden;顺带 **`saveVocabulary` 落库前强制不变式校验**(`workspace.ts:315`)。
5. **[Medium] 给种子采样一条 CI 级 golden**(把 seed=7 选中的 id 固化为断言,不再只测 length)[G-C];并补 vocab HTTP 错误信封路由测试 [G-G]。

---

### 附:最严重的 3 个发现(回报)

1. **HTTP `/v1/datasets` 摄取丢弃 JSON number lexeme**(`routes/datasets.ts:110`)→ 开放 dict 里的整数值浮点(`signals`/`meta`/`rollout.meta`/`arguments`)算出的 id/version 与 Python **及经 JSONL 摄取的同一样本**不一致,破坏内容寻址跨入口一致性。
2. **`vocabularyContent` 用 `localeCompare` 排序 canonical**(`vocabulary.ts:109`)→ `vocabularyId` 依赖宿主 locale、与 Python code-point 序不一致(大小写混排 canonical 必中),且**无任何测试对拍 vocabularyId**。
3. **闸门可复现性/假绿**:`parity.golden` 与 `store.golden` 硬编码作者本机绝对路径且无门控,其余 live-Python 对拍被 `existsSync` 静默跳过 → **`pnpm test` 作为闸门只在作者本机可绿**;`sampledIds` 等关键确定性项在 CI 无对 Python 的守护。

**闸门是否全绿:本机全绿(lint/typecheck/test/openapi:check 均 exit 0,docker 已 up);但 `pnpm test` 的绿依赖作者本机的旧 Python 仓库路径,CI/他机不可复现——这是需要修正的"过闸门"认知。未改任何源码。**
