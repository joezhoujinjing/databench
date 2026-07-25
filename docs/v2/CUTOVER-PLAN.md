# Databench v2 产品切换实施计划

- **状态:** 已接受并实施完成——owner 于 2026-07-24 采用第三版视觉稿并授权实施；
  R0-R5 于 2026-07-25 全部过闸门
- **日期:** 2026-07-24
- **决策者:** owner
- **规范依赖:** [ADR 0013](../decisions/0013-v2-product-cutover-and-v1-retirement.md)、
  [产品切换技术方案](PRODUCT-CUTOVER-TECHNICAL-DESIGN.md)
- **施工纪律:** 一个 Step 一个 PR；当前 Step 过 gate 后再进入下一步

## 1. 目标与边界

本计划把已验证的 v2 纵向链路提升为唯一产品面，再从调用方到基础包退役 v1。Web 产品路由
无版本化；REST、对象布局、数据库表和内部类型继续保留稳定的 v2 协议命名。

代码切换与不可逆数据清理严格分离。任何 Step 都不得在启动、普通请求或隐式 migration 中删除
已有 v1 Postgres 行或对象。

## 2. Step 与 Gate

| Step | 单 PR 目标 | 主要落点 | Gate |
|---|---|---|---|
| R0 | 接受 ADR、技术方案、视觉稿与覆盖矩阵 | `docs/decisions`, `docs/v2` | 文档链接、路由与退役边界一致 |
| R1 | Web 单壳、无版本路由、产品文案与浏览器 E2E | `apps/web` | 一级导航仅三项；无版本 URL 可直接刷新；设计 QA 通过 |
| R2 | CLI 默认 v2；删除 v1 Web/API/CLI 可达面 | `apps/{web,api,cli}`, OpenAPI | OpenAPI 无 `/v1`；help 无 v1 命令；v2 lifecycle 通过 |
| R3 | 按依赖方向删除 v1 领域实现与 parity golden | `packages/*`, tests | exports 无 v1 surface；全量 v2 tests 通过 |
| R4 | 显式数据库迁移与对象清理工具/runbook | `prisma`, maintenance tooling, docs | dry-run 清单与 digest；operator 确认；v2 audit 前后一致 |
| R5 | v2-only 最终 gate、文档与离线包验证 | 全仓 | lint/typecheck/test/openapi/真实依赖/浏览器/离线 smoke 全绿 |

R0-R5 不改变 `V16`、`V17` 的真实状态，也不宣称尚未完成的 recovery/security/capacity gate。

## 3. R1 当前施工范围

R1 只完成产品 UI 切换：

- `/datasets`、`/ingest`、`/transforms` 直接复用现有 v2 页面；
- 数据集详情、记录、血缘和导出改用无版本 Web URL；
- Root shell 统一使用 `PostTrainingV2Gate`；
- 删除第二层 v2 导航与用户可见的 v1/v2 版本文案；
- v1 Recipe、Vocabularies、旧 lineage index 与旧 v1 页面从 route tree 移除，因而不可达；
- v1 Web 源文件和后端/CLI/领域实现暂不物理删除，留给 R2/R3，避免跨 Step 扩大回归面。

R1 不修改 `/v2` REST API，也不修改 v2 identity、schema、layout、对象 key 或数据库表。

## 4. R1 Gate

- `pnpm --filter @databench/web test`
- `pnpm --filter @databench/web typecheck`
- `pnpm --filter @databench/web build`
- `pnpm v2:status:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm openapi:check`
- 真实浏览器验证 `/datasets`、筛选、导入、转换、详情上下文链接、直接刷新与窄屏布局
- 项目根 `design-qa.md` 对照第三版视觉稿，最终结果必须为 `passed`

## 5. 删除与数据安全顺序

后续退役按 Web/API/CLI → Workspace → Ops/IO/Store/Catalog → Schema/Engine/Hashing 的调用方向
推进。R4 前只停止 v1 读写并生成清单，不删除持久化数据；R4 的实际删除必须由 operator 使用精确
清单 digest 显式确认，并证明对象匹配不会触及 `objects/v2/`。

R4 的标准操作入口与故障恢复见
[V1-RETIREMENT-RUNBOOK.md](V1-RETIREMENT-RUNBOOK.md)。非空 v1 表的 forward migration
没有 preflight approval 时必须 fail-closed；对象工具只接受 parser 验证的精确 key，不提供
prefix delete。
