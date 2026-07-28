# databench-ts 实现交接

## 当前事实

- 主产品已按 ADR 0013 切换为 v2-only。
- 产品切换 R0-R5 已完成；最终全仓、真实依赖、浏览器与离线发布 gate 均已通过。
- v2 V0-V15 已完成；V16 recovery/security 与 V17 capacity/release gate 未完成。
- Web 与 CLI 不带版本；REST、Postgres、对象 key 与内部类型继续保留 v2 稳定命名。
- v1 产品面、runtime、领域代码和已确认的本地持久化数据已删除。
- R4 maintenance tool、forward migration 和 runbook保留，供其他安装环境显式退役。
- 公共云 API 托管平台 D3 未决定；不得擅自进入 S22。ADR 0012 离线单机发布是独立通道。
- MCP Excel/CSV agent 导入 M0-M3 已完成；当前进度见
  `docs/mcp/STATUS.md`。通用 runtime 仍
  disabled-by-default；ADR 0012 离线包会在 operator 显式提供稳定、agent 可达的 `/api` public
  base 后，以 `auth_mode=none` 在可信内网启用。该 scoped gate 不授权公网部署，也不改变 V16/V17。
- ADR 0012 的 2026-07-27 窄修订要求完整离线包包含 CPU-only Python Worker；六镜像构建、
  Worker → API → Web 生命周期、`basic-clean@1` smoke 和旧五镜像回滚兼容已在
  `feat/offline-worker` 实现并通过本地 `linux/amd64` Compose gate，仍待真实 Ubuntu 22.04
  amd64 断网验收。
- ADR 0017 EvalScope 原生 UI 集成已接受并开始实施。E0 已固定 upstream commit、183 个 Web source
  文件、60 个能力、default-deny API 路由、五类 Benchmark fixture 和 Plotly 证据；E1 已完成
  `evalscope-general-qa@1.0.0` 三种 reference profile、确定性 JSONL、eligibility/fidelity 与真实 exact
  Dataset export；E2 已完成 `evaluation_runs_v2`、canonical create digest、exact Dataset binding、状态机和
  `/v2/evaluation-runs*` REST。E3 已实现 pinned backend-only image、same-origin exact gateway、Databench
  Dataset source preparation、task/reconcile/model-egress/active-content 安全边界，并通过真实 BLEU/ROUGE
  evaluation 与 stop callback 闭环；E4 已增加完整 `/evaluations/*` lazy route tree、Databench 主/次导航、
  exact Zod client、无路径 public config、opaque route key、scoped tokens、完整中英文词典和可访问基础组件。
  EvalScope 的 Databench-owned Python provider source 位于 `workers/evalscope`，与内部 gRPC 的
  `workers/python` 同级；`deploy/evalscope` 只保留镜像、upstream patch/vendor 和 gateway 部署资产。
  E5 已完成 Evaluation/Performance 表单、Benchmark autocomplete、Databench exact Dataset source、
  progress/log/stop/reload task monitor 与安全报告入口，并通过真实 Dataset/native/performance/cancel/
  provider-interrupt/same-ID gate；E6 已完成 Reports catalogue、Overview/Details/Predictions、逐样本导航、
  legacy/structured/AgentTrace 展示、富内容渲染与 configured source refresh；E7 已完成 Dashboard、
  Evaluation Compare、Performance catalogue/detail/runs/requests/compare、五类 Benchmark 目录/详情和安全
  Viewer。60 个 capability 已全部 green，其中 58 个 target capability 已实现、2 个为 Databench shell
  exclusion，锁定 React 基线的完整 UI 功能迁移 gate 已关闭。Owner 于 2026-07-28 明确手机版竖屏不属于
  当前 Web gate，并明确
  offline release boundary 是 digest-pinned prebuilt image：目标机断网安装/运行仍是 E9 gate，fresh
  `docker build --network=none` 不要求，仓库不携带 wheelhouse/apt mirror。E7 已关闭，下一步是 E8 结果归档。
- ADR 0018 ms-swift 集成已于 2026-07-28 接受，采用完整原生 Gradio iframe 的最小桥接方案：首期只建设
  Studio Session、exact Dataset export、GPU/Session workspace 与 LoRA Model Artifact import，不先建设
  Training Run/Attempt 或接管原生 callback。实施从 EvalScope E7 complete commit `25931d6` 建立独立
  `feat/swift-studio-integration` 分支；当前处于 S0，runtime 与 `/training` 均未实现、保持 disabled。

权威进度见 `docs/v2/STATUS.md`。历史 migration status 只记录已完成的重写过程。

