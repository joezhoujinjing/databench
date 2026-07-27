# Databench MCP 实施状态

> 唯一实施计划见 [PLAN.md](PLAN.md)。状态符号：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞。

<!-- mcp-status
current_step: complete
last_completed_step: M3
mcp_runtime_enabled: offline-explicit
auth_mode: none
offline_release_authorized: adr0012-scoped
-->

## 当前检查点

- **开发分支:** `feat/mcp-required-ref`
- **代码基线:** `main@c1f22d7`
- **当前 Step:** M0-M3 与 GM0-GM3 全部完成
- **MCP runtime:** 通用配置保持 disabled-by-default；ADR 0012 离线包只在 operator 显式提供
  agent 可达的稳定 `/api` public base 后，以 `auth_mode=none` 启用完整 canonical +
  canonical-draft preview/materialize/import surface
- **V16/V17:** 状态不变，仍未完成
- **发布边界:** 已按 owner 范围化授权进入 ADR 0012 匿名可信内网离线通道；未授权公网部署
- **网络口径:** owner 于 2026-07-27 明确整个不暴露公网的内网可以作为可信边界；主机级 CIDR/
  iptables 是可选加固，不是安装前置条件

## Step 状态

| Step | 目标 | 状态 | PR / 提交 | Gate | 备注 |
|---|---|---|---|---|---|
| M0 | ADR、计划、真实 Excel 与 agent preflight | ✅ | `7dcfb5f` | GM0 | 规范、preflight、全仓 gates 与独立 review 通过 |
| M1a | Canonical MCP/companion 纵切 | ✅ | `2f562e7` | GM1a | staged runtime 完成，MCP 配置保持 disabled |
| M1b1 | Canonical draft contract 与 no-write preview | ✅ | `a57217c` | GM1b1 | draft import/materialize 仍不可用 |
| M1b2 | Deterministic identity 与 materialize | ✅ | `8cf9aeb` | GM1b2 | draft import 仍不可用 |
| M1b3 | Draft import 与真实 Excel 闭环 | ✅ | `e82c398` | GM1b3 | staged full surface，部署仍 disabled |
| M2 | 内网离线启用与 scoped release gate | ✅ | 本次提交 | GM2 | 只授权 ADR 0012，不完成 V16/V17 |
| M3 | Dataset import 必填 CAS ref | ✅ | 当前分支 | GM3 | 保持四工具；成功导入后 Web 可立即发现 ref |

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

## M1b3 Gate 记录

> 以下为 M1b3 当时 `ref=null` 的历史验收事实；owner 后续接受的 M3 会修订当前公开 import
> contract，不回写或伪造既有 gate 结果。

- `V2Workspace.addCanonicalDraftJsonl()` 只组合现有 materialize → `addJsonl()` 路径；成功、失败与
  dispose 均释放 materialization lease，固定 `ref=null`。materialize 后 import 会重放 claims，并在
  同一 Workspace namespace 内得到相同 canonical IDs 与 dataset version。
- `data_process_prepare` 完成 draft `import-dataset` branch，返回
  `side_effects=["identity_claims","dataset_publish"]`；draft import/materialize 均支持 exact raw-byte
  `expected_input_digest` guard。首期六分支 tool surface 已冻结，preview 仍是 agent 按意图选择的
  no-write 工具，不是审批状态机。
- 真实电缆 fixture 锁定 499 行、716,367 bytes draft 及 BLAKE3
  `76d426e6157e3e1ba3fc86676973b80238ecc38f9c5c3bb595111d6702d1bd0b`。真实 Postgres + MinIO
  自动生命周期覆盖：无 preview 直接导入；移除 system 后 preview 3 条并携带 digest 导入；只
  materialize JSONL 后确认 dataset not found，再导入 canonical JSONL；另覆盖 digest mismatch、
  later-invalid no-publish、no-ref 与 export/reimport 同 version。
