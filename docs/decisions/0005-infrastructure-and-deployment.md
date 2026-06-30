# ADR 0005 — 基础设施与部署

- **状态:** Accepted(API 托管平台待定)
- **日期:** 2026-06-29
- **决策人:** owner
- **依赖:** ADR-0003(两个有状态服务:Postgres + 对象存储)

## 决策

| 组件 | 选择 | 备注 |
|---|---|---|
| Postgres(catalog) | **Supabase** | 托管 PG;Prisma 走标准 PG 连接(`@prisma/adapter-pg`)。本地用 docker 的 `postgres` |
| 对象存储(Parquet 数据面) | **Google Cloud Storage (GCS)** | 通过 **S3 兼容(XML)接口** + HMAC 密钥访问,代码用 `@aws-sdk/client-s3` 一套打 GCS(生产)与 MinIO(本地);藏在 `Store` 接口后 |
| 本地对象存储 | **MinIO**(docker) | S3 兼容,与 GCS 同一套 client 代码 |
| CI | **GitHub Actions** | lint/typecheck/vitest/golden 对拍/openapi `--check` |
| **API 托管平台** | **待定(TBD)** | 见下「约束」 |
| 前端 `apps/web`(静态 SPA) | 任意静态托管 | Vite 产物,CDN/对象存储/任意平台均可,与 API 解耦 |

## API 托管的硬约束(定平台时必须满足)
API 进程内含 **N-API 原生插件**(nodejs-polars、`@duckdb/node-api`)且可能做 **大内存 / out-of-core materialize** 与 **流式 NDJSON 导出**。因此:
- **必须是长驻容器 + 支持原生二进制 + 可配较大内存/CPU**;
- **排除** Vercel / Cloudflare Workers / 边缘 Serverless / 纯 FaaS(原生插件 + 长计算不适配)。
- GCP 侧自然候选:**Cloud Run**(容器,支持原生二进制、请求可达 60min、可配内存)或 **GKE**;通用候选:Fly.io / Railway / AWS ECS-Fargate。**留待 owner 决定**。

## S3 兼容访问 GCS 的注意点
- 用 GCS 的 **Interoperability(HMAC)** 凭据 + XML/S3 endpoint;`@aws-sdk/client-s3` 设 `endpoint` + `forcePathStyle`。
- GCS 的 S3 兼容覆盖常见对象操作(PUT/GET/HEAD/LIST),满足 `STORE-01..05`(内容寻址 write-once、`exists` 双对象、原子 PUT);若日后用到 S3 兼容未覆盖的特性,可在 `Store` 接口后换 `@google-cloud/storage` 原生实现,**不影响调用方**。

## 环境变量(契约,见 conventions.md「配置」)
`DATABASE_URL`(Supabase)、`S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`(GCS HMAC,本地指向 MinIO)、`DATABENCH_CORS_ORIGINS`、`PORT`。

## 后果
- 跨供应商(库 Supabase + 数据 GCS)但二者都标准协议(PG / S3),代码零锁定。
- 本地一条 `docker-compose`(`postgres` + `minio`)即可全功能跑,无需连云。
- API 平台未定不阻塞开发:容器化(Dockerfile)即可,平台是后续部署配置。
