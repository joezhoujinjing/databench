# Databench docs

## 当前实现先读

- [HANDOFF.md](HANDOFF.md) — 当前状态、红线与已完成的 R5 gate。
- [v2/STATUS.md](v2/STATUS.md) — v2 与产品切换的真实进度。
- [architecture.md](architecture.md) — 当前 v2-only 系统形态。
- [project-structure.md](project-structure.md) — 包边界与依赖 DAG。
- [directory-layout.md](directory-layout.md) — 当前文件落点。
- [conventions.md](conventions.md) — 确定性、契约、测试与协作规则。
- [tech-stack.md](tech-stack.md) — 当前已实现技术栈。

## MCP Agent 导入（实施中）

- [ADR 0015](decisions/0015-internal-agent-mcp-ingest.md) — API 内嵌 MCP、四个 tools、匿名
  可信内网与 agent 自主编排。
- [ADR 0016](decisions/0016-canonical-draft-raw-adapter-identity.md) — canonical draft 的
  deterministic IDs、claims 与重放语义。
- [MCP 技术方案](mcp/TECHNICAL-DESIGN.md) — 已接受的最终边界与验收。
- [MCP 实施计划](mcp/PLAN.md) / [状态](mcp/STATUS.md) — M0-M2 的真实进度。
- [目标 agent 预检](mcp/AGENT-PREFLIGHT.md) — Excel 与 MCP/HTTP 客户端能力证据。

MCP M1a canonical staged runtime 已通过 GM1a 但默认关闭；原始 Excel/CSV 闭环仍待
M1b1-M1b3，不得把分支代码或 accepted 文档当成当前已发布产品入口。

## 产品切换

- [ADR 0013](decisions/0013-v2-product-cutover-and-v1-retirement.md) — v2 成为唯一
  产品面，v1 退役。
- [产品切换技术方案](v2/PRODUCT-CUTOVER-TECHNICAL-DESIGN.md) — 边界与验收标准。
- [产品切换实施计划](v2/CUTOVER-PLAN.md) — R0-R5。
- [v1 退役 runbook](v2/V1-RETIREMENT-RUNBOOK.md) — R4 显式数据清理流程；只用于
  尚未执行退役的安装环境。

## v2 协议

- [ADR 0009](decisions/0009-canonical-post-training-record-v2.md) — canonical
  post-training record。
- [ADR 0011](decisions/0011-identity-hashing-versioning-v2.md) — identity、
  hashing 与 versioning。
- [v2 技术方案](v2/TECHNICAL-DESIGN.md) — 已接受协议设计。
- [v2 实施计划](v2/PLAN.md) — V0-V17；V16/V17 仍保持真实未完成状态。
- [扩展 schema 参考](v2/canonical-record-extended-profile.md) — 非规范候选。

## 部署

- [ADR 0012](decisions/0012-offline-single-host-deployment.md) — Ubuntu 单机离线部署。
- [离线发布方案](deployment/offline-single-host-plan.zh-CN.md)。
- [阿里云 ECS 中文 runbook](deployment/aliyun-ecs.zh-CN.md)。
- [Aliyun ECS English runbook](deployment/aliyun-ecs.md)。

公共云 API 托管平台仍受 D3 owner 决策门约束。离线通道是独立授权，不会自动完成
V16/V17。

## 历史记录

以下内容保留用于解释迁移与已接受决策，不代表当前 runtime surface：

- `docs/migration/` — Python → TypeScript 与 v1 parity 的完成记录；
- `docs/feasibility/` — 初始可行性评估；
- `docs/reviews/`、`docs/spikes/` — 当时的 review 和实验；
- [ADR 0010](decisions/0010-python-processing-service-grpc.md) 与
  `docs/processing/` — 已退役 Processing 方案的历史记录；
- ADR 0001-0008 — 重写阶段的基础决策，其中被后续 ADR 修订的部分以后续 ADR 为准。

旧参考仓库 `~/Desktop/databench/` 始终只读。
