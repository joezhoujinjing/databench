# Databench MCP 实施状态

> 唯一实施计划见 [PLAN.md](PLAN.md)。状态符号：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞。

<!-- mcp-status
current_step: M1b3
last_completed_step: M1b2
mcp_runtime_enabled: false
auth_mode: none-implemented-disabled
offline_release_authorized: scoped-after-GM2
-->

## 当前检查点

- **开发分支:** `feat/mcp-excel-import`
- **代码基线:** `main@258bacaf673a0395c8fb3d769bd4bf6f78dcde56`
- **当前 Step:** M1b3——M1b2 已过 GM1b2，下一步实现 draft import 与真实 Excel 闭环
- **MCP runtime:** M1b2 staged canonical + canonical-draft preview/materialize runtime 与 `auth_mode=none` 已实现；部署中保持关闭
- **V16/V17:** 状态不变，仍未完成
- **发布边界:** owner 只授权 GM2 后进入 ADR 0012 的匿名可信内网离线通道；未授权公网部署

## Step 状态

| Step | 目标 | 状态 | PR / 提交 | Gate | 备注 |
|---|---|---|---|---|---|
| M0 | ADR、计划、真实 Excel 与 agent preflight | ✅ | `7dcfb5f` | GM0 | 规范、preflight、全仓 gates 与独立 review 通过 |
| M1a | Canonical MCP/companion 纵切 | ✅ | `2f562e7` | GM1a | staged runtime 完成，MCP 配置保持 disabled |
| M1b1 | Canonical draft contract 与 no-write preview | ✅ | `a57217c` | GM1b1 | draft import/materialize 仍不可用 |
| M1b2 | Deterministic identity 与 materialize | ✅ | 本次提交 | GM1b2 | draft import 仍不可用 |
| M1b3 | Draft import 与真实 Excel 闭环 | ⬜ | | GM1b3 | 下一 accepted Step |
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

## M1b1 Gate 记录

- 新增唯一通用 `canonical-draft-jsonl-v1`：覆盖 SFT/DPO/RLVR、tools/trajectory、signals、
  preferences、verification、lineage、tags 与 extra；agent 不提供 record/candidate/signal/preference
  managed IDs，只使用 record 内的 zero-based index refs。
- `contract_get(name="canonical-draft-import")` 发布 input JSON Schema、不可投影的 canonical rules、
  SFT/DPO/RLVR examples 与 runtime limits；JSON Schema input projection 允许省略 defaults，preview
  output 返回完全物化的 strict draft。
- `data_process_prepare` 只增加 `canonical-draft-jsonl-v1 + validate-preview`；`tools/list` 不提前暴露
  draft import、materialize 或 expected digest，initialize instructions 明确 contract name 与 upload format
  的映射。
- draft reader 复用 canonical reader 的 bounded streaming/raw JSON 路径，保持 exact uploaded-byte
  BLAKE3、1-based physical line、0-based non-blank data row、BOM/duplicate-key/fatal UTF-8、CRLF/LF、
  nesting/record/transport limits 与 abort 语义一致。
- `V2Workspace.previewCanonicalDraftJsonl()` 只在内存中使用 branded synthetic preview IDs 运行完整
  canonical + `V2Dataset` invariants；响应不返回 synthetic IDs，并通过 Store/Catalog/namespace/claim/
  object/ref no-access/no-write 断言与 whole-record response budget 测试。
- Schema 209 tests、IO 45 tests、Workspace 100 tests 与 API 80 tests 通过；真实 Postgres + MinIO API
  suite 10 files、82 tests 通过，其中 MCP 生命周期已加入 draft contract example → no-write preview。
- `git diff --check`、`pnpm lint`（364 files）、`pnpm build`（13 tasks）、`pnpm typecheck`
  （22 tasks）、`pnpm test`（22 tasks）、`pnpm openapi:check`、`pnpm v2:status:check`、
  `pnpm offline:check` 与 `pnpm peers check` 通过；OpenAPI 保持不变。
