# V17 Final Gate 与发布准备报告

> 执行日期：2026-08-05
>
> 基线分支：`feat/model-registry-mr8`
>
> 结论：V0-V17 实施完成，GV-final 通过；本结论不替代 GPU、GE9 Ubuntu 断网目标机或公共云 D3 决策门。

## 1. 交付结论

V17 没有新增业务协议或持久化格式。它关闭以下发布准备项：

1. 将 package DAG、内部 deep import、API/CLI Workspace 边界和 PostgreSQL payload 红线变成 CI gate；
2. 同步当前用户文档、`.env.example`、OpenAPI/generated client 与 capability 说明；
3. 复跑真实 PostgreSQL + MinIO 全仓生命周期、V16 并发/恢复矩阵和 Model Registry forward migration；
4. 在当前 Engine/layout 基线上复跑 `darwin-arm64` 与 `linux-x64-gnu` 的 8 个 Parquet raw-byte fixtures；
5. 按 ADR 0013 用 R4/R5 v1 retirement evidence 取代原计划已经失效的 v1/v2 coexistence runtime 报告。

## 2. 可执行架构红线

新增 `pnpm architecture:check` 和 `pnpm architecture:test`，并在 CI `validate` job 的构建/测试前执行。

| 红线 | 自动检查 |
|---|---|
| package DAG | 13 个 workspace 逐项校验允许的 `@databench/*` edge 和 `workspace:*` protocol |
| 禁止 deep import | 扫描 apps/packages/tooling/scripts/workers 的源码 import specifier |
| API/CLI 数据边界 | 只允许 Workspace + Schema，另拒绝 Prisma/Postgres/object-store client 直连 |
| PG payload | 24 个 Prisma model、19 个 migration；JSON metadata 使用显式 allowlist，Record 表保持 locator-only |

六个 checker tests（1 个仓库基线 + 5 个负向场景）覆盖非法 DAG/版本、deep import、Prisma 绕行、
未审 JSON、Record payload 与 migration-only JSON column。当前扫描结果为 13 workspaces、583 source
files、24 Prisma models、19 migrations，全部通过。

## 3. 契约、环境与 capability

- `pnpm openapi:check` 验证 Zod → Hono OpenAPI → `openapi.json` → Web generated client 无漂移；V17
  不改变 wire contract，所以没有生成文件 diff。
- `.env.example` 已补齐 Model Repository、三来源 Deployment operator、endpoint policy/credential
  projection、分段 timeout，以及 disabled-by-default 的 Worker、EvalScope、Swift Studio 和 MCP 配置。
- 当前 `/capabilities` 返回 `api_version=v2`、`min_client=0.1.0`、`post_training_v2.enabled=true`，并声明
  `canonical-jsonl`、`evalscope-general-qa`、`ms-swift`、`trl-dpo`、`trl-grpo-rlvr`、`trl-sft` 六个
  converter。启用状态来自 owner 2026-07-24 的显式决定，不再增加旧 capability env 开关。
- Model Registry capability 只覆盖已实现的本地/可信内网范围；Repository 默认 `offline`，endpoint
  policy 或 credential projection 缺失时 fail closed。

## 4. 生命周期与恢复证据

`RUN_MINIO_STORE_TESTS=true pnpm turbo run test --force` 在独立 test schema 和真实 MinIO 上执行，22/22
tasks 通过且没有使用 Turbo cache。关键结果：

- Store 94/94；Workspace 205/205，另有 10 个需要显式 Python Worker 的 gated tests skipped；
- Catalog 66/66；API 177/177；CLI 20/20；Web 206/206；
- 双 API 实例对同一 Dataset/layout 的并发 ingest 均成功并收敛到相同 version/artifact/layout；
- ingest → read/cache → audit → transform → lineage → inspect → export、Evaluation、MCP import、Swift
  Session/Artifact 与 Model Registry 路径均使用真实 PostgreSQL + MinIO；