## 接手顺序

1. 读根 `AGENTS.md`。
2. 读 `docs/v2/STATUS.md`。
3. 若处理产品切换，读 ADR 0013、`docs/v2/PRODUCT-CUTOVER-TECHNICAL-DESIGN.md`、
   `docs/v2/CUTOVER-PLAN.md`。
4. 若处理 v2 协议，读 ADR 0009/0011、`docs/v2/TECHNICAL-DESIGN.md`、
   `docs/v2/PLAN.md`。
5. 对照 `docs/project-structure.md`、`docs/directory-layout.md`、
   `docs/conventions.md`。
6. 若处理 MCP/agent 导入，依次读 ADR 0015、ADR 0016、`docs/mcp/TECHNICAL-DESIGN.md`、
   `docs/mcp/PLAN.md` 与 `docs/mcp/STATUS.md`。
7. 若处理离线发布或 Worker，读 ADR 0010/0012、`docs/processing/TECHNICAL_DESIGN.md` 和
   `docs/deployment/offline-single-host-plan.zh-CN.md`。
8. 若处理 EvalScope，依次读 ADR 0017、`docs/evalscope/TECHNICAL-DESIGN.md`、
   `docs/evalscope/PLAN.md`、`docs/evalscope/STATUS.md` 和 E0 evidence。
9. 若处理 ms-swift，依次读 ADR 0018、`docs/swift/TECHNICAL-DESIGN.md`、
   `docs/swift/PLAN.md` 与 `docs/swift/STATUS.md`。不要把后续 Training control plane 提前塞入 S0-S4。

不要用旧 v1 migration inventory 覆盖当前实现。

## 当前产品面

```text
Web
  /datasets
  /datasets/:ref
  /datasets/:ref/records/:recordId
  /ingest
  /transforms
  /lineage/:ref
  /export/:ref
  /evaluations
  /evaluations/tasks
  /evaluations/reports
  /evaluations/reports/:reportKey
  /evaluations/compare
  /evaluations/performance
  /evaluations/performance/:performanceKey
  /evaluations/performance/compare
  /evaluations/benchmarks
  /evaluations/viewer

CLI
  databench dataset ingest|show|records|audit|export
  databench converter list|show
  databench transform list|run
  databench ref list|show|move
  databench lineage show

REST
  /health /version /capabilities
  /v2/*
```

`/recipe`、`/vocabularies`、v1 API/CLI 和版本选择 UI 不应恢复。`/v2`、`*_v2`、
`objects/v2/` 与 `record-json-v1` 是兼容性标识，不属于待清理产品入口。

## 红线

1. 参与 identity 的序列化只走 `@databench/hashing` 的 RFC 8785 v2 实现。
2. API/CLI 只经 Workspace + Schema 触达数据。
3. 样本 payload 不进 Postgres。
4. artifacts/manifests immutable；Refs 使用 CAS。
5. Web wire type 只来自 generated OpenAPI client。
6. 不修改旧仓库 `~/Desktop/databench/`。
7. 普通启动、请求和 migration wrapper 不隐式删除对象。
8. V16/V17 未过不宣称 production readiness。

## R4 数据基线

2026-07-25 本地 R4 完成：

- v1 tables：0；
- 删除 251 个 v1 objects；
- 删除 4 个 invalid pre-schema-amendment v2 datasets 及 8 个相关 objects；
- 删除 12 个 unregistered orphan v2 objects；
- 保留 20 个已审计 v2 snapshots/layouts、40 个精确 objects、9 个 refs；
- 最终 baseline digest：
  `e69b1e92d42f2b8401ff580d0b32e6a1694537e8846ac88395e80c81f4d7439a`。

R4 manifest 在本机 ignored maintenance 目录中。标准操作仍以
`docs/v2/V1-RETIREMENT-RUNBOOK.md` 为准。

## R5 Definition of Done

必须全部为绿：

- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm openapi:check`
- `pnpm v2:status:check`
- `pnpm peers check`
- `git diff --check`
- 真实 Postgres + MinIO Store/Workspace/API/CLI suites
- 浏览器 v2-only 全主流程、直接刷新、404、console、窄屏
- 离线静态检查和实际 lifecycle smoke；当前 Worker 修订还需重新执行六镜像 gate

R5 已完成并只更新了产品切换状态，没有改变 V16/V17。

## 本地运行

```bash
docker compose up -d
pnpm install
pnpm dev
```

当前本地依赖默认由 `docker-compose.yml` 提供 Postgres + MinIO。真实依赖测试必须使用独立
test schema；不要重置 public catalog。
