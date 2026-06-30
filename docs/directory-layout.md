# 具体目录布局(文件级,权威)

> [`project-structure.md`](project-structure.md) 定「有哪些包 + 依赖方向规则」;本文定「每个包/应用内部**每个文件**放什么」,每个文件标注承载的功能ID(对照 [`migration/feature-inventory.md`](migration/feature-inventory.md))。迁移时按文件建,不要临时发挥。

---

## `apps/api`(Hono 服务)

契约优先:**请求/响应 zod schema 在 `@databench/schema`**,本应用只放「路由定义(createRoute)+ 处理器 + 中间件 + 装配」。处理器只做:zod 校验 → 调 `workspace` → 整形响应 → 抛领域错误(由 error 中间件统一映射)。**不直连 store/catalog/engine**。

```
apps/api/
├─ src/
│  ├─ index.ts                 # 服务入口:loadConfig() → createApp() → @hono/node-server 监听 PORT
│  ├─ app.ts                   # createApp(): new OpenAPIHono();装中间件;挂 meta + /v1 路由;返回 app   [SVC-01]
│  ├─ config.ts                # zod 校验环境变量(DATABASE_URL/S3_*/CORS/PORT),缺失即启动失败       [SVC-04(env)]
│  ├─ context.ts               # Hono Variables 类型 + 取 workspace 的 helper                          [SVC-03]
│  ├─ openapi.ts               # OpenAPI doc 元信息(title/version/description)、组件注册
│  ├─ middleware/
│  │  ├─ cors.ts               # CORS 静态 regex + 环境 allowlist + PNA 预检 OPTIONS 分支               [SVC-02]
│  │  ├─ workspace.ts          # 把 Workspace 注入 context(按 backend 配置;多副本无状态)             [SVC-03]
│  │  └─ error.ts              # 领域错误/zod 错误 → 统一 envelope;兜底 500                            [ERR-01..06]
│  ├─ routes/
│  │  ├─ index.ts              # 组装 /v1 路由组(V1_PREFIX),挂载下面所有 domain 路由
│  │  ├─ meta.ts               # GET /health /version /capabilities(不带 /v1)                          [API-01..03]
│  │  ├─ datasets.ts           # POST /v1/datasets · :ingest-jsonl(multipart `file`)· GET {ref} · /samples · /export(NDJSON) [API-04..08]
│  │  ├─ transforms.ts         # GET /v1/transforms · POST /v1/transforms/{name}/run                    [API-09,10]
│  │  ├─ recipes.ts            # POST /v1/recipes:materialize                                           [API-11]
│  │  ├─ refs.ts               # GET /v1/refs · GET /v1/refs/{name}                                     [API-12,13]
│  │  ├─ lineage.ts            # GET /v1/lineage/{ref}                                                  [API-14]
│  │  └─ vocabularies.ts       # GET/PUT/derive/normalize/validate vocabularies                         [CONTRACT-03..08]
│  └─ capabilities.ts          # 运行时能力探测(transforms/recipes/lineage/jsonl/export/vocabularies:true) [API-03,SVC-04]
├─ test/
│  ├─ lifecycle.test.ts        # 全生命周期端到端(对照 test_service.py:test_full_lifecycle)            [闸门 G11]
│  ├─ errors.test.ts           # 错误信封 + 分页上限                                                    [闸门 G10]
│  └─ cors.test.ts             # CORS 本地/精确 origin + PNA                                            [SVC-02]
├─ Dockerfile                  # 长驻容器(含 N-API 原生插件),部署用                                   [ADR-0005]
├─ package.json                # name @databench/api;deps: @databench/workspace、@databench/schema、hono、@hono/zod-openapi、@hono/node-server
└─ tsconfig.json
```

**路由文件写法约定**:每个端点用 `@hono/zod-openapi` 的 `createRoute({ method, path, request, responses })`,其中 request/response 的 schema **从 `@databench/schema` import**(不在此处重定义);handler 从 `context` 取 workspace 调用。

---

## `apps/web`(前端,**全新重写** — React+Vite SPA + shadcn/ui,见 ADR-0006)

纯 REST 客户端;只通过 `openapi-fetch` 消费 `/v1`,**不 import 任何后端包**。旧 `databench-ui`(`~/Desktop/databench/databench-ui/`)作功能参考。

