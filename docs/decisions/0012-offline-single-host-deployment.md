# ADR 0012 — Ubuntu 单机离线部署

- **状态:** 已接受——owner 于 2026-07-24 确认；2026-07-27 明确整个不暴露公网的内网可作为
  可信边界，CIDR/iptables 为可选加固；2026-07-27 再次明确离线包必须包含已经完成的
  Python Worker，交付完整 `basic-clean@1` 能力
- **日期:** 2026-07-24
- **决策者:** owner
- **依赖:** [ADR 0003](0003-storage-postgres-object-store.md)、
  [ADR 0008](0008-object-store-aliyun-oss.md)、
  [ADR 0011](0011-identity-hashing-versioning-v2.md)
- **产品/API/冒烟修订:** [ADR 0013](0013-v2-product-cutover-and-v1-retirement.md)
  将产品面改为 v2-only；以下决策文字已按该后续 ADR 更新
- **Worker 修订:** 本次修订履行 ADR 0010 原先要求的独立窄修订；Worker 作为第六张镜像进入
  离线包，并重新执行完整 bundle/lifecycle gate
- **Swift 修订:** [ADR 0018](0018-ms-swift-native-gradio-studio.md) 的离线交付修订增加
  第八张、默认关闭的 Swift CUDA 镜像。它只在 operator 显式启用 `swift-gpu` profile 时使用
  NVIDIA GPU，不替换第六张 CPU-only Worker；模型权重由 operator 预置，不进入通用发布包
- **UI-only 修订:** owner 于 2026-07-30 要求控制面保留完整 Swift Studio 页面但不训练。
  `DATABENCH_SWIFT_ENABLED=true` 不再等同于必须申请 GPU；`runtime_mode=ui-only` 启动完整
  Provider/Gradio、跳过 NVIDIA 与模型预置检查，`runtime_mode=gpu` 才保留原 GPU gate。
- **增量发布修订:** owner 于 2026-07-30 要求代码小改不再重复构建和传输完整八镜像包。
  完整包继续作为首次安装、运行契约变化和周期性恢复基线；新增精确绑定
  `base_version + base bundle SHA-256` 的增量升级包，只携带变化的应用镜像。增量包没有
  `install.sh`，只能在已安装精确基线的目标机执行 `upgrade.sh`。
- **升级 preflight 修订:** owner 于 2026-07-30 确认已经运行的安装环境升级时不再重复执行
  CPU/RAM/磁盘固定容量门槛。首次安装仍保留容量 gate；完整包和增量包升级继续硬性检查
  平台、Docker/Compose、端口，以及显式 GPU mode 的 NVIDIA runtime。
- **详细方案:**
  [内网单机离线发布方案](../deployment/offline-single-host-plan.zh-CN.md)

## 背景

现有阿里云发布使用 ECS、RDS、OSS/CDN。新增目标环境是一台没有公网、没有内部镜像仓库的
Ubuntu 服务器；Docker 已预装，允许维护停机，数据规模初期较小。现有云发布必须保持不变。

## 决策

1. 新增与现有发布并列的 `deploy/offline/**` 通道。联网 Apple Silicon Mac 使用 Docker
   Buildx 构建完整 `linux/amd64` 离线包，目标固定为 Ubuntu 22.04 LTS amd64。
2. 默认离线拓扑固定为 Web/Caddy、Node API、一个 Python Worker、backend-only EvalScope、
   PostgreSQL 17、MinIO 与一次性 MinIO/migration 任务。Worker 只在 Compose 私网监听 gRPC
   50051，不发布宿主机端口；API
   显式启用单 dispatcher/单 Worker 的 `basic-clean@1`。Worker 不持有数据库或对象存储长期
   凭据，只使用 API 签发的 exact-key 短期 URL；临时任务文件位于有界 tmpfs。发布包仍不包含
   Docker bootstrap。ADR 0018 允许发布包额外携带 Swift Studio CUDA 镜像；runtime 默认关闭，
   `DATABENCH_ENABLE_SWIFT_STUDIO=true` 时可启用单实例 Studio。默认 UI-only mode 不申请 GPU；
   显式 `runtime_mode=gpu` 时才做一次快速 NVIDIA/容器内 Torch CUDA 检查，不在安装期执行真实训练。
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
   环境保持不变。API、Worker、PG、MinIO 不发布宿主机端口；API 通过 Compose DNS
   `worker:50051` 连接 Worker，不固定 Docker 子网，以兼容旧五镜像 release 的原地升级。
   首版不实现应用鉴权，只允许不暴露公网的
   受控内网访问；企业内网本身已经封闭时不强制配置主机级 CIDR/iptables，需要更细粒度隔离时
   可将其作为纵深防御。
5. PostgreSQL、MinIO 与 API workspace 使用 `/srv/databench` 下的持久目录；Worker 无持久
   数据目录。secret 位于 `/etc/databench/databench.env`，首次安装由 CSPRNG 生成，升级不得
   覆盖。
6. 每个可首次安装的完整版本交付完整镜像集合、精确平台/digest 锁、release manifest 与双层
   SHA-256。已经安装完整八镜像基线后，允许交付精确基线绑定的增量升级包；它只包含变化的
   API/Web/Worker/EvalScope/Swift 应用镜像，目标机把它与已安装 release 合成为新的完整
   `release.env`、八镜像 lock 和 rollback 记录。增量包不得增加/删除服务、改变 Compose、基础
   镜像、持久化布局或安装契约。目标机安装和运行不得 pull、build、安装 npm 包或访问公网。
7. 普通升级允许维护停机：依次停止 Web/API/Worker，生成同一 generation 的 PG+MinIO 备份，
   执行 migration，先启动并确认 Worker capability，再切换 API/Web，最后运行 doctor、固定
   数据集、MCP 与 `basic-clean` canonical lifecycle smoke。保留当前版、上一版和一个已知稳定
   版。任一阶段失败必须自动恢复 previous release；PostgreSQL major/MinIO 数据格式升级使用
   独立方案。回滚到不含 Worker 的历史版本时必须兼容五镜像 release contract，并保持 Worker
   停止。
8. Owner 明确授权从当前 `main` 直接生成 production 离线包；V16/V17 不作为本离线发布
   通道的阻断门。其状态与 gate 记录保持真实，不因本发布例外伪造为已执行通过。

## 后果

- 单机部署不提供高可用；宿主机或数据盘故障会停机，production 必须配置异机/NAS 备份并
  完成干净机器恢复演练。
- MinIO on-prem production 是对 ADR 0008 的窄修订，不改变阿里云 OSS production 部署。
- Worker 镜像固定 CPU-only Torch；Swift CUDA runtime 是独立第八张镜像和可选 profile，不能把
  Worker 改成 CUDA Worker。启用 Swift 的目标机还必须预装兼容 NVIDIA driver 与 NVIDIA
  Container Toolkit，并为镜像、模型缓存、Session output 和 Adapter 预留额外磁盘。
- 增量版本不是独立恢复基线。新机安装或灾难恢复必须保留最近完整包，以及从该完整版本到目标
  版本的连续增量包，并按版本顺序应用；运行契约变化时必须重新发布完整包。
- 本 ADR 不解决现有公共云 API 托管平台 D3，也不授权修改现有 ECS/OSS workflow。
- 本地跨架构构建必须在 Docker amd64 仿真和真实 Ubuntu 22.04 amd64 上分别验收。
