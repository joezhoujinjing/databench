# D3 API 托管平台决策简报

> 状态:供 owner 拍板,**不是 ADR**。S22 部署前必须先完成 D3。本文只整理约束和选项,不替 owner 选择平台。
> 当前日期:2026-06-30。云平台限制可能变化,实施前再以官方文档复核一次。

## 已锁上下文

- databench API 是长驻 Node/Hono 容器,进程内包含 `nodejs-polars`、`@duckdb/node-api` 等原生/N-API 依赖。
- 状态服务已锁定为 Supabase Postgres + GCS S3-compatible object storage;API 本身应保持 stateless。
- API 要支持较大内存/CPU、可能较长的 materialize/export 请求、NDJSON streaming。
- ADR-0005 已排除 Vercel / Cloudflare Workers / 边缘 Serverless / 纯 FaaS。
- S22 范围:API Dockerfile + API 部署 + web 静态部署 + Supabase/GCS secrets + CI/CD + 生产冒烟。

## 必须满足

| 约束 | 说明 |
|---|---|
| 长驻容器 | 支持自定义 Docker image,包含 Linux 原生二进制依赖。 |
| 可配资源 | 至少能按服务配置 CPU/内存,后续可上调以承载 Polars/DuckDB。 |
| 流式响应 | `/v1/datasets/{ref}/export` 是 NDJSON streaming,平台不能强制把响应整体缓冲为小对象。 |
| 较长请求 | 当前同步 API 需要容纳较长 ingest/materialize/export;若平台请求上限不足,必须拆成 job/worker。 |
| Secret 管理 | `DATABASE_URL`、`S3_*`、CORS origins 不进仓库,走平台 secrets/env。 |
| 静态 web | `apps/web` 是 Vite SPA,可独立放 CDN/静态托管。 |

## 候选项

### A. Google Cloud Run

适合:继续沿用 ADR-0005 的 GCP/GCS 方向,先用最少运维量把 API 容器化上线。

证据:
- Cloud Run service 请求 timeout 默认 5 分钟,可配置到 60 分钟: [Configure request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)。
- Cloud Run request limits 列出每请求最大 60 分钟;HTTP/1 response 在非 streaming 情况有 32 MiB 限制,使用 chunked/streaming 不适用该限制: [Cloud Run quotas](https://docs.cloud.google.com/run/quotas)。
- Cloud Run 接受自定义容器,要求 Linux 64-bit/amd64,服务容器监听 `0.0.0.0:$PORT`: [Container runtime contract](https://docs.cloud.google.com/run/docs/container-contract)。

实现影响:
- `apps/api/Dockerfile` 以 Node 22 linux/amd64 构建。
- API 监听 `PORT`,默认 8080 或平台注入值。
- 把 long-running 请求 timeout 配到 3600s;并确保操作幂等/可重试。
- 若将来出现超过 60 分钟的任务,再把 materialize/synthesis 拆到 Cloud Run Jobs/worker 或队列。

主要风险:
- 60 分钟是硬边界;超长任务不能继续塞在同步 HTTP handler。
- 文件系统是临时/内存语义,不要依赖本地持久化。
- 大对象导出必须保持 streaming。

### B. GKE Autopilot / GKE

适合:owner 明确要 Kubernetes 控制面,或需要超过 Cloud Run service 模型的 worker、网络、调度、sidecar、长期任务控制。

证据:
- GKE Autopilot 由 Google 管理节点基础设施,按 Kubernetes manifest provision workload resources: [GKE Autopilot overview](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview)。
- Autopilot 支持按 Pod requests/limits 管理资源: [Resource requests in Autopilot](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests)。

实现影响:
- S22 不只是 Dockerfile,还需要 Kubernetes manifests/Helm/Kustomize、Ingress、TLS、Secret、rollout、observability。
- CI/CD 复杂度高于 Cloud Run。

主要风险:
- 对当前单 API 容器来说运维面偏大。
- 需要 owner 接受集群/命名空间/部署策略的管理成本。

### C. AWS ECS Fargate

适合:owner 决定 API 运行在 AWS,或团队已有 AWS ECS/IAM/ALB 运维体系。

证据:
- ECS task definition 描述 CPU/memory、网络、日志、IAM role、容器命令等运行参数: [Amazon ECS task definitions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definitions.html)。
- Fargate task CPU/memory 组合支持到 16 vCPU / 120 GB memory(Linux platform 1.4.0+): [Task definition parameters for Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)。

实现影响:
- 需要 ECS service/task definition、ALB、Secrets Manager/SSM、ECR、IAM。
- 与已锁的 GCS/Supabase 跨云组合会增加网络/权限/成本复杂度,除非 owner 同时决定把对象存储或数据库也迁到 AWS。

主要风险:
- 跨云状态依赖增加排障面。
- S22 工作量接近一套 AWS 部署工程,不再是轻量容器上线。

### D. Fly.io / Railway

适合:快速小规模试运行或 demo 环境,不作为当前生产默认。

证据:
- Fly Machines 可调 CPU/RAM: [Scale Machine CPU and RAM](https://fly.io/docs/launch/scale-machine/)。
- Railway 支持 Dockerfile 部署: [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles),也支持 replica CPU/memory limits: [Railway cost control](https://docs.railway.com/pricing/cost-control)。

实现影响:
- 上手快,但生产 secret、GCS HMAC、Supabase 网络、长请求/streaming 行为仍需专项验证。

主要风险:
- 相比 GCP/AWS,企业生产治理、网络边界和长期资源策略需要 owner 额外确认。

## 建议的拍板问题

请 owner 在下面三选一:

1. **Cloud Run**:最小运维路径;S22 直接做 Cloud Run API + 静态 web 部署。
2. **GKE**:接受 Kubernetes 运维面,换取更强控制与后续 worker/long-job 空间。
3. **其他平台**:指定 ECS/Fly/Railway/自托管等,同时确认 secret、网络、日志、CI/CD 的目标体系。

若选择 Cloud Run,S22 的第一版交付边界建议是:
- `apps/api/Dockerfile`
- Cloud Run service 部署说明或 CI job
- env/secrets checklist
- web 静态构建/部署说明
- 生产冒烟脚本:health/version/capabilities + 一次小型 ingest→transform→lineage→export lifecycle

