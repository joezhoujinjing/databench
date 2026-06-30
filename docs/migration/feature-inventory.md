# databench 迁移总清单与迁移顺序(权威)

> 本文是 Python → TS monorepo 迁移的**主计划**:全部功能的索引 + 依赖排序的分阶段迁移顺序 + 逐功能勾选框 + 必须先过的 golden-test 闸门。
> **每个功能的完整规则/边界/验收点**见两份明细(本文只做组织与排序,不重复细节):
> - [`inventory-domain.md`](inventory-domain.md) — 域与数据层,**74 条**(`CORE/HASH/DATASET/IO/XFORM/OPS/RECIPE/WS/STORE/CATALOG`)
> - [`inventory-service.md`](inventory-service.md) — 服务/契约/行为,`API/SVC/CONTRACT-01·02/ERR` 已实现;`CONTRACT-03..08` vocabularies 已在 D1 改为实现后补齐
>
> 目标栈见 [`../architecture.md`](../architecture.md) / [`../tech-stack.md`](../tech-stack.md);决策见 ADR [0001](../decisions/0001-rebuild-as-ts-monorepo.md)/[0002](../decisions/0002-http-framework.md)/[0003](../decisions/0003-storage-postgres-object-store.md)。

## 规模总览

| 域 | 功能ID | 条数 | TS 落点 |
|---|---|---|---|
| 哈希原语 | `HASH-01..05` | 5 | `packages/hashing` |
| 样本 schema | `CORE-01..10` | 10 | `packages/schema` |
| 数据集核心 | `DATASET-01..10` | 10 | `packages/engine` |
| 导入(JSONL) | `IO-01..06` | 6 | `packages/io` |
| transform 抽象 | `XFORM-01..03` | 3 | `packages/engine` |
| 内置 ops | `OPS-01..05` | 5 | `packages/ops` |
| 配方混合 | `RECIPE-01..05` | 5 | `packages/workspace`(+engine) |
| workspace 编排 | `WS-01..13` | 13 | `packages/workspace` |
| 内容寻址存储 | `STORE-01..05` | 5 | `packages/store`(对象存储) |
| catalog 控制面 | `CATALOG-01..12` | 12 | `packages/catalog`(Postgres) |
| 服务支撑 | `SVC-01..05` | 5 | `apps/api` |
| 端点 | `API-01..14` | 14 | `apps/api` |
| 错误合同 | `ERR-01..06` | 6 | `apps/api` |
| 服务 schema / OpenAPI 导出 | `CONTRACT-01·02` | 2 | `packages/schema` / `tooling/openapi-export` |
| **小计(必迁)** | | **101** | |
| vocabularies | `CONTRACT-03..08` | 6 | D1 已改为实现 |

## ⚠️ 迁移前必须先决策的事

1. **vocabularies(`CONTRACT-03..08`)**:原 inventory 记录 UI 的 pinned OpenAPI + 页面 + client 里有 6 个词表端点,当时 Python 后端尚未落地。当前 owner 已拍板按最新旧后端 `feat/vocabulary` + 旧 UI 语义实现,不再按暂缓处理。历史三选一如下:
   - (A) 本轮一并实现(需新建 vocabulary 的 schema/store/catalog/ops + 6 端点,且服务端要强制 canonical 唯一/alias 不相交等不变式 —— 详见 `inventory-service.md` CONTRACT-05);
   - (B) 暂不实现,`/capabilities` 显式返回 `vocabularies:false` 并在 UI 用能力位隐藏词表页(注意现 UI 对缺失能力是「宽松=可能仍显示」,需改);
   - (C) 从 UI 契约移除。
   **当前状态**:已选 (A) 并作为 S19 补齐。
2. **export `fmt` / recipe `target_format`**:当前 `trl` 只是字段/入口,**导出逻辑未分支实现**(WS-10/API-08/RECIPE-02)。决定照搬(保持等价)还是补齐真正的 TRL。
3. **OpenAPI 修正**:运行时错误是统一 envelope、export 是 NDJSON,但旧 OpenAPI 未声明 `ErrorResponse`、export 标成 JSON(ERR-*/API-08)。TS 用 `@hono/zod-openapi` 时**修正**这两处,别继承旧契约的错。
4. **前端是独立的重写轨**:本清单只覆盖**后端**。前端(`apps/web`)也全新重写,需要 (a) 定前端栈(React+Vite / Next 等);(b) 仿照本清单,对旧 `databench-ui`(`~/Desktop/databench/databench-ui/`)做一份「前端功能清单」,防重写漏页面/交互。后端契约不变(仍 `/v1` + openapi-typescript)。

