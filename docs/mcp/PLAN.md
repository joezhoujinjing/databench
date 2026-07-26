# Databench MCP 实施计划

- **状态:** 已接受——owner 于 2026-07-25 授权从 `main` 开始实施
- **日期:** 2026-07-25
- **代码基线:** `main@258bacaf673a0395c8fb3d769bd4bf6f78dcde56`
- **规范依赖:** [ADR 0015](../decisions/0015-internal-agent-mcp-ingest.md)、
  [ADR 0016](../decisions/0016-canonical-draft-raw-adapter-identity.md)、
  [MCP 技术方案](TECHNICAL-DESIGN.md)
- **实施纪律:** 一个 accepted Step 一个 commit/PR；当前 gate 通过后再进入下一步

## 1. 目标

首期交付一个简单、真实可用的内网闭环：用户把 Excel/CSV 给 code agent，并用自然语言说明
“导入 Databench”“先给我看看”或“只生成 JSONL”。Agent 自行读取表格、获取当前契约、生成临时
canonical draft，并按用户意图直接导入、按需 preview/修改，或只交付 canonical JSONL。

服务端不读取 Excel，不运行模型，也不建立人工审批状态机。它负责发布契约、严格校验、分配稳定
IDs、发布 immutable dataset，以及通过一次性 URL 流式收发文件。

## 2. 全程硬约束

1. MCP/API 只经 `@databench/workspace` 与 `@databench/schema` 触达数据。
2. Tool、companion response 与 canonical draft schema 只在 `@databench/schema` 定义。
3. 文件 bytes 不进入 MCP JSON；process/export 只使用一次性绝对 PUT/GET URL。
4. Preview 无持久化写入；draft materialize 会写 immutable identity claims，但不发布
   dataset/ref/object；draft import 成功后才发布 dataset，首期不更新 ref。
5. Identity 序列化只走 `@databench/hashing` RFC 8785 v2 具名路径，并锁 fixed vectors。
6. MCP 默认关闭；M2 前不得在部署配置中启用。
7. 匿名模式只用于防火墙限定的可信内网；不得把本计划解释成公网授权。
8. 本计划不启动或完成 V16/V17，也不改变公共云 D3 状态。

## 3. 里程碑

```text
M0 决策、计划与 agent preflight
 ↓
M1a canonical MCP 纵切
 ↓
M1b1 canonical draft contract + no-write preview
 ↓
M1b2 deterministic identity + materialize
 ↓
M1b3 draft import + 真实 Excel 闭环
 ↓
M2 内网离线启用与发布 gate
```

| Step | 单次交付 | 主要落点 | Gate |
|---|---|---|---|
| M0 | ADR、计划、状态、真实 Excel 与 agent 能力预检 | `docs/mcp`、`docs/decisions` | GM0 |
| M1a | canonical MCP/companion transport 纵切 | `schema`、`workspace`、`apps/api` | GM1a |
| M1b1 | 通用 draft contract 与无写 preview | `schema`、`workspace`、`apps/api` | GM1b1 |
| M1b2 | draft identity、claims 与 materialize | `hashing`、`schema`、`workspace`、`apps/api` | GM1b2 |
| M1b3 | draft import 与 Excel 生命周期 | `workspace`、`apps/api`、tests | GM1b3 |
| M2 | 匿名内网离线启用、runbook 与发布验证 | `apps/api`、`deploy/offline`、docs | GM2 |

## 4. Step 交付与 Gate

### M0 — 决策、计划与 Agent Preflight

交付：

- 接受 ADR 0015、ADR 0016 与详细技术方案；
- 建立本计划、`STATUS.md` 和 `AGENT-PREFLIGHT.md`；
- 用真实 `电缆_DEMO_20260723.xlsx` 只读验证 sheet、used range、headers 与 499 条数据；
- 验证目标 agent 具备 `.xlsx` 读取、临时 JSONL 创建/删除和流式 HTTP PUT/GET 基础能力；
- 把 Streamable HTTP MCP 与 companion URL 的端到端能力列为 M1a 后立即执行的同一目标 agent
  smoke，M2 再在实际内网部署环境复验；
- 更新 repo 导航，不声明任何尚未实现的 runtime surface。

> **GM0:** 规范文件状态一致；真实 Excel 预检通过；未发现 agent 接入能力硬阻塞；Markdown、
> `git diff --check`、`pnpm v2:status:check` 与全仓现有 gates 通过；独立 review 无 blocker。

### M1a — MCP 与 Canonical 纵切

交付：

