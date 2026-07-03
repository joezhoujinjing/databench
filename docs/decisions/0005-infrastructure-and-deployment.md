# ADR 0005 — 基础设施与部署

- **状态:** Accepted(部署约束与 env 合同;对象存储选择已由 ADR-0008 更新)
- **日期:** 2026-06-29
- **决策人:** owner
- **依赖:** ADR-0003(两个有状态服务:Postgres + 对象存储)、ADR-0008(Aliyun OSS)

## 决策

| 组件 | 选择 | 备注 |
|---|---|---|
| Postgres(catalog) | **Postgres** | 托管 PG 供应商按部署环境选择;代码只要求标准 PG 连接(`@prisma/adapter-pg`)。本地用 docker 的 `postgres` |
| 对象存储(Parquet/Vocabulary 数据面) | **Aliyun OSS** | 通过原生 `ali-oss` SDK 访问;藏在 `Store` 接口后 |
| 本地对象存储 | **无本地 emulator** | 本地真实 IO 需要 OSS 凭据;测试默认注入内存 store |
| CI | **GitHub Actions** | lint/typecheck/vitest/golden 对拍/openapi `--check` |
| **API 托管平台** | **按部署环境新决策** | 见下「约束」;选型落地时更新本 ADR 或新增 ADR |
| 前端 `apps/web`(静态 SPA) | 任意静态托管 | Vite 产物,CDN/对象存储/任意平台均可,与 API 解耦 |

## API 托管的硬约束(定平台时必须满足)
API 进程内含 **N-API 原生插件**(nodejs-polars、`@duckdb/node-api`)且可能做 **大内存 / out-of-core materialize** 与 **流式 NDJSON 导出**。因此:
- **必须是长驻容器 + 支持原生二进制 + 可配较大内存/CPU**;
- **排除** Vercel / Cloudflare Workers / 边缘 Serverless / 纯 FaaS(原生插件 + 长计算不适配)。
- 平台选择需结合当前阿里云 OSS / 部署环境重新评估。旧 GCP 候选比较见 `migration/d3-api-hosting-brief.md`,但使用前必须刷新。

## Aliyun OSS 注意点
- 使用 bucket-scoped RAM 子账号凭据。
- `OSS_INTERNAL=true` 时优先走 VPC/internal endpoint,避免同云内网流量出公网。
- 应用不创建 bucket;bucket 预先创建,应用只读写对象并用 `getBucketInfo` 做 doctor probe。
- key layout 仍由 `Store` 保持稳定,调用方不感知 SDK。

## 环境变量(契约,见 conventions.md「配置」)
`DATABASE_URL`、`OSS_REGION`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、可选 `OSS_ENDPOINT` / `OSS_INTERNAL` / `OSS_SECURE`、`DATABENCH_CORS_ORIGINS`、`PORT`。

## 后果
- 对象存储锁定阿里云 OSS;如需第二云,新增 ADR。
- 本地一条 `docker-compose` 只跑 Postgres;真实对象存储 IO 需要 OSS 凭据。
- API 平台不写死在代码里:容器化(Dockerfile)即可,具体平台是部署配置与 ADR 事项。