```
apps/web/
├─ index.html
├─ vite.config.ts              # Vite + @tailwindcss/vite + @tanstack/router 插件
├─ components.json             # shadcn/ui 配置
├─ package.json                # @databench/web
├─ tsconfig.json
├─ public/
└─ src/
   ├─ main.tsx                 # 入口:RouterProvider + QueryClientProvider + i18n + theme
   ├─ routes/                  # TanStack Router 文件式路由
   │  ├─ __root.tsx            # 根布局:导航 + 连接面板(对照旧 ConnectionPanel)
   │  ├─ index.tsx
   │  ├─ datasets.index.tsx    # DatasetsPage
   │  ├─ datasets.$ref.tsx     # DatasetDetailPage(含虚拟样本表)
   │  ├─ transforms.tsx        # TransformsPage
   │  ├─ recipes.tsx           # RecipePage
   │  ├─ lineage.$ref.tsx      # LineagePage(React Flow)
   │  ├─ ingest.tsx            # IngestPage(文件上传)
   │  └─ vocabularies.*.tsx    # 词表页(list/derive/new/detail)
   ├─ api/
   │  ├─ generated/schema.ts   # openapi-typescript 产物(gen:client)
   │  ├─ client.ts             # openapi-fetch 客户端(baseURL + Bearer header)
   │  ├─ config.ts             # 连接配置(API base)
   │  └─ hooks.ts              # 每端点的 TanStack Query hooks
   ├─ components/
   │  ├─ ui/                   # shadcn/ui 生成的基础组件(button/dialog/table/...)
   │  ├─ samples/              # VirtualizedSamples、SampleView(TanStack Virtual)
   │  ├─ lineage/              # React Flow DAG 组件
   │  └─ ...                   # ManifestView、TreeNode、LanguageSwitcher 等(对照旧 UI)
   ├─ lib/                     # cn() 等工具、格式化
   ├─ i18n/                    # i18next 初始化 + locales/{en,zh}.json
   └─ styles.css               # Tailwind 入口
test/                          # Vitest + Testing Library
```

> 待做:先做一份**前端功能清单**(逐页/逐交互梳理旧 `databench-ui`),再按清单逐页重写——防漏功能,与后端那套迁移法对齐。

---

## `packages/hashing`  [HASH-01..05]

```
src/
├─ index.ts                # 导出 canonicalJson, hashBytes, hashText, hashObj, hashUnordered, HASH_ALGO
├─ blake3.ts               # blake3(hash-wasm);digest(bytes)→hex                                      [HASH-01]
├─ canonical-json.ts       # 排序键/无空格/保留 unicode/非常规类型 String() 回退                       [HASH-02]
└─ digest.ts               # hashBytes/hashText(utf8)/hashObj/hashUnordered(sort→\n→hash,不去重)     [HASH-03/04/05]
test/
├─ canonical-json.golden.test.ts   # 与 Python 逐字节                                                  [闸门 G1]
└─ digest.test.ts
```

## `packages/schema`  [CORE-01..10, Manifest, Recipe 模型, 服务契约, 领域错误]

```
src/
├─ index.ts
├─ sample.ts               # ToolCall/Message/Rollout/Candidate/{SFT,Pref,RL,Traj}Sample + SampleSchema 判别联合 + parseSample [CORE-01..04,08,09]
├─ content.ts              # toContent() 确定性序列化器(**保留 null**)+ sampleId()                    [CORE-05/06/07]
├─ manifest.ts             # Manifest schema                                                           [DATASET-02]
├─ recipe.ts               # Recipe / RecipeSource schema                                              [RECIPE-01/02]
├─ contracts.ts            # Page/SamplesPage/TransformsPage/RefsPage、IngestSamplesRequest、TransformRunRequest、TransformInfo、RefInfo、MaterializeRequest、ErrorResponse [CONTRACT-01]
├─ constants.ts            # SCHEMA_VERSION、KIND、**COLUMNS**(单一来源)、MAX_PAGE_LIMIT=500、DEFAULT_PAGE_LIMIT=20、API_VERSION、MIN_CLIENT [CORE-10,SVC-04]
└─ errors.ts               # 领域错误类:NotFoundError/BadInputError/ValidationError/ConflictError      [ERR 映射源]
test/
└─ content.golden.test.ts  # 逐 kind content_dict null 保留                                            [闸门 G2]
```