- 精确锁定官方 TypeScript MCP SDK，在现有 Hono API 内挂 stateless Streamable HTTP `POST /mcp`；
- MCP disabled-by-default；配置 strict parse，`AUTH_MODE` 非 `none` 时 fail closed；
- 四个最终 tool name 都可见，但 input union 只暴露当步已实现能力：canonical contract、canonical
  preview/import、exact dataset show 与 canonical export；
- `data_process_prepare` 和 `dataset_export_canonical_prepare` 返回可信 public base 构造的一次性
  PUT/GET URL；
- registry 上限、TTL、原子 ready→active→delete、两条 active file operation、无队列、timeout、
  abort、Origin 与安全 header/error 行为；
- canonical preview 完整校验但不写，canonical import 复用 `addJsonl()`，export 复用现有 lazy
  canonical stream；
- `/v2` OpenAPI bytes 保持不变。

> **GM1a:** initialize/tools/list/tools/call、405、body limit、Origin、token 并发/过期/单次使用、
> 429 retry、abort、preview 无写、canonical import→show→export→reimport 的真实 Postgres + MinIO
> 生命周期全部通过；目标 agent 完成真实 MCP + PUT/GET smoke；全仓 gates 通过。

### M1b1 — Canonical Draft Contract 与 Preview

交付：

- `CanonicalDraftRecordV1Schema`、index refs、defaults 和 strict tool/result schemas；
- `contract_get` 增加 draft schema、rules、SFT/DPO/RLVR examples 与 effective limits；
- `data_process_prepare` 只新增 draft `validate-preview` branch；
- exact raw-byte digest、BOM/blank/data-row 规则、synthetic IDs 与全部 canonical invariants；
- preview response 1 MiB whole-record budget，且不访问 namespace/claim 或发布任何数据。

> **GM1b1:** 正反 contract fixtures、全文件 fail-fast validation、digest/row boundaries、preview
> truncation、无写证明与全仓 gates 通过。

### M1b2 — Canonical Draft Identity 与 Materialize

交付：

- 先提交 ADR 0016 要求的 SFT/DPO/RLVR fixed vectors；
- import-scoped allocator、owner skeleton、claim plan/order 与 exact replay；
- draft `materialize-jsonl` branch 和 expected digest fail-before-write；
- bounded raw/output spool、temp admission、fsync/seal-before-response、abort/cleanup；
- materialize 只写 immutable claims，不发布 dataset/ref/object。

> **GM1b2:** 所有 expected bytes/hex 经独立 RFC 8785/BLAKE3 实现复核；claim replay、冲突、
> reorder、materialize→canonical bytes、容量与中断路径通过；全仓 gates 通过。

### M1b3 — Draft Import 与 Excel 闭环

交付：

- draft `import-dataset` branch 与 `addCanonicalDraftJsonl()` dataset publish；
- materialize 后 import 的 claims replay 与相同 canonical IDs/version；
- 电缆 fixture 的 direct import、preview/修改后导入、JSONL-only 三条自动生命周期；
- 使用真实 `.xlsx` 和目标 agent 的人工验收；M1 最终 tool surface 在本 gate 后冻结。

> **GM1b3:** 用户只给 Excel 和自然语言指令即可获得 exact dataset version 或 canonical JSONL；
> invalid input 不发布 dataset，首期不更新 ref；真实 Postgres + MinIO 与全仓 gates 通过。

### M2 — 内网离线启用

交付：

- 离线配置显式启用 `DATABENCH_MCP_ENABLED=true`、`AUTH_MODE=none` 与可信 public base；
- Caddy `/api/*` 前缀、access-log token 脱敏、匿名全权限警告和 operator runbook；
- 断网镜像、安装、升级、回滚、重启后 token 失效、capacity/timeout/cleanup smoke；
- 实际内网 agent 重跑 Excel→import/show/export 生命周期。

> **GM2:** scoped security/capacity/offline gate 全绿后，按 owner 的范围化例外授权发布到 ADR 0012
> 内网离线通道；仍不得宣称 V16/V17 或公网 production readiness 完成。

## 5. 每步共同验证

按改动比例至少运行，并在 `STATUS.md` 记录真实结果：

```bash
git diff --check
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm openapi:check
pnpm v2:status:check
pnpm offline:check
```

涉及 Workspace/Store/Catalog/API lifecycle 的 Step 必须额外运行真实 Postgres + MinIO suites。每个
Step 在提交前做独立 code/design review；发现 blocker 时在当前 Step 修复，不把问题推给下一步。