- 当前 Codex 目标开发 agent 从原始 `.xlsx` 重新生成临时 draft，经真实 MCP Client、API TCP
  `http://127.0.0.1:18080` 与 companion streamed PUT/GET 完成三条人工生命周期。Direct import
  version 为 `9e59b4edfd42e3c24fe4e03c698717c034734377931091dfef5f20e3891a101c`；修改后 import
  version 为 `4bee431343b9c15cf6bd460f17dd380b88d058f78051b880f157b5d3f269686d`；JSONL-only
  prospective version 为 `61ce13c4c731f3254b51c6f62ed0d5564bf7abda81aa2a9871d23751a629fb17`，并确认未发布
  dataset。两个 import 的 `ref_update` 均为 `not_requested`。
- 人工验收后停止临时 API、删除独立 test schema 与 4 个精确 MinIO objects，并将 agent-owned
  临时目录移入废纸篓；原 workbook digest 验收前后不变，未覆盖用户已有 Desktop JSONL。完整证据
  见 [AGENT-PREFLIGHT.md](AGENT-PREFLIGHT.md)。
- Workspace 112 passed / 4 skipped、Schema 209 passed；API 普通 suite 82 passed / 3 skipped，真实
  PostgreSQL + MinIO suite 85/85 passed。`git diff --check`、`pnpm lint`（371 files）、`pnpm build`
  （13 tasks）、`pnpm typecheck`（22 tasks）、`pnpm test`（22 tasks）、`pnpm openapi:check`
  （11 tasks）、`pnpm v2:status:check`、`pnpm offline:check` 与 `pnpm peers check` 全部通过；
  OpenAPI 保持不变。
- 两路独立 review 按架构正确性与 agent UX/MVP 简洁性复核；补强 invalid no-publish、base draft
  digest guard 与 import/materialize response-loss replay 文案后，无剩余 P0/P1/P2/P3。未引入认证、
  权限、独立 MCP 服务、服务端 Excel parser 或审批状态机；M2 前部署仍保持 disabled。

## M2 Gate 记录

- 离线包新增独立 `/etc/databench/mcp.env`，只接受显式 `enabled=true`、`auth_mode=none`、稳定且
  agent 可达的 `http(s)://DNS-or-IPv4[:port]/api`；配置原子创建为 `root:root 0600`。Origin allowlist
  逐项执行与 API 一致的 trim/空项忽略及 exact lowercase HTTP(S) origin 校验；install/首次 upgrade
  不猜 Host、网卡或容器名，rollback 在停止服务前按 current/target Compose fail-fast 校验配置。
- Caddy 保持单端口 `/api/*` proxy，access log 未启用；runtime filter 删除 `request.uri`。离线 smoke
  在正常 companion 错误、完整 MCP lifecycle 与 API upstream 不可达的 502 后捕获 Web/API 全量日志，
  `proc_*` 和 `exp_*` 双 sentinel 均未出现；失败 trap 会恢复 API，恢复后的 health 与后续请求通过。
- 官方 MCP SDK 离线 smoke 覆盖 direct import、preview/修改后 import、JSONL-only、canonical
  export/reimport、一次性 URL、429 + `Retry-After` 后复用同一 URL、stalled upload abort cleanup 与
  temp spool 回收；部署预检同时检查根盘与 Databench 数据盘至少 4 GiB 可用空间。
- 目标开发 agent 从原始电缆 Excel 只读生成 499 条 draft，经真实 LAN public base
  `http://192.168.10.171:18081/api` 和 Caddy 完成三种意图：direct
  `94f0dd5cbff04bfef6a64107d3e702b578d7786d8e2bb1907085f00cbabf7bc3`、修改后
  `f774bed7eee170795ff58e68cea1b304c6e740de6253d435f964c6af0215b138`、JSONL-only prospective
  `b8236876fa42d8e3a7d2ecd7a19114a90a7e969dcadcb55cb72aa6aba31d8a69`；后者确认未发布。
- API restart 后旧 process URL 返回 400，重新 prepare 后恢复 499 条 preview。真实离线管理
  harness 完成 pre-MCP 0.5.0 → M2 0.6.0 首次升级与回滚：升级创建配置、备份、load、migration、
  MCP smoke 均通过；回滚后配置保留但旧 Compose 不读取，MCP 405 → 404，已导入 499 条数据仍可读。
