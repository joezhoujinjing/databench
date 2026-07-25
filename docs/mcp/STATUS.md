# Databench MCP 实施状态

> 唯一实施计划见 [PLAN.md](PLAN.md)。状态符号：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞。

<!-- mcp-status
current_step: M1b1
last_completed_step: M1a
mcp_runtime_enabled: false
auth_mode: none-implemented-disabled
offline_release_authorized: scoped-after-GM2
-->

## 当前检查点

- **开发分支:** `feat/mcp-excel-import`
- **代码基线:** `main@258bacaf673a0395c8fb3d769bd4bf6f78dcde56`
- **当前 Step:** M1b1——M1a 已过 GM1a，下一步增加 canonical draft contract 与 no-write preview
- **MCP runtime:** M1a staged canonical runtime 与 `auth_mode=none` 已实现；部署中保持关闭
- **V16/V17:** 状态不变，仍未完成
- **发布边界:** owner 只授权 GM2 后进入 ADR 0012 的匿名可信内网离线通道；未授权公网部署

## Step 状态

| Step | 目标 | 状态 | PR / 提交 | Gate | 备注 |
|---|---|---|---|---|---|
| M0 | ADR、计划、真实 Excel 与 agent preflight | ✅ | `7dcfb5f` | GM0 | 规范、preflight、全仓 gates 与独立 review 通过 |
| M1a | Canonical MCP/companion 纵切 | ✅ | 本次提交 | GM1a | staged runtime 完成，MCP 配置保持 disabled |
| M1b1 | Canonical draft contract 与 no-write preview | 🔄 | | GM1b1 | 下一 accepted Step |
| M1b2 | Deterministic identity 与 materialize | ⬜ | | GM1b2 | |
| M1b3 | Draft import 与真实 Excel 闭环 | ⬜ | | GM1b3 | |
| M2 | 内网离线启用与 scoped release gate | ⬜ | | GM2 | 不完成 V16/V17 |

## M0 Gate 记录

- Owner 于 2026-07-25 接受 ADR 0015、ADR 0016 与 MCP 技术方案，并授权开始实施。
- 从 clean `main` 创建独立 worktree 和 `feat/mcp-excel-import`，未触碰原 dirty worktree。
- 真实工作簿只读预检结果：`Sheet1`、`A1:C500`、表头 `SPU_ID` / `COMBINED_GOODS_INFO` /
  `ATTR_JSON`、499 条非空数据记录；全部 `SPU_ID` 都是 `10037`；原文件未修改或导出。
- Agent capability 证据与剩余 M1a/M2 smoke 见 [AGENT-PREFLIGHT.md](AGENT-PREFLIGHT.md)。
- 本地 harness 完成 agent-owned temporary JSONL create→33-byte streamed PUT→22-byte streamed
  GET→delete；真实 MCP/companion 与实际内网 URL 分别保留为 GM1a/GM2 blocking smoke。
- 两组独立 review 找到并修复：M0/M1a 联调循环依赖、HTTP streaming 证据不足、event producer 与
  ADR 0011 schema 冲突，以及 canonical preview 绕过 Workspace 的风险；最终无剩余 blocker。
- Markdown link/fence/trailing-whitespace、`git diff --check`、`pnpm v2:status:check`、
  `pnpm lint`（347 files）、`pnpm build`（13 tasks）、`pnpm typecheck`（22 tasks）、`pnpm test`
  （22 tasks）、`pnpm openapi:check`（11 tasks）、`pnpm offline:check` 与 `pnpm peers check` 通过。
  新 worktree 首次 OpenAPI 检查发现 Prisma generated client 尚未完整落盘；执行仓库标准
  `pnpm exec prisma generate` 后复检通过，无代码或契约变更。

## M1a Gate 记录

- 官方 `@modelcontextprotocol/sdk@1.29.0` 精确锁定；现有 Hono API 内嵌 stateless JSON
  Streamable HTTP，MCP 默认关闭，启用时只接受显式 `auth_mode=none` 与可信 public base。
- `contract_get`、`data_process_prepare`、`dataset_show`、
  `dataset_export_canonical_prepare` 四个 tool 已可用；`tools/list` 只声明 canonical branches，
  input/output 的 SDK-compatible strict schemas 均来自 `@databench/schema`。
- companion file URL 使用 256-bit 一次性 token、`ready → active → delete`、TTL、全局 active
  上限、429 retry、idle/total timeout 与 abort cleanup；错误和 404 不回显 bearer token。
- `V2Workspace.previewCanonicalJsonl()` 完整校验 exact raw bytes、保留输入顺序、按 whole-record
  response budget 截断，且通过 Store/Catalog no-write 测试；canonical import/show/export 复用现有
  Workspace 能力。
- 官方 MCP Client 的 initialize/list/call 测试与当前 Codex 目标开发 agent 的实际 TCP smoke 均通过；
  同一 agent 完成四工具、10-chunk streamed PUT preview/import、show 与 response-reader GET export，
  得到 dataset version
  `8e3d6141d4c74c102cf52cbde258ce01c76ea4e02fc4b70c0e02f220913b14a8`，export 1362 bytes。
- 真实 Postgres + MinIO lifecycle 通过：preview → import → show → canonical export → idempotent
  reimport；API suite 10 files、82 tests 全绿。
- 失败路径覆盖 body/response limit、strict Origin/CORS、单次与并发 token、429 不消费 ready token、
  pending body abort、upload idle timeout、export total timeout/backpressure/client cancel 与安全 tool
  error normalization。
- `git diff --check`、`pnpm lint`、`pnpm build`、`pnpm typecheck`、`pnpm test`、
  `pnpm openapi:check`、`pnpm v2:status:check`、`pnpm offline:check` 与 `pnpm peers check` 通过；
  OpenAPI 保持不变。
- 三路独立 review 按架构、安全/agent UX 与 MVP 简洁性检查；发现的问题均在 M1a 内修复，
  没有引入认证平台、审批状态机、独立 MCP 服务或 Excel 服务端解析。

## 状态更新规则

1. 只在当前 Step 的实现、测试、独立 review 与 repo gates 全部通过后标记 ✅；
2. 每次更新记录 commit/PR、测试命令、真实依赖结果和剩余风险；
3. M1b3 前不得宣称“Excel 直接导入可用”，M2 前不得在部署中默认或显式启用 MCP；
4. MCP 局部 gate 不得写成 GV16、GV-final，也不得修改 `docs/v2/STATUS.md` 的 V16/V17 状态。