## `packages/engine`  [DATASET-01·03..10, XFORM-01..03, 确定性工具]

```
src/
├─ index.ts
├─ dataset.ts              # Dataset 类:_build/fromSamples/fromFrame/toSamples/head/version/name/toPolars(clone)/toArrow [DATASET-04..09]
├─ row-digest.ts           # payload \x00 source \x00 meta \x00 signals;source||""                     [DATASET-03]
├─ parquet.ts              # toParquetBytes(ds) / fromParquet(bytes, manifest)(nodejs-polars);供 store 调 [DATASET-01 落盘]
├─ frame.ts                # nodejs-polars 包装 + DuckDB 适配选择(引擎下注/兜底)
├─ transform.ts            # Transform 类型 / buildParams / defineTransform(显式命名)                  [XFORM-01..03]
├─ rounding.ts             # bankersRound(half-to-even)                                                [RECIPE-05]
└─ loads.ts                # _loads(空容忍 JSON)                                                       [DATASET-10]
test/
├─ dataset.golden.test.ts  # Parquet 跨实现可读 + 空/非空 version 对拍                                  [闸门 G3]
```
> `COLUMNS` 从 `@databench/schema/constants` import,不在此重定义。

## `packages/io`  [IO-01..06, 导出整形 WS-10]

```
src/
├─ index.ts
├─ detect-kind.ts          # 判定短路顺序                                                              [IO-01]
├─ normalize.ts            # _asMessages/_asCompletion/_normalize                                       [IO-02/03/04]
├─ record-to-sample.ts     # recordToSample(记录自带 source 优先;强制写 kind)                          [IO-05]
├─ read-jsonl.ts           # 流式逐行;空行跳过;1-based 行号错误;source 默认文件名 stem                [IO-06]
└─ export-record.ts        # 按 kind 整形导出 dict(exclude_none;fmt 当前忽略)                          [WS-10]
test/
└─ io.golden.test.ts       # 四 kind 检测/简写/source/demo 5·3 行                                       [闸门 G4]
```

## `packages/ops`  [OPS-01..05](= 服务 transform 注册表来源 SVC-05)

```
src/
├─ index.ts                # BUILTIN_TRANSFORMS = { dedup, enrichLength, filterBySignal, sampleN } 注册表 [SVC-05]
├─ dedup.ts                # unique{subset:["id"],keep:"first",maintainOrder:true}                       [OPS-01]
├─ filter-by-signal.ts     # jsonPathMatch("$."+key)+cast(Float64,false);null 传播;params schema        [OPS-02]
├─ sample-n.ts             # n≥height 不动;否则 sample({n,seed});params schema                          [OPS-03]
├─ enrich-length.ts        # 非破坏合并;word_len 复刻 Python split()                                    [OPS-04]
└─ text.ts                 # _messageText/_sampleText(pref 只用 chosen;rl 只用 prompt)                  [OPS-05]
test/
└─ ops.golden.test.ts      # 采样确定性 + word_len + filter                                             [闸门 G5]
```

## `packages/store`  [STORE-01..05]

```
src/
├─ index.ts                # Store 接口 + createStore(config)
├─ store.ts                # Store 接口:write(ds)/read(version)/exists(version)
├─ keys.ts                 # objects/<version[:2]>/<version>.parquet|.manifest.json                     [STORE-02]
├─ s3-store.ts             # @aws-sdk/client-s3 实现 → GCS(生产)/ MinIO(本地);PUT 原子、双对象 exists [STORE-01/03/04/05]
└─ fs-store.ts             # 可选本地 fs 实现(测试用)
test/
└─ store.golden.test.ts    # 与既有 bench/store 布局/幂等对拍                                            [闸门 G6]
```
> 读写 parquet 字节调 `@databench/engine` 的 `toParquetBytes`/`fromParquet`;store 只管对象 IO + manifest 旁文件。

## `packages/catalog`  [CATALOG-01..12]  — Prisma,仅依赖 Prisma