---

## 迁移顺序(依赖排序,逐阶段;一阶段一阶段搬)

原则:**自底向上**——先搬「定义身份与数据形状」的地基(任何一处算错,所有 version/id/cache 都和旧数据对不上),每阶段配 golden test 对拍 Python `bench/` 既有数据后才进入下一阶段。

### 阶段 0 — monorepo 骨架(非功能)
pnpm workspaces + Turborepo、tsconfig project refs、vitest、docker-compose(`postgres` + `minio`)、空 `packages/*` 与 `apps/api`。

### 阶段 1 — `packages/hashing`(地基)
- [x] `HASH-01` blake3(固定 blake3,不移植 blake2b 回退)
- [x] `HASH-02` `canonicalJson`(四开关:排序键/无空格/保留 unicode/`default=str`;**禁用裸 `JSON.stringify`**)
- [x] `HASH-03` `hashBytes`/`hashText`(UTF-8)
- [x] `HASH-04` `hashObj` = `hashText(canonicalJson(x))`
- [x] `HASH-05` `hashUnordered`(sort→`\n` join→hash;**不去重**)
- **闸门 G1**:`canonicalJson`(含中文/乱序键/浮点/null)与 Python **逐字节**一致;`hashText("empty")` 等固定串对拍。

### 阶段 2 — `packages/schema`(样本身份)
- [x] `CORE-01..04` ToolCall/Message/Rollout/Candidate
- [x] `CORE-05` `_SampleBase` + identity 排除集 `{source,meta,signals}`(仅顶层)
- [x] `CORE-06` **`content_dict` 保留 null**(不 exclude_none)← 头号易漏
- [x] `CORE-07` `id = hashObj(content_dict)`(须 == DATASET 的 `sid`)
- [x] `CORE-08` 判别联合(sft/preference/rl/trajectory;默认值;SFT 与 trajectory 同形仅 kind 不同)
- [x] `CORE-09` `parseSample`(zod discriminatedUnion → 422)
- [x] `CORE-10` `SCHEMA_VERSION`/`Kind`(单一来源,service 引用)
- **闸门 G2**:逐 kind `content_dict` 与 Python 逐字节一致(尤其 null 字段存在性);同内容不同 source → 同 id;加 signal 不改 id。

### 阶段 3 — `packages/engine`:数据集核心
- [x] `DATASET-01` 全 Utf8 `COLUMNS` 布局
- [x] `DATASET-02` `Manifest`
- [x] `DATASET-03` `_row_digest`(`payload \x00 source \x00 meta \x00 signals`;`source or ""`)
- [x] `DATASET-04` `_build`(空集 version=`hashText("empty")`;`kind ?? "unknown"`;kinds 直方图)
- [x] `DATASET-05/06` `fromSamples`/`fromFrame`(fromFrame **忽略并重算** id/digest;缺 payload→error)
- [x] `DATASET-07` 访问器(`toPolars()` 每次 **clone**)
- [x] `DATASET-08/09/10` `toSamples`/`head`/`_loads`
- **闸门 G3**:写出的 Parquet 能被 Python `pl.read_parquet` 读、列名/类型一致;非空/空 dataset version 与 Python `bench/` 对拍;version 顺序无关。

### 阶段 4 — `packages/io`(导入)
- [x] `IO-01` `detectKind`(**判定短路顺序**:chosen+rejected→preference;rollouts→rl;messages+tool 痕迹→trajectory;否则 sft)
- [x] `IO-02/03` `_asMessages`/`_asCompletion`(简写归一化)
- [x] `IO-04` `_normalize`(按 kind;sft/trajectory 不归一)
- [x] `IO-05` `recordToSample`(记录自带 source 优先;强制写 kind)
- [x] `IO-06` `readJsonl`(空行跳过;1-based 行号错误;source 默认 = 文件名 stem)
- **闸门 G4**:`test_io.py` 全部行为对拍(四 kind 检测 + ValueError、字符串简写、source tagging、demo 5/3 行)。

