# ADR 0012 — Ubuntu 单机离线部署

- **状态:** 已接受——owner 于 2026-07-24 确认；2026-07-27 明确整个不暴露公网的内网可作为
  可信边界，CIDR/iptables 为可选加固
- **日期:** 2026-07-24
- **决策者:** owner
- **依赖:** [ADR 0003](0003-storage-postgres-object-store.md)、
  [ADR 0008](0008-object-store-aliyun-oss.md)、
  [ADR 0011](0011-identity-hashing-versioning-v2.md)
- **产品/API/冒烟修订:** [ADR 0013](0013-v2-product-cutover-and-v1-retirement.md)
  将产品面改为 v2-only；以下决策文字已按该后续 ADR 更新
- **Worker 澄清:** 2026-07-25 ADR 0010 重新规划的可选 Worker 不自动进入本离线包；加入时
  需要本 ADR 的独立窄修订和新 gate
- **详细方案:**
  [内网单机离线发布方案](../deployment/offline-single-host-plan.zh-CN.md)

## 背景

现有阿里云发布使用 ECS、RDS、OSS/CDN。新增目标环境是一台没有公网、没有内部镜像仓库的
Ubuntu 服务器；Docker 已预装，允许维护停机，数据规模初期较小。现有云发布必须保持不变。

## 决策

1. 新增与现有发布并列的 `deploy/offline/**` 通道。联网 Apple Silicon Mac 使用 Docker
   Buildx 构建完整 `linux/amd64` 离线包，目标固定为 Ubuntu 22.04 LTS amd64。
2. 离线拓扑固定为 Web/Caddy、Node API、PostgreSQL 17、MinIO 与一次性 MinIO/migration
   任务。不包含 Docker bootstrap，也不自动包含 ADR 0010 后续规划的可选 Worker；若要加入，
   必须另行窄修订本 ADR 并重跑完整离线 bundle/smoke gate。
3. ADR 0008 的 production OSS 选择继续适用于现有阿里云环境；本 ADR 允许 MinIO 作为隔离
   内网单机 production 数据面。业务代码仍只通过 `Store` 接口和
   `DATABENCH_OBJECT_STORE=s3` 选择后端。MinIO bucket 不启用 versioning，API 使用
   bucket-scoped app access key。
4. 宿主机只暴露 Web 入口。离线 Web 的后端 base 固定为 `/api`，Caddy 使用
   `handle_path /api/*` 去掉此前缀后转发到 API；因此外部 API 是 `/api/health`、
   `/api/v2/*`，Hono 内部路由与 OpenAPI paths 保持不变。产品页面使用
   `/datasets`、`/ingest`、`/transforms` 等无版本路径；网关裸 `/v2/*` 不解释为
   SPA 或外部 API。不再通过
   `Accept` 头复用同一 URL，避免 HTML/JSON 浏览器缓存冲突。离线 API 通过部署环境仅在
   运行时 OpenAPI 文档中声明 `servers: [{url: "/api"}]`，仓库确定性 OpenAPI 和其他发布
   环境保持不变。API、PG、MinIO 不发布宿主机端口。首版不实现应用鉴权，只允许不暴露公网的
   受控内网访问；企业内网本身已经封闭时不强制配置主机级 CIDR/iptables，需要更细粒度隔离时
   可将其作为纵深防御。
5. PostgreSQL、MinIO 与 API workspace 使用 `/srv/databench` 下的持久目录；secret 位于
   `/etc/databench/databench.env`，首次安装由 CSPRNG 生成，升级不得覆盖。
6. 每个版本交付完整镜像集合、精确平台/digest 锁、release manifest 与双层 SHA-256。
   目标机安装和运行不得 pull、build、安装 npm 包或访问公网。
7. 普通升级允许维护停机：停止 API 写入，生成同一 generation 的 PG+MinIO 备份，执行
   migration，原子切换应用版本，再运行 doctor 与固定数据集 lifecycle smoke。保留当前版、
   上一版和一个已知稳定版。任一阶段失败必须自动恢复 previous release；PostgreSQL
   major/MinIO 数据格式升级使用独立方案。
8. Owner 明确授权从当前 `main` 直接生成 production 离线包；V16/V17 不作为本离线发布
   通道的阻断门。其状态与 gate 记录保持真实，不因本发布例外伪造为已执行通过。

## 后果

- 单机部署不提供高可用；宿主机或数据盘故障会停机，production 必须配置异机/NAS 备份并
  完成干净机器恢复演练。
- MinIO on-prem production 是对 ADR 0008 的窄修订，不改变阿里云 OSS production 部署。
- 本 ADR 不解决现有公共云 API 托管平台 D3，也不授权修改现有 ECS/OSS workflow。
- 本地跨架构构建必须在 Docker amd64 仿真和真实 Ubuntu 22.04 amd64 上分别验收。
