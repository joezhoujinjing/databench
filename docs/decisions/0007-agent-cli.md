# ADR 0007 — agent-facing CLI (`apps/cli`)

- **Status:** Accepted — **方案 A(Thick / 进程内)+ 零依赖 `parseArgs` + JSON 默认**(owner 确认 2026-07-02)
- **Date:** 2026-07-02
- **Context question raised by:** owner("把后端能力抽象成 CLI,后面给 agent 使用")

## Context

后端能力目前只有一个对外表面 `apps/api`(Hono HTTP,给前端 `apps/web`)。
但业务逻辑并不在 API 里——每个路由本质是一行 `getWorkspace(ctx).xxx(...)`,
真正的能力核心是 `packages/workspace` 的 `Workspace` 类(HTTP 无关、引擎无关)。

我们要把同一批能力再暴露一个**面向 agent 的 CLI 表面**。按现有分层规则
(`apps/* → workspace + schema`,见 `docs/project-structure.md` L5),CLI 不是
重写,而是**新增一个与 `apps/api` 平级的第二适配器 `apps/cli`**,把子命令映射到
同一批 `Workspace` 方法。

## Options

### 接入方式

- **A. Thick(进程内,推荐)**:CLI 直接 `Workspace.open()`,自带 Prisma + S3
  连接。不依赖 API 是否在跑,不与未决的 D3(API 托管平台)决策耦合,现在即可落地。
  自包含,适合本地 / CI / 批处理 agent,与旧 Python CLI 语义一致。
- **B. Thin(HTTP 客户端)**:CLI 调用已在跑的 `apps/api`,复用已生成的
  `openapi-fetch` client。适合远程 / 沙箱 agent(只要一个 URL),但依赖 API 常驻,
  与 D3 决策耦合。
- **C. Hybrid**:默认 Thin,`--local` 走 Thick。覆盖两类 agent,但实现量最大。

### 参数解析

- **零依赖 `node:util` 的 `parseArgs`(推荐)**:Node 22 内置,不新增运行时依赖,
  符合"不擅自加库"纪律;自写薄薄的 noun→verb 路由器。
- 新增 `commander` / `citty`:开箱即用但引入运行时依赖。

## Decision

- **接入方式:A(Thick)。** 直接架在能力真源上,与 D3 解耦,可立即落地;等 D3
  定了、API 有稳定托管,再把 B 作为 `--remote` 选项补上不迟。
- **参数解析:零依赖 `parseArgs`。** 不新增运行时依赖。
- **默认输出:JSON(一个明确例外)。** 成功结果 → stdout;错误信封 → stderr(复用
  API 的 `ErrorResponseSchema`,agent 在 CLI 与 HTTP 两条路上拿到同一种错误信封)。
  **唯一例外:`dataset export` 不带 `--out` 时向 stdout 输出原始 NDJSON 流**(带
  `--out` 则写文件并打印 `{path}` JSON)。每个 verb 在 `help --json` 里声明自己的
  `output` 类型(`json` / `ndjson`),由 router 用 `STREAMED` 哨兵区分,不再用
  `undefined` 复用返回通道。
- **退出码**:镜像 `apps/api/src/middleware/error.ts` 的 status 映射——
  `0` ok / `1` internal / `2` bad_input(含用法错误)/ `3` not_found /
  `4` conflict / `5` validation。二者共用 `@databench/schema` 的 `classifyError`
  单一真源(见下)。

## 锁定边界(必须遵守)

1. **CLI 是第二适配器,不是第二套后端。** `apps/cli` **只依赖**
   `@databench/workspace` + `@databench/schema`,**禁止**直连
   `store`/`catalog`/`engine`/`ops`/`io`;否则 API 与 CLI 必然各自漂移。健康探针等
   需要触达后端的能力,一律加在 `Workspace` 上(如 `Workspace.check()`),CLI 只调用。
2. **`--samples` 吃 API 的 request body 形状**(`{samples,name?,message?}`),也兼容裸
   samples 数组;走 `parseJsonValue` 保留数值词素以保哈希 parity。`name`/`message`
   优先级:**CLI flag > body > null**。
3. **单一真源。** 错误分类(`classifyError`)、错误信封字段、能力位
   (`serviceCapabilities`)、分页边界(`PaginationQuerySchema`)只在
   `@databench/schema` 定义一次,API(→HTTP status)与 CLI(→退出码)各自映射。
4. **`help --json` 是可执行契约**,不只是目录:每个 verb 输出 positionals、每个 flag 的
   `type`/`short`/`multiple`、以及 `output`(`json`/`ndjson`)。
5. **`meta doctor`** 主动探测 DB + 对象存储,返回 `{database,store}`(各 `{ok,error?}`),
   让 agent 能区分"环境坏了(DB 连不上 / migration 没跑 / bucket 不存在)"与"ref 不存在"。

## Parity 约束(硬规则 #2 —— 确定性纪律)

CLI 与 API 是同一个 `Workspace` 核心的两个薄适配器,必须产生**逐字节一致**的版本
哈希 / 血缘。为此每条命令**镜像其 API 对应端点的确切解析路径**,复用同一批 helper:

| 输入 | 必须用 |
|---|---|
| samples ingest(内嵌 open dict) | `parseJsonValue`(保留数值词素)→ `IngestSamplesRequestSchema` |
| JSONL ingest | `Workspace.addJsonl` → io `readJsonl`(已过 S20 parity) |
| recipe | `JSON.parse` → `Workspace.materialize`(内部 `parseRecipe`)——与 `apps/api/routes/recipes.ts` 一致 |
| transform params | `JSON.parse`(顶层 typed params,与 API `context.req.valid('json')` 一致) |
| 词表 | `parseVocabularyInput` / `ExtractorSchema` |

**禁止**在哈希输入路径上用裸 `JSON.parse` 处理内嵌 open dict 的载荷(会把 `1.0`
折成 `1`,破坏 parity)。

## Consequences

- 新增 `apps/cli`(`@databench/cli`),依赖仅 `@databench/workspace` + `@databench/schema`
  + `zod`;禁止 import `apps/api`、禁止直连 store/catalog/engine/ops/io(同 API 红线)。
- 能力位已单一真源:`getCapabilities()`(API)与 CLI `meta capabilities` 都调
  `@databench/schema` 的 `serviceCapabilities()`。错误分类同理走 `classifyError()`。
- 健康探针加在核心:`Store.ping()`(可选,HeadBucket)+ `Workspace.check()`,
  CLI `meta doctor` 与将来的 API `/health` 均可复用,CLI 不越过 workspace 边界。
- 遗留复刻:`EXTRACTOR_PRESETS`(brand/unit)仍在 `apps/api` 词表路由;C2 迁入 CLI 时
  一并上提到 `@databench/schema`/`workspace` 消除重复。
- 高度可逆:CLI 是纯适配器,能力核心不变;将来加 B(`--remote`)或换解析库都是
  受限改动。