- V16 的 10 项 fault/security/capacity matrix 和 detached canonical parent-ref round-trip 在本次全仓测试中执行；
- Model Registry forward migration 保留 legacy Dataset/Evaluation/Namespace/Ref rows，并验证新增表、FK、
  append-only 与 source/deployment/evaluation 约束。

浏览器证据使用本报告基线的 API `127.0.0.1:8010` 与 Web `127.0.0.1:5180`：

- `/models`、三来源 registration、六个 Model detail Tabs、Version、Deployment 与 lineage 可用；
- desktop 和 390 CSS px 窄屏无横向溢出，窄屏 `clientWidth=scrollWidth=382`；
- Model health 汇总显示 `3/3 健康`，console 为 0 error / 0 warning；
- `/training` 和 `/evaluations/tasks` 在各自可选 runtime 未启动时显示明确 unavailable 状态，不产生页面错误。

## 5. 双平台 Parquet matrix

同一组 committed raw bytes 在当前 `record-json-v1` Engine/layout 上通过：

| ABI | 环境 | 结果 |
|---|---|---|
| `darwin-arm64` | 本机 Node 22 | 8/8，64.51s |
| `linux-x64-gnu` | `node:22-bookworm`、`--platform linux/amd64`、fresh frozen install | 8/8，207.98s |

两边都覆盖 empty、Unicode、低/高 payload vocabulary、1.1 MiB record，以及 65,535/65,536/65,537
row-group 边界。`.github/workflows/ci.yml` 继续保留同样的 required 双平台 matrix 和聚合 gate。

## 6. ADR 0013 后的 v1 retirement 报告

V17 原计划要求 v1/v2 coexistence 报告，但 ADR 0013 后 v1 runtime、Web/API/CLI surface 和领域实现已经退役，
恢复 coexistence 会违反 accepted 产品决策。对应证据改为：

- R4 在 operator 确认后精确删除 v1 tables/objects，并保留审计后的 v2 snapshots/objects/refs；基线 digest
  为 `e69b1e92d42f2b8401ff580d0b32e6a1694537e8846ac88395e80c81f4d7439a`；
- 当前 public schema 的 `datasets/runs/refs/vocabularies/vocab_refs` 表数为 0；`GET /v1/datasets` 返回 404；
- R5 已通过 v2-only 全仓、浏览器、真实依赖和离线 lifecycle gate；
- `tooling/v1-retirement`、forward migration 与 runbook 只为尚未执行 R4 的安装环境保留，不进入产品 runtime；
- V17 没有修改 Prisma schema/migration、对象 key、v2 wire contract、identity/layout fixed bytes 或本地数据。

## 7. GV-final 执行记录

以下命令全部通过：

- `pnpm architecture:check`、`pnpm architecture:test`；
- `pnpm lint`（696 files）、`pnpm build`（13/13）、`pnpm typecheck`（22/22）；
- `RUN_MINIO_STORE_TESTS=true pnpm turbo run test --force`（22/22，0 cached）；
- `pnpm openapi:check`、`pnpm v2:status:check`、`pnpm models:status:check`、`pnpm peers check`；
- `pnpm exec prisma validate`、`pnpm models:migration:check`；
- `pnpm test:evalscope:python`、`pnpm evalscope:parity:check`；
- `pnpm offline:check`、`git diff --check`；
- `darwin-arm64` / `linux-x64-gnu` Parquet matrix 8/8 + 8/8。

## 8. 仍然独立未完成的事项

GV-final 只关闭 v2 V0-V17 实施，不宣称整个产品已经 production ready。以下状态保持不变：

- GE9 真实 Ubuntu 22.04 amd64 目标机断网 install/eval/report/upgrade/rollback 由 owner 后验；
- Swift/Model 的真实 NVIDIA LoRA、stop、Adapter Infer 与 GPU evaluation gate deferred；
- 公共云 API 托管平台 D3、public-network activation、hosted secret backend 与 Hugging Face runtime 未授权；
- 不把本机 Docker、CPU compatibility 或 Model Registry non-GPU contract 伪装成上述证据。