```
src/
├─ index.ts                # Catalog 类导出
├─ client.ts               # Prisma client 单例 + driver adapter(@prisma/adapter-pg)接线
├─ catalog.ts              # registerDataset/getDataset/recordRun/findRun/runsProducing/setRef/getRef/listRefs/resolve [CATALOG-02..09,11]
└─ lineage.ts              # 递归 lineage:WITH RECURSIVE 经 $queryRaw(Prisma 无原生递归 CTE)            [CATALOG-06 支撑 WS-08]
test/
└─ catalog.golden.test.ts  # 三种 upsert 各自语义 + resolve 三态                                        [闸门 G7]
```
> Prisma schema/migrations 在**根 `prisma/`**(见下);三种 upsert:`createMany({skipDuplicates})` / `upsert`(DO UPDATE)/ `upsert`,**逐表复刻**。

## `packages/workspace`  [WS-01..13, RECIPE-03..05]

```
src/
├─ index.ts                # Workspace 类导出
├─ workspace.ts            # open/addSamples/addJsonl/add/get/run/materialize/lineage/export/_persist/_coerce [WS-01..13]
├─ mix.ts                  # mix(配方混合)+ _sourceCount                                                [RECIPE-04/05]
├─ fingerprint.ts          # Recipe.fingerprint                                                          [RECIPE-03]
└─ cache-key.ts            # run/materialize 的 cache_key 构造(hashObj,键集逐字一致)                   [WS-05/06]
test/
├─ run.golden.test.ts          # 缓存命中不新增 run、version 同                                          [闸门 G8]
└─ materialize.golden.test.ts  # 可复现 + 银行家舍入 + 0 权重退化 + lineage 结构                          [闸门 G8]
```
> `lineage()` 解析 ref→version 后调 `catalog.lineage`,并把输出整形成与 Python `_lineage` **逐字段一致**(version/name/num_rows/produced_by/inputs/cycle)。

## `tooling/openapi-export`  [CONTRACT-02]

```
src/
└─ index.ts                # 启动 createApp() → getOpenAPIDocument() → 确定性 JSON(sorted keys/indent2/末尾 newline);默认覆盖写、`--check` 比对 exit1
```

---

## 根目录与基础设施

```
databench/
├─ prisma/
│  ├─ schema.prisma         # datasets/runs/refs model(@@map snake_case 表/列)                          [CATALOG-01]
│  └─ migrations/
├─ docker-compose.yml       # 本地:postgres + minio                                                    [ADR-0005]
├─ pnpm-workspace.yaml      # apps/* packages/* tooling/*
├─ turbo.json               # 管线:build/lint/typecheck/test/openapi:check + 依赖图缓存
├─ biome.json               # lint + format 单一配置                                                    [ADR-0004]
├─ tsconfig.base.json       # 全包继承的 TS 基线(strict + exactOptionalPropertyTypes 等)               [conventions §2]
├─ lefthook.yml             # pre-commit 跑 Biome
├─ .nvmrc                   # node 22
├─ .env.example             # 全量环境变量(见 conventions §7)
├─ .github/workflows/ci.yml # lint/typecheck/vitest/golden/openapi --check                              [ADR-0004]
└─ package.json             # 根:engines.node>=22、scripts 走 turbo
```

---

## 本文做的几处「归位」决定(与纯照搬 Python 略有出入,如要改说一声)

1. **导出整形 `_export_record`(WS-10)→ 放 `packages/io`**(io 同时负责格式「进」与「出」);`workspace.export()` 只编排(取数据 → 逐样本 io 整形 → 流式)。
2. **Parquet 编解码 → 放 `packages/engine`**(engine 拥有 frame);`store` 只管对象 IO,调 engine 的 `toParquetBytes`/`fromParquet`。
3. **`COLUMNS` 常量 → 单一放 `packages/schema/constants.ts`**;engine/store 引用,避免两份漂移。
4. **领域错误类 → `packages/schema/errors.ts`**;`catalog` 不抛领域错误(返回 `null`/数据,保持只依赖 Prisma),NotFound 由 `store` 抛、`apps/api` 映射。
5. **递归 lineage 的 `WITH RECURSIVE` → `packages/catalog/lineage.ts`**(`$queryRaw`);`workspace` 负责把结果整形成与 Python 一致的 DAG 输出结构。
6. **分页/meta 常量(MAX_PAGE_LIMIT 等)→ `packages/schema/constants.ts`** 单一来源,`apps/api` 与前端共用同值。