### 阶段 5 — `packages/engine`:transform 抽象 + `packages/ops`
- [x] `XFORM-01..03` `Transform`/`buildParams`(默认值进 cache 输入;无参传参→报错)/`defineTransform`(**显式命名**)
- [x] `OPS-01` `dedup`(`unique{subset:["id"],keep:"first",maintainOrder:true}`)
- [x] `OPS-02` `filterBySignal`(`jsonPathMatch("$."+key)` + `cast(Float64,false)`;null 传播;min/max 都缺→全留)
- [x] `OPS-03` `sampleN`(n≥height 不动;否则 `sample({n,seed})`)← **采样确定性风险**
- [x] `OPS-04` `enrichLength`(非破坏合并;`word_len` 复刻 Python `split()` 语义)
- [x] `OPS-05` 文本抽取(preference 只用 chosen;rl 只用 prompt)
- **闸门 G5(关键)**:**nodejs-polars `sample(seed)` 与 Python polars 同 seed 是否选出同一子集**(ADR-0001 首要 golden test)。不一致 → 退 DuckDB 或自实现确定性采样。并对拍 `word_len` 多空格/空文本。

### 阶段 6 — `packages/store`(对象存储,数据面)
- [x] `STORE-01/02` `Store` 接口 + key 布局 `objects/<v[:2]>/<v>.parquet|.manifest.json`
- [x] `STORE-03` `exists`(parquet+manifest **都在**才算存在)
- [x] `STORE-04` `write`(幂等 no-op;manifest 最后写=完成标记;S3 PUT 原子)
- [x] `STORE-05` `read`(缺失→NotFound→404)
- **闸门 G6**:与既有 `bench/store` 布局一致;重复 write 同内容 no-op;缺 manifest→exists=false。(本地用 MinIO)

### 阶段 7 — `packages/catalog`(Postgres,控制面)
- [x] `CATALOG-01` 三表 + 索引(Prisma schema;`jsonb`/`timestamptz`)
- [x] `CATALOG-02` `registerDataset`(`ON CONFLICT DO NOTHING` = 首写为准)
- [x] `CATALOG-04` `recordRun`(`ON CONFLICT DO UPDATE` = 覆盖)
- [x] `CATALOG-07` `setRef`(`ON CONFLICT DO UPDATE` = 移动指针)
- [x] `CATALOG-03/05/06/08/09/11` get/find/runs_producing/refs/`resolve`(三段优先级)/行映射
- [x] `CATALOG-10/12` 连接池(替代 WAL/busy_timeout)/时间戳
- **闸门 G7**:**三种 upsert 策略逐表复刻、不可统一**;`resolve` 三态;`runsProducing` 建议加确定性 `ORDER BY`(注明与 Python 差异)。

