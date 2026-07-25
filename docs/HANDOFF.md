# databench-ts 实现交接

## 当前事实

- 主产品已按 ADR 0013 切换为 v2-only。
- 产品切换 R0-R5 已完成；最终全仓、真实依赖、浏览器与离线发布 gate 均已通过。
- v2 V0-V15 已完成；V16 recovery/security 与 V17 capacity/release gate 未完成。
- Web 与 CLI 不带版本；REST、Postgres、对象 key 与内部类型继续保留 v2 稳定命名。
- v1 产品面、runtime、领域代码和已确认的本地持久化数据已删除。
- R4 maintenance tool、forward migration 和 runbook保留，供其他安装环境显式退役。
- 公共云 API 托管平台 D3 未决定；不得擅自进入 S22。ADR 0012 离线单机发布是独立通道。

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
- 离线静态检查和实际 lifecycle smoke

R5 已完成并只更新了产品切换状态，没有改变 V16/V17。

## 本地运行

```bash
docker compose up -d
pnpm install
pnpm dev
```

当前本地依赖默认由 `docker-compose.yml` 提供 Postgres + MinIO。真实依赖测试必须使用独立
test schema；不要重置 public catalog。