- 两路独立 review 按架构正确性与 agent UX/MVP 简洁性检查；修复 dangling JSON Schema refs、input
  defaults/required 与 exact side-effect output projection、synthetic ID type/error leakage、lineage self-parent
  collision、contract rule 缺口与 contract name/format 歧义后无剩余 P0/P1/P2。

## M1b2 Gate 记录

- 新增 import-scoped deterministic identity planner：source-root/artifact-row root、candidate generation
  run、signal/preference event key、owner skeleton、index/supersession refs 与完整 canonical record；claim
  顺序固定为 root → 全部 candidates → 全部 signals → preferences，immutable replay/conflict 复用现有
  ADR 0011 claim compare。
- SFT/DPO/RLVR fixed vectors 锁定 exact raw digest、owner JCS、run/event keys、entity IDs、claim/request
  digests、record digest、dataset version 与 canonical JSONL bytes；另覆盖 LF/CRLF、leading blank、无尾 LF
  与多 candidate + signal claim order。独立 Python `jcs` + `blake3` 实现复算全部字段和 bytes：SFT
  `00ef670d117f475e546ecc0a3fc8bfbd28b3f4dd0dd1c107088388cad2ed3b4f` / version
  `fbcad2d79efa5756588c9ae91d5fe94180c8a959bb0fba09a5b9be8fba7cc65e` / 4 claims；DPO
  `6e7a61e65d1f64e92733f18e91efa4e3232d4be0660a5133fc8b317e304a5612` / version
  `54ad8339649b669e4698b594305421d31148602053eb502e3b96e29b4256cbee` / 5 claims；RLVR
  `a8f8e5d8589fc86b586d7eb7b60cf27ccf92db5ff7568b59bd023a2c66b70fa0` / version
  `a197f0153feb74b16098a0bd713bff5bc28b3715dad5b8601a09cb4b56211a57` / 4 claims。
- materializer 使用 bounded raw/output 两遍 spool、exact-byte digest、reservation admission/resize 与
  fsync/seal；expected digest 在 namespace/claim 前失败，完整 canonical output seal 后才写 claims，
  claims 全部成功后才返回单次 stream。显式 output lease、partial cancel、首次读取前 abort、完全未读
  HTTP timeout、response 构造失败与 temp reservation resize/release 竞态均有清理覆盖；不发布
  dataset/ref/object，允许按 ADR 留下已成功的 orphan immutable claims。
- `data_process_prepare` 只新增 draft `materialize-jsonl`，返回
  `response_kind="canonical-jsonl"` 与 `side_effects=["identity_claims"]`；agent-visible instructions
  明确 exact-byte guard、流式保存和 response-loss replay。Draft `import-dataset` 仍未暴露。
- Store 80 tests（2 skipped）、Schema 209 tests、Workspace 110 tests（4 skipped）、API 81 tests
  （2 skipped）通过；真实 Postgres + MinIO API suite 10 files、83 tests 通过，覆盖 preview → expected
  digest materialize、canonical IDs、exact replay 与 digest mismatch fail-before-write。
- `git diff --check`、`pnpm lint`（370 files）、`pnpm build`（13 tasks）、`pnpm typecheck`
  （22 tasks）、`pnpm test`（22 tasks）、`pnpm openapi:check`（11 tasks）、`pnpm v2:status:check`、
  `pnpm offline:check` 与 `pnpm peers check` 通过；OpenAPI 保持不变。两路独立 review 按架构正确性
  与 agent UX/MVP 简洁性复核，修复未消费 output lease、claim order、temp reservation 竞态与在线
  retry guidance 后无剩余 P0/P1/P2/P3，未引入 draft import、认证、审批状态机或独立服务。

## 状态更新规则

1. 只在当前 Step 的实现、测试、独立 review 与 repo gates 全部通过后标记 ✅；
2. 每次更新记录 commit/PR、测试命令、真实依赖结果和剩余风险；
3. M1b3 前不得宣称“Excel 直接导入可用”，M2 前不得在部署中默认或显式启用 MCP；
4. MCP 局部 gate 不得写成 GV16、GV-final，也不得修改 `docs/v2/STATUS.md` 的 V16/V17 状态。