- no-egress 验收使用 Docker `Internal=true` 网络；API 对 `example.com` 与 npm registry 均不可达，
  同网 agent 经 Caddy 的完整 MCP/companion lifecycle 仍通过。M2 验收时还验证了防火墙 allowlist；
  owner 于 2026-07-27 将其明确为可选纵深防御，而非安装前置。匿名全权限警告、三种 agent 意图与
  token/digest/replay 恢复规则已写入离线 runbook。
- `RUN_MINIO_STORE_TESTS=true pnpm test` 22/22 tasks 通过：Store 82、Workspace 116、API 86 tests
  全绿；全仓 lint/build/typecheck/test、OpenAPI、v2 status、offline、peer 与 diff gates 通过。两路
  独立 follow-up review 按 agent UX/MVP 与架构/安全复核后无剩余 P0/P1/P2/P3。
- 未引入认证、RBAC、skill、审批状态机、服务端 Excel parser、独立 MCP 服务或额外端口；公网仍
  禁止，V16/V17 与公共云 D3 状态不变。

## M3 Gate 记录

- canonical 与 canonical-draft `import-dataset` 都必填 `ref` 和 `expected_ref_version`，可选
  `message`；新 ref 传 `null`，更新已有 ref 传 exact 旧 version。Prepared result 回显完整 ref
  intent，side effects 分别固定为 `dataset_publish + ref_update` 与
  `identity_claims + dataset_publish + ref_update`；四个 tool 名称与数量不变。
- companion token 保存并在 PUT 时传递 ref/CAS/message；draft import 通过
  `materialize → addJsonl` 共享发布路径。Invalid draft、digest mismatch 不创建 ref；真实 499 行
  电缆生命周期覆盖新建 ref、exact-version 移动已有 ref、Web 列表所依赖的 ref 可发现性，以及
  canonical/draft 导入。
- 响应丢失后使用相同 bytes/ref/expected version/message 重试时，若 ref 仍指向同一 dataset 且
  message 相同则返回成功；message 不同或 target 已变化仍返回 `ref_conflict`，不放宽 CAS。
- Schema 212 tests、Workspace 普通 suite 145 passed / 15 skipped、API 普通 suite 88 passed /
  3 skipped；真实 PostgreSQL + MinIO 全仓 `RUN_MINIO_STORE_TESTS=true pnpm test` 22/22 tasks 通过，
  其中 Workspace 150 passed / 10 skipped、API 91/91 passed。首次真实 gate 发现 `main@c1f22d7`
  的 Worker integration fixture 未传新增的 result-ref nullable 字段；仅补齐两个显式 `null` 后，
  原失败测试和完整真实依赖 gate 均通过，生产 Worker 逻辑未改。
- `git diff --check`、`pnpm lint`、`pnpm build`、`pnpm typecheck`、`pnpm test`、
  `pnpm openapi:check`、`pnpm v2:status:check`、`pnpm offline:check` 与 `pnpm peers check` 全部通过；
  OpenAPI 保持不变。离线 MCP smoke 已加入必填 ref、新建/更新断言和同请求 response-loss replay。
- 文档保留 M1b3/M2 当时 `ref_update=not_requested` 的历史验收事实，并以 ADR 0015/0016 的 M3
  修订明确当前 contract；未增加认证、独立服务、ref tool、中文 display name 或审批状态机，
  V16/V17 与公共云 D3 状态不变。

## 状态更新规则

1. 只在当前 Step 的实现、测试、独立 review 与 repo gates 全部通过后标记 ✅；
2. 每次更新记录 commit/PR、测试命令、真实依赖结果和剩余风险；
3. 通用 MCP runtime 保持 disabled-by-default；只允许 ADR 0012 离线包按本记录显式启用；
4. MCP 局部 gate 不得写成 GV16、GV-final，也不得修改 `docs/v2/STATUS.md` 的 V16/V17 状态。