### 阶段 8 — `packages/workspace` + 配方(编排,域层收口)
- [x] `RECIPE-01..05` Recipe/Source/fingerprint/`mix`(**banker's rounding**;`weight || 1.0`(0→1.0);共用 seed;不跨源去重)
- [x] `WS-01..04` open/add_samples/add_jsonl/add/get
- [x] `WS-05` `run`(**cache_key 内容逐字一致**;find_run+store.exists 双校验;params 末位传参)
- [x] `WS-06` `materialize`(cache_key=op+fingerprint;inputs=`sorted(set(resolved))`)
- [x] `WS-07/08` `lineage`/`_lineage`(环检测 `cycle:true`;`producers[0]`;建议 `WITH RECURSIVE`,输出结构 1:1)
- [x] `WS-09/10` `export`/`_export_record`(**`exclude_none`**;`fmt` 当前被忽略)
- [x] `WS-11/12/13` `_persist`(先 store 后 catalog)/`_coerce`/`DatasetLike`
- **闸门 G8**:`test_transform_cache_hit`(二次同参不新增 run、version 同);`test_recipe_materialize_reproducible`(version 一致);构造 half-value 验银行家舍入、0 权重退化;lineage 结构对拍。

### 阶段 9 — `packages/schema`(服务契约)+ `apps/api` 支撑
- [x] `CONTRACT-01` Page/Request/Response 模型(zod + `@hono/zod-openapi`)+ `ErrorResponse`(**进 OpenAPI**)
- [x] `SVC-01` 应用工厂 + `/v1` 装配(未版本化旧路径 → 404)
- [x] `SVC-02` CORS + **PNA 预检**(Hono 需自定义 OPTIONS 分支)
- [x] `SVC-03` workspace context(多副本下保证同 backend 可见)
- [x] `SVC-04` meta 常量(`MAX_PAGE_LIMIT=500`/`DEFAULT=20` 等,单一来源)
- [x] `SVC-05` transform 注册表(固定内置四个:dedup/enrich_length/filter_by_signal/sample_n)

### 阶段 10 — `apps/api` 错误合同
- [x] `ERR-01..06` 统一 envelope `{error:{code,message,detail?}}` + 映射:RequestValidation/Pydantic→422、HTTPException 状态码表、KeyError→404、ValueError→400、TypeError→400(并补一个兜底 Exception→500 envelope,Python 当前缺)
- **闸门 G10**:`test_service.py:test_error_envelope`/`test_pagination_cap_enforced` 对拍。

### 阶段 11 — `apps/api` 端点(按此顺序)
- [x] meta:`API-01` /health · `API-02` /version · `API-03` /capabilities(当前 `vocabularies:true`)
- [x] datasets:`API-04` POST /v1/datasets · `API-05` :ingest-jsonl(multipart 字段 `file`)· `API-06` get · `API-07` samples 分页 · `API-08` export(**NDJSON 流**)
- [x] transforms:`API-09` list · `API-10` run
- [x] recipes:`API-11` :materialize
- [x] refs:`API-12` list · `API-13` resolve(**只走 get_ref,不 resolve**)
- [x] lineage:`API-14` get(**未知 ref 返回 `{version:ref}` 不 404**)
- **闸门 G11**:`test_service.py:test_full_lifecycle` 端到端等价(JSON ingest→JSONL upload→get→分页→transform→lineage→refs→recipe→export);新前端(重写)按同一份 `openapi-typescript` 生成的 client 即可连上,契约与旧 `databench-ui` 所依赖的一致。

### 阶段 12 — `tooling/openapi-export`
- [x] `CONTRACT-02` 确定性导出(sorted keys/indent2/末尾 newline;`--check` 进 CI)。`apps/web` 的 `gen:client` 指向它。
- **闸门 G12**:同代码态 byte-for-byte 稳定;CI `--check` 通过;openapi-typescript 生成的类型前端可用。

### 阶段 13(独立里程碑)— vocabularies `CONTRACT-03..08`
已在 D1 改为实现后进行:新建 vocabulary 域(schema/内容寻址/store/catalog latest 指针)+ 6 端点 + 服务端不变式校验 + derive/normalize/validate 的 op。行为参考最新旧后端 `feat/vocabulary` 与旧 UI 页面语义。

---

## Golden-test 闸门汇总(迁移正确性的命门)

这些来自两份明细的「最危险易漏点」,**每条都应是一个 CI 对拍用例**,挂在对应阶段:

| 闸门 | 检查 | 来源 |
|---|---|---|
| G1 | `canonicalJson` 逐字节一致;禁裸 `JSON.stringify` | HASH-02 |
| G2 | `content_dict` **保留 null**、逐 kind 对拍 | CORE-06 |
| G3 | 空集 version=`hashText("empty")`;Parquet 跨实现可读;version 顺序无关 | DATASET-04, HASH-05 |
| G5 | **seeded 采样跨实现一致**(nodejs-polars vs Python) | OPS-03/RECIPE-05 |
| G5 | `word_len` 复刻 Python `split()`(空白折叠、空文本→0) | OPS-04 |
| G8 | **banker's rounding**(half-to-even)+ `weight||1.0`(0→1.0) | RECIPE-05 |
| G8 | transform `cache_key` 内容逐字一致(默认值进 key) | WS-05/XFORM-02 |
| G7 | catalog **三种 upsert** 各自复刻、不可统一 | CATALOG-02/04/07 |
| G10 | 错误 envelope + 全部异常映射 | ERR-01..06 |
| G2 | blake3 固定(复用既有 store;无 blake2b 回退) | HASH-01 |
| G11 | CORS PNA 仅在请求 header 出现时返回 | SVC-02 |

> 跨实现采样(G5)是 ADR-0001 点名的**头号风险**。建议**阶段 0 之后、阶段 1 之前先做一个采样 spike**:若 nodejs-polars 与 Python 同 seed 不一致,整个 OPS/RECIPE 的引擎选型要早决定(退 DuckDB `REPEATABLE(seed)` 或自实现)。

---

## 怎么用这份文档迁移

1. 一次锁定一个**阶段**,按勾选框逐 `功能ID` 搬;细节查两份明细里的同 ID 条目(含**关键规则与边界 / TS 目标 / 验收点**)。
2. 每条功能搬完即写它的**验收点**为测试;阶段末跑该阶段**闸门**对拍 `bench/`(既有 Python catalog.db + store 是现成的 golden 源)。
3. 闸门绿了再进下一阶段。先决策三件事(vocabularies / TRL / OpenAPI 修正)再开工。
