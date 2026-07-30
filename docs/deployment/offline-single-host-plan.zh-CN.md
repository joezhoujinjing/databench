# Databench 内网单机离线发布方案

> **状态：Implemented / 待真实 Ubuntu 22.04 amd64 离线验收。**
>
> Owner 于 2026-07-24 接受本文方向与评审修订。本文记录一个与公共云 D3 并列、但不替代
> D3 的新增部署目标：在**没有公网、没有内部镜像仓库**的环境中，
> 将 Databench 一键安装到单台 Ubuntu。现有阿里云 ECS、RDS、OSS/CDN 发布链保持
> 不变；本方案只新增一条并列的离线发布通道。Owner 于 2026-07-27 进一步明确：整个不暴露
> 公网的内网可作为可信边界，CIDR/iptables 是可选加固，不是安装前置条件。Owner 同日追加
> 要求：离线包必须包含 Python Worker，交付完整 `basic-clean@1` 能力。Owner 于 2026-07-28 接受
> ADR 0017 的预构建镜像边界：当前离线包同时包含 pinned backend-only EvalScope，目标机不执行源码
> build，但 install/start/eval/report/upgrade/rollback 必须全程断网。ADR 0018 的 2026-07-29
> 离线修订再加入第八张、默认关闭的 Swift CUDA 镜像；operator 可在 NVIDIA 目标机显式启用，
> 本机发布 gate 只验证 CPU 启动与接口，真实训练由内网 GPU 机完成。

## 1. 结论

采用“**联网环境构建完整离线包，内网 Ubuntu 一键导入并启动**”的交付方式：

```text
                    ┌─────────────────────────────┐
                    │ 现有发布：保持不变           │
GitHub Actions ────▶│ ECS API + RDS + OSS/CDN     │
                    └─────────────────────────────┘

                    ┌─────────────────────────────┐
                    │ 新增发布：只生成离线包       │
联网构建环境 ──────▶│ images + compose + installer │
                    └──────────────┬──────────────┘
                                   │ 人工传输 / 内网文件共享
                                   ▼
                    ┌─────────────────────────────┐
                    │ 单台 Ubuntu                  │
                    │ Web + API + Worker + EvalScope│
                    │ + optional Swift GPU Studio   │
                    │ + PostgreSQL + MinIO          │
                    └─────────────────────────────┘
```

目标操作体验：

```bash
tar -xzf databench-offline-<version>-linux-amd64.tar.gz
cd databench-offline-<version>-linux-amd64
sudo env \
  DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api \
  DATABENCH_ENABLE_SWIFT_GPU=true \
  ./install.sh
```

不启用 GPU Studio 时省略 `DATABENCH_ENABLE_SWIFT_GPU`。地址在首次创建
`/etc/databench/mcp.env` 时提供一次；Swift 开关在首次创建 `/etc/databench/swift.env` 时保存，
后续重跑安装和正常升级自动复用。

目标机安装期间和运行期间均不执行 `docker pull`、`pnpm install`，也不访问 GitHub、
npm registry 或其他公网服务。

## 2. 范围与非目标

### 2.1 本方案覆盖

- 联网环境构建 API/Web/Worker/EvalScope/Swift Studio 应用镜像；
- 拉取并锁定 PostgreSQL、MinIO、MinIO Client 等第三方镜像；
- 将所有镜像和部署资产组装为一个带校验值的离线包；
- 在干净 Ubuntu 上一键导入、初始化、迁移、启动和冒烟；
- 首次安装自动生成密码并写入服务器 `.env`；
- 后续离线升级、失败回滚、备份和恢复；
- 宿主机重启后的自动恢复和持久化；
- 只开放 Web 入口，API/EvalScope/Swift Studio/Worker/PG/MinIO 走容器内部网络。

### 2.2 本方案不覆盖

- 不替换或修改现有 `deploy/ecs/**` 及其 GitHub Actions；
- 不实现多机高可用、Postgres 主从或 MinIO 分布式集群；
- 不把 Docker Engine 混进每个业务版本包；
- 不把生产密码、证书或用户数据打进镜像/离线包；
- 不把 MinIO 重新定义为所有生产环境的默认对象存储；
- 不把 Worker 或 EvalScope 扩展到多副本、GPU、任意 Python 执行或其他发布环境；
- 不把第三方基础模型权重打进通用离线包。operator 将模型预置到
  `/srv/databench/swift-models`，容器内通过 `/opt/databench-models/<模型目录>` 使用。
- 首版不实现应用层鉴权，只允许受控内网访问，不能暴露到公网。

## 3. 与当前代码重构的边界

离线交付机制的大部分内容与业务代码无关，但最终实现依赖一层稳定的“部署契约”。当前
`main` 已固定下表契约；owner 已明确授权基于当前 `main` 直接生成 production 离线包。

### 3.1 不受业务重构影响的通用部分

- `docker buildx`、`docker save/load` 和离线包校验；
- Docker Compose 的单机网络、持久化、日志轮转和重启策略；
- PostgreSQL/MinIO 的生命周期；
- 密码生成、配置文件权限和升级时复用旧 secret；
- 安装器、备份器、恢复器和版本切换框架；
- 联网构建、人工传输、内网安装的责任边界。

### 3.2 已冻结的应用契约

| 契约 | 固定值 | 离线要求 |
|---|---|---|
| API 架构 | Node 22 + Linux 原生插件 | 首版只发布 `linux/amd64` |
| 目标宿主机 | Ubuntu 22.04 LTS amd64 | 安装器精确校验 OS/架构 |
| API 监听 | 容器内 `8000` | 不发布宿主机端口 |
| API 启动 | `node apps/api/dist/index.js` | 由 production Dockerfile 固定 |
| Worker | Python 3.11 + Data-Juicer 1.5.3 | CPU-only、单并发、Compose 私网 `worker:50051` |
| EvalScope | pinned Python backend-only image | CPU-only、单实例、Compose 私网 `evalscope:9000`，不发布原生 SPA |
| Swift Studio | pinned ms-swift v4.4.2 CUDA image | 第八张镜像、默认关闭；显式 `swift-gpu` profile，私网 `7860/7861` |
| 数据库 | PostgreSQL 17 + Prisma | `prisma migrate deploy`，升级按第 9 节停写 |
| 对象存储 | `DATABENCH_OBJECT_STORE=s3` + MinIO | on-prem production 例外由 ADR 0012 接受 |
| 健康检查 | API 内部 `/health` 仅 liveness | 外部 `/api/health`；readiness 使用固定 smoke ref 的 resolve + audit |
| Web API base | 同源 `/api` | 仅离线 Web 镜像在 Vite 构建时注入，不影响 ECS/OSS 发布 |
| OpenAPI/业务路径 | API 内部 `/v2/*` + meta paths | 外部统一加 `/api`；Caddy 去前缀后代理，文档 `servers.url=/api` |
| API 临时空间 | `/var/lib/databench/.databench-v2-temp` | `/var/lib/databench` 必须挂载数据盘 |
| Worker 临时空间 | `/tmp/databench-worker-v1` | 4 GiB tmpfs，无持久化数据 |
| EvalScope 持久化 | `/var/lib/evalscope/{outputs,inputs}` | 宿主机 `/srv/databench/evalscope`，备份与 drain 覆盖 |
| Swift 持久化 | `/var/lib/databench-swift-studio` | Session workspace 在 `/srv/databench/swift-studio`；模型目录单独保留 |

如果后续重构改变以上任一项，只调整应用镜像和契约适配层，不改变离线包总体流程。v2
V16/V17 的状态不阻断本离线通道生成 production 包；这是 owner 对该发布目标的明确例外，
不伪造 GV16/GV-final 的实际执行记录。

## 4. 单机运行拓扑

```text
内网用户
   │
   ▼ 80（首版唯一业务入口）
┌───────────────────────────────┐
│ Web Gateway                   │
│ Caddy + apps/web 静态产物     │
│ /api/*（去前缀）→ api:8000    │
│ /evalscope-api/* → API gateway│
│ /swift-studio/* → API gateway │
│ /datasets 等产品路径 → SPA    │
└──────────────┬────────────────┘
               ▼
┌───────────────────────────────┐
│ Databench API                 │
│ Node 22 + Hono + v2 codec     │
└──────┬────────────┬────────────┬────────────┘
       │            │             │               │
       ▼            ▼             ▼               ▼
 Python Worker   EvalScope   Swift GPU Studio  PostgreSQL 17 ─── MinIO
 basic-clean@1   eval/report native Gradio      catalog/control   immutable data
 private gRPC    private HTTP private HTTP/GPU
```

计划中的 Compose 服务：

| 服务 | 作用 | 宿主机端口 | 持久化 |
|---|---|---:|---|
| `web` | Caddy + Vite 静态文件 + API 反代 | `80` | 无状态 |
| `api` | Databench API | 不映射 | `/srv/databench/workspace:/var/lib/databench` |
| `worker` | CPU-only Python/Data-Juicer Worker | 不映射（gRPC 50051 仅容器网络） | 无；4 GiB tmpfs |
| `evalscope` | backend-only evaluation provider | 不映射（HTTP 9000 仅容器网络） | `/srv/databench/evalscope` |
| `swift-studio` | 完整原生 ms-swift Gradio + Provider | 不映射（7860/7861 仅容器网络） | `/srv/databench/swift-studio` |
| `postgres` | catalog/control plane | 不映射 | `/srv/databench/postgres` |
| `minio` | immutable Parquet data plane | 不映射 | `/srv/databench/minio` |
| `minio-init` | 首次/幂等创建 bucket | 不映射 | 无，一次性任务 |
| `migrate` | `prisma migrate deploy` | 不映射 | 无，一次性任务 |

MinIO Console 默认不对业务网段开放；需要管理时使用 SSH 隧道或临时仅绑定
`127.0.0.1`。Postgres、MinIO、API、EvalScope、Swift Studio 和 Worker 不能发布到 `0.0.0.0`。
API 通过 Compose DNS
目标 `worker:50051` 连接 Worker，不固定 Docker 子网，避免从历史五镜像版本升级时发生网段冲突。

## 5. 离线发布物规范

### 5.1 文件名

```text
databench-offline-<app-version>-linux-<arch>.tar.gz
databench-offline-<app-version>-linux-<arch>.tar.gz.sha256
```

版本必须是无前导零的三段数字 `major.minor.patch`，且必须唯一；禁止覆盖已经生成的同名
发布物。

### 5.2 包内结构

```text
databench-offline-<app-version>-linux-amd64/
├── images.tar                 # docker load 的完整镜像集合
├── images.lock               # image name/tag/digest/platform
├── release-manifest.json      # git SHA、兼容范围、migration/rollback 属性
├── compose.yml
├── release.env               # 只含版本和镜像名，不含 secret
├── env.example
├── mcp.env.example
├── evalscope.env.example
├── swift.env.example
├── Caddyfile
├── install.sh
├── upgrade.sh
├── rollback.sh
├── backup.sh
├── restore.sh
├── smoke.sh
├── databenchctl
├── README.zh-CN.md           # 快速安装和运维入口
├── DEPLOYMENT-GUIDE.zh-CN.md # 完整部署与运维手册
├── TROUBLESHOOTING.zh-CN.md  # 故障排查手册
├── MCP-AGENT-GUIDE.zh-CN.md
├── EVALSCOPE-OPERATOR-GUIDE.zh-CN.md
├── SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md
├── docs/
│   ├── offline-single-host-plan.zh-CN.md
│   ├── ADR-0012.md
│   ├── ADR-0018.md
│   ├── TECHNICAL-DESIGN.md
│   └── STATUS.md
├── lib/{common,config,health,manifest,preflight}.sh
├── minio/app-policy.json
├── smoke/v2.jsonl
├── RELEASE.txt               # git SHA、构建时间、平台、工具版本
└── SHA256SUMS                 # 包内文件校验
```

外层 `.sha256` 在解包前校验整个发布物；`SHA256SUMS` 在解包后再次校验关键文件。

`release-manifest.json` 使用以下 versioned strict contract；缺字段、未知字段、类型错误或值不
匹配包名、`release.env`、`images.lock` 时一律拒绝安装/升级：

```json
{
  "schema_version": 1,
  "app_version": "1.0.0",
  "git_sha": "40-lowercase-hex",
  "platform": "linux/amd64",
  "min_upgrade_from": "0.1.0",
  "postgres_major": 17,
  "database_migration": "expand-only",
  "rollback_mode": "image-only",
  "object_migration": "none",
  "images_lock_sha256": "64-lowercase-hex"
}
```

固定枚举与行为：

- `database_migration`: `expand-only` 或 `restore-on-rollback`；
- `rollback_mode`: `image-only` 或 `restore-backup`，production 包禁止声明无回滚；
- `object_migration`: 首版只允许 `none`；未来 `release-specific` 必须同时携带专用迁移与恢复
  方案，通用脚本不得处理；
- `upgrade.sh` 拒绝低于 `min_upgrade_from`、高于/等于目标版本、Postgres major 不匹配或不认识
  的 manifest schema；
- `database_migration=expand-only` 必须搭配 `rollback_mode=image-only`；
  `restore-on-rollback` 必须搭配 `restore-backup`。

### 5.3 镜像集合

- `databench-api:<app-version>`；
- `databench-web:<app-version>`，最终层包含 Caddy 和静态 Web；
- `databench-worker:<app-version>`，固定 Python lock 与 CPU-only Torch；
- `databench-evalscope:<app-version>`，固定 upstream commit、Python lock、patch 和本地 Plotly asset；
- `databench-swift-studio:<app-version>`，固定 CUDA/PyTorch、ms-swift commit、Python lock 和 Gradio patch；
- 精确版本/摘要的 PostgreSQL 镜像；
- 精确版本/摘要的 MinIO 镜像；
- 精确版本/摘要的 MinIO Client 镜像。

Swift 镜像始终进入 `images.tar`，但 `swift-studio` service 只有在 `/etc/databench/swift.env`
保存 `DATABENCH_SWIFT_ENABLED=true` 时才激活 `swift-gpu` profile。Compose 只引用
`release.env` 中的精确镜像名，并设置 `pull_policy: never`；离线 Compose
中禁止 `build:`、`latest` 和未解析的外部镜像。

### 5.4 构建入口

核心入口是仓库内可重复执行的：

```bash
deploy/offline/build-bundle.sh <version>
```

首版固定在当前联网 Apple Silicon Mac 上使用 Docker Buildx 构建 `linux/amd64`。脚本必须：

- 拒绝 dirty worktree，并记录精确 git SHA；
- 对 API/Web/Worker/EvalScope/Swift Studio build 和所有第三方镜像 pull 显式指定 `linux/amd64`；
- 构建后逐个 inspect 镜像架构与 digest，拒绝 arm64、`latest` 或未锁定引用；
- 输出外层 SHA-256 与包内 `SHA256SUMS`；
- 在 Docker 的 amd64 仿真下完成镜像启动 smoke，正式首发再在真实 Ubuntu 22.04 amd64 验收。

GitHub Actions workflow 作为后续可选入口，不是首版依赖：

```text
workflow_dispatch(version, platform)
  → checkout 精确 commit
  → build API/Web/Worker/EvalScope/Swift Studio
  → pull 第三方镜像
  → 记录 digest/platform
  → docker save
  → 生成校验值
  → 上传 Artifact
```

无论从本地还是 CI 调用，都必须使用同一个脚本和产物格式；workflow 只生成包，不连接内网
服务器，也不触发已有 ECS/OSS 发布。

历史五镜像包的 `images.tar` 约 412 MB、外层 gzip 约 409 MiB；2026-07-27 六镜像记录为
EvalScope 纳入前的 Worker 包，七镜像包是 Swift 纳入前的版本。当前发布物为八镜像，新增 CUDA
Swift Studio 后不沿用旧体积估算，正式交付以当次 `RELEASE.txt`、`ls -lh` 和 SHA-256 为准。该数字
不含基础模型、业务数据、训练 output、EvalScope 在线结果、备份、Docker 已有缓存和解包期间的临时空间。

## 6. 一键安装行为

### 6.1 用户入口

```bash
sudo ./install.sh
```

默认无交互；只有无法安全推断的项目才要求通过安装前配置文件提供。脚本必须幂等，失败后
可以修正环境并重跑。

### 6.2 安装状态机

`install.sh` 按以下顺序执行：

1. 确认传输阶段已校验外层 SHA-256，并校验包内 `SHA256SUMS`；
2. 检查 Ubuntu 版本、CPU 架构、Docker Engine、Compose；UI-only/不训练模式使用
   6 logical CPUs、15 GiB 可见 RAM，
   60 GiB 系统盘、12 GiB Databench 数据文件系统可用空间和端口；
3. 拒绝含 `build:`、`latest`、缺失本地镜像或允许 pull 的离线配置；
4. `docker load` 导入全部镜像；
5. 创建 `/opt/databench-offline`、`/etc/databench`、`/srv/databench`；
6. 首次安装生成 secret，已有配置则原样复用；
7. 启动 PostgreSQL 和 MinIO 并等待健康；
8. 幂等创建 MinIO bucket；
9. 执行数据库 migration；
10. 启动 Worker 并等待标准 gRPC health 为 `SERVING`；
11. 若显式启用 Swift，先用打包镜像快速验证目标 GPU，再启动 Studio 并等待 Provider、Gradio
    和 `gpu_available=true`；
12. 按 API → EvalScope → Web 启动其余应用服务；
13. 执行 readiness、固定数据集、MCP 和 `basic-clean@1` 完整生命周期冒烟；
14. 输出访问地址、配置位置、数据位置和运维命令。

任何一步失败都要输出明确的失败阶段和排障命令；不得删除已有数据，不得静默生成第二套
密码或覆盖配置。

### 6.3 安装成功输出

```text
Databench 安装成功

访问地址：http://<server-ip-or-hostname>
配置文件：/etc/databench/databench.env
Swift 配置：/etc/databench/swift.env
离线模型目录：/srv/databench/swift-models
数据目录：/srv/databench
当前版本：<app-version>

管理命令：
  databenchctl status
  databenchctl logs
  databenchctl backup
  databenchctl restart
```

输出中禁止出现密码、完整 `DATABASE_URL`、MinIO secret 或其他凭据。

## 7. Secret 与 `.env`

### 7.1 首次安装

首次安装使用系统 CSPRNG 生成 URL-safe 高强度随机值，并写入：

```text
/etc/databench/databench.env
```

候选内容：

```dotenv
POSTGRES_USER=databench
POSTGRES_PASSWORD=<generated-url-safe-secret>
POSTGRES_DB=databench
DATABASE_URL=postgresql://databench:<encoded-secret>@postgres:5432/databench?schema=public

MINIO_ROOT_USER=databench
MINIO_ROOT_PASSWORD=<generated-secret>
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=databench
S3_ACCESS_KEY_ID=databench_app
S3_SECRET_ACCESS_KEY=<generated-distinct-app-secret>
S3_FORCE_PATH_STYLE=true
DATABENCH_OBJECT_STORE=s3

DATABENCH_CORS_ORIGINS=
DATABENCH_ROOT=/var/lib/databench
DATABENCH_V2_CURSOR_SECRET=<generated-distinct-cursor-secret>
PORT=8000
```

约束：

- 文件 owner 为 `root:root`，权限 `0600`；
- 安装器自动构造并验证 URL encoding；
- secret 不写入镜像、Git、发布包、终端输出或日志；
- PostgreSQL、MinIO root、MinIO app key 与 v2 cursor 使用不同随机值；
- `install.sh`/`upgrade.sh` 发现现有配置时绝不覆盖；
- 升级不轮换密码；轮换是单独、显式、有备份的运维动作；
- Compose interpolation 后的配置属于敏感信息，不进入诊断包。

### 7.2 应用凭据与管理员凭据

`minio-init` 使用 root 凭据幂等创建 bucket、`databench_app` 用户与 bucket-scoped policy；API
只获得 app access key。首版为保持安装简单，接受官方 PostgreSQL 镜像通过
`POSTGRES_USER=databench` 创建隔离集群超级用户，API 与 Prisma migration 共用该账号；该账号
不暴露宿主机端口，也不能用于其他数据库集群。以后若共享 PG 集群，再独立拆分 admin/app
账号，不在首版安装脚本中增加第二套角色自动化。

## 8. Docker Engine 前置条件

目标 Ubuntu 已安装 Docker，首版不提供 bootstrap 包。安装器只做只读 preflight，UI-only/不训练
模式最低要求 Docker Engine 24、Docker Compose plugin 2.20、6 logical CPUs、15 GiB 可见 RAM、
60 GiB 系统盘和 12 GiB Databench 数据文件系统可用空间；版本或容量不足时明确失败，不在离线安装
过程中擅自升级宿主机 Docker。只有 Swift `runtime_mode=gpu` 才提高为 12 logical CPUs/40 GiB，
要求 `nvidia-smi` 可枚举所选 GPU，并要求 NVIDIA Container Toolkit 能让打包镜像执行
`torch.cuda.is_available()`；UI-only 不执行 NVIDIA 检查，安装器也不做耗时训练验证。

## 9. 升级、回滚和版本保留

### 9.1 升级入口

```bash
sudo ./upgrade.sh
```

升级顺序：

1. 校验新包与目标平台；
2. 检查目标版本高于/不同于当前版本；
3. 校验 `release-manifest.json` 的来源版本范围、Postgres major、migration 与 rollback 属性；
4. 停止 Web、drain EvalScope，并拒绝在原生 Swift train/infer/deploy task 活跃时继续维护；
5. 停止 API/EvalScope/Worker/Swift，生成同一 generation 的 PostgreSQL + MinIO +
   EvalScope volume + Swift Session workspace 一致性备份并验证；
6. 导入新镜像；
7. 执行 migration；
8. 原子切换当前 `release.env`；
9. 按 Worker → optional Swift → API → EvalScope → Web 启动并确认健康；
10. `doctor`、数据集、MCP 与 `basic-clean@1` lifecycle smoke 通过后记录成功版本；
11. 保留当前版、上一版及一个已知稳定版的镜像和发布清单。

MinIO 数据对象是持久化数据，不随应用镜像升级；任何脚本禁止用 `docker compose down -v`。

`upgrade.sh` 在停止 API 前记录 previous release 与 backup generation，并从停止 API 起安装
退出 trap。任何阶段失败都必须自动恢复服务：

- 备份、镜像导入或 migration 前置检查失败：重新启动 previous release；
- migration 失败：按 manifest 的 `rollback_mode` 切回旧镜像，必要时恢复升级前 PG 备份；
- 新版启动、doctor 或 smoke 失败：停止新版、切回 previous release，按 manifest 决定是否
  恢复备份，然后重新启动旧版应用服务；历史五镜像 release 不启动 Worker，历史五/六镜像 release
  不启动 EvalScope，历史五/六/七镜像 release 不启动 Swift；
- 自动恢复也失败：保留备份和两个 release，不删除数据，输出精确人工恢复命令并以非零退出；
- 只有新版全部验收通过后才取消 trap、更新 current/success marker。

### 9.2 回滚边界

```bash
sudo ./rollback.sh <previous-version>
```

- migration 向后兼容：切回旧 `release.env` 并重建该版本声明的应用服务；
- migration 不向后兼容：停止写入，恢复升级前 Postgres 备份，再切旧镜像；
- 对象 key/layout 发生不可逆变化：必须由对应版本迁移设计提供双读/回填/恢复方案，通用
  发布脚本不能猜测；
- 回滚不自动删除新版本写入的 MinIO 对象，防止扩大数据损失。
- PostgreSQL major 或 MinIO 数据格式升级不属于普通 `upgrade.sh`，必须使用独立维护方案。

通用升级/回滚脚本已经按上述 manifest 边界实现；如果后续重构引入不兼容 migration 或对象
layout 变化，发布者必须改用对应模式或单独迁移方案，不能把它伪装成普通升级。

## 10. 备份与恢复

单机部署不是高可用。服务器或数据盘损坏会导致整体停机，因此上线前必须配置第二存储
位置（NAS、另一台内网服务器或离线介质）。同机 `/srv/databench/backups` 只能作为临时
中转，不能算最终备份。

`databenchctl backup` 至少产出：

- 一致性 PostgreSQL dump；
- MinIO bucket mirror/snapshot；
- EvalScope output/input persistent volume archive；
- 启用时的 Swift Session input/output/log/import state workspace；模型缓存与
  `/srv/databench/swift-models` 不重复进入每代业务备份；
- 加密的 `/etc/databench/databench.env`、`mcp.env`、`evalscope.env`、`swift.env` secret escrow，或经演练的
  凭据重建材料；
- 版本、镜像清单和对应离线发布包的文件名/SHA-256；
- 独立校验值；
- 同一 backup generation ID、备份时间、应用版本、数据库 migration 版本。

为了保证持久化数据面的恢复点一致，首版 `backup` 在可接受的维护窗口内停止 Web admission、
drain EvalScope、确认 Swift 原生任务 idle 并暂停 API 写入；完成 PostgreSQL dump、MinIO mirror、
EvalScope volume 和 Swift Session workspace 并验证后再恢复服务。备份必须复制到 NAS、另一台内网机器
或离线介质，不能只留在本机。

完整离线发布包按版本在外部备份位置只保存一份，普通数据备份只引用其文件名和 SHA-256，
不得为每个 backup generation 重复复制数百 MB 镜像包。恢复前必须同时找到匹配 SHA-256
的发布包。

`restore.sh` 是破坏性操作，必须要求显式 `--confirm`，恢复前再次备份当前状态，并在恢复
完成后运行完整生命周期冒烟。上线门要求在一台干净测试机上成功做过至少一次恢复演练。

## 11. 网络与安全

默认安全边界：

- 宿主机只在不暴露公网的可信内网开放 `80`；
- SSH 只对管理网段开放；
- API、EvalScope、Swift Studio、Worker、PG、MinIO 不发布宿主机端口；
- MinIO Console 默认关闭外部访问；
- 可以通过服务器 IP 或内部 DNS 访问；HTTPS/内部 CA 留作后续独立增强；
- 如启用可选 CIDR/iptables，加固规则和 Docker published ports 一起纳入端口扫描验收；
- 容器日志设置 `max-size`/`max-file`，防止写满系统盘。

首版明确不实现应用层鉴权，仅允许不暴露公网的受控内网访问。默认使用 HTTP 80；Caddy 不配置
公网 ACME，不产生任何外网请求。企业网络已经提供封闭内网边界时不强制主机级 CIDR/iptables；
需要把访问进一步限制到特定业务网段时可选配置。后续增加内部 CA/OIDC 时作为独立安全变更，
不改变离线包总体结构。

## 12. 可观测性与资源

### 12.1 健康检查

API 容器内部的 `/health` 仅能作为进程 liveness；经 Web 网关检查时必须使用
`/api/health`，否则 SPA fallback 返回的 `index.html` 也可能被误判为成功。最终部署契约还需要
readiness，至少验证：

- Prisma 能连接 Postgres 且 migration 已应用；
- MinIO endpoint 可达且 bucket 存在；
- Worker 标准 gRPC health 为 `SERVING`，且 `basic-clean@1` 可完成并命中 deterministic reuse；
- EvalScope `/health` ready、path-free `/config`、local Plotly digest 和 operator drain/resume 可用；
- 启用时 Swift Provider ready、`gpu_available=true`、Gradio `/config` root path 正确；
- API 能完成一次只读业务查询。

`databenchctl doctor` 使用保留 ref `system-offline-smoke-v2`：先执行 `ref show` 验证
Postgres，再执行完整 `dataset audit` 验证 catalog、manifest、artifact digest、Parquet schema、
record digests 与 dataset version。EvalScope release 还检查 provider health；启用 Swift 时增加
`"swift":{"gpu":true,"ok":true}`。全部成功才退出 0；首次安装必须先运行幂等 lifecycle smoke
创建该 ref，再执行 doctor。

最小 `databenchctl status/logs/doctor/restart` 与 `databench` CLI 在 P2 一键安装前交付；API
production 镜像必须包含 API、Prisma migration runtime 与构建后的 CLI，不能依赖目标机安装
Node/pnpm/jq。P3 再给 `databenchctl` 增加 backup/restore/upgrade/rollback 子命令。

安装后的 G-prod 冒烟还要实际执行一个最小的：

```text
ingest → persist → ref/query/audit → export → basic-clean → lineage/reuse
```

以同时覆盖 Postgres 和 MinIO。

smoke 使用仓库提交的固定最小 fixture、固定 canonical IDs/source/original IDs/idempotency keys
以及保留 ref `system-offline-smoke-v2`。首次运行创建，后续安装重跑
和升级复用同一内容寻址对象与 ref；禁止随机 ID、时间戳参与 identity，也不删除用户数据。

### 12.2 初始容量建议

仅作为首轮压测起点，不作为硬编码要求：

- 试运行：12 vCPU、48 GiB RAM；
- 大数据/多人并行：16 vCPU、64–128 GiB RAM；
- 系统盘：至少 100 GiB；
- 数据盘：预计保留 Parquet 数据的 1.5–2 倍，备份空间另算；
- Swift：GPU 显存按实际模型/训练参数规划；模型缓存、Session output 和 Adapter 空间另算；
- 数据盘优先 NVMe，并监控磁盘剩余量、inode、I/O latency。

当前 ingest/transform/evaluation/performance 存在内存、并发和临时文件峰值，最终规格必须用真实最大
数据集与模型 workload 做压测；安装器只能检查最低值，不能替代容量规划。

## 13. 已实现的仓库结构

本分支已新增以下资产，未改现有 ECS 发布资产：

```text
deploy/offline/
├── README.zh-CN.md
├── compose.yml
├── env.example
├── mcp.env.example
├── evalscope.env.example
├── swift.env.example
├── Caddyfile
├── Dockerfile.web
├── build-bundle.sh
├── install.sh
├── upgrade.sh
├── rollback.sh
├── backup.sh
├── restore.sh
├── smoke.sh
├── databenchctl
├── EVALSCOPE-OPERATOR-GUIDE.zh-CN.md
├── SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md
├── minio/app-policy.json
├── smoke/{v2.jsonl,worker.mjs}
├── test/offline-scripts.test.sh
└── lib/
    ├── common.sh
    ├── config.sh
    ├── health.sh
    ├── manifest.sh
    └── preflight.sh

.github/workflows/
└── build-offline-bundle.yml
```

现有以下文件保持原行为：

```text
deploy/ecs/**
.github/workflows/deploy-backend.yml
.github/workflows/deploy-frontend.yml
```

## 14. 实施进度

### P0：冻结部署契约（已完成）

- 以 Ubuntu 22.04 amd64、API 8000、同源 Web、外部 `/api` 前缀、PG17+MinIO 固定部署契约；
- ADR 0012 允许 MinIO 作为 on-prem production 数据面；
- owner 已授权当前 `main` 直接构建 production 包，V16/V17 不作为离线发布阻断门；
- 固定 release manifest、升级兼容性和一致性备份契约。

### P1：构建与发布物（已完成，真实 release 包待最终干净提交构建）

- 精简 production API/Web 镜像；API 镜像包含 Prisma migration runtime 与构建后的 CLI；
- CPU-only Worker、pinned backend-only EvalScope、默认关闭的 CUDA Swift Studio 和八镜像 release lock；
- 第三方镜像版本锁；
- `images.lock`、`RELEASE.txt`、release manifest 与双层 checksum；
- Apple Silicon Mac → `linux/amd64` 本地构建、架构 inspect 与仿真 smoke；
- GitHub workflow 仅作为后续可选入口。

### P2：一键安装（已实现并通过本地 amd64 Compose 集成验证）

- Compose；
- 自动 secret 和 `.env`；
- PG/MinIO 初始化；
- 固定数据目录 ownership、MinIO app policy 与必填 v2 secret；
- migration；
- Worker → optional Swift → API → EvalScope → Web 有序启动、`basic-clean@1`、EvalScope 和 Swift gateway smoke；
- 最小 `databenchctl status/logs/doctor/restart`，doctor 解析 JSON 健康字段；
- liveness/readiness/full smoke；
- 幂等重跑和错误诊断。

### P3：运维闭环（已实现，目标机恢复演练待 P4）

- 扩展 `databenchctl backup/restore/upgrade/rollback`；
- 升级/回滚；
- drain/idle 后 PostgreSQL/MinIO/EvalScope volume/Swift Session workspace 一致性备份/恢复；
- 日志轮转和容量预警；
- release bundle/secret escrow 的异机灾难恢复。

### P4：真离线验收（待执行）

- 干净 Ubuntu，断开公网；
- 只导入发布包；Docker 是预装前置条件；
- 一条命令安装；
- 重启宿主机后自动恢复；
- 完整生命周期；
- 新版本升级和失败回滚；
- 在另一台干净机恢复备份；
- 端口扫描仅见预期入口。
- 启用 GPU profile 时使用预置小模型完成 Dataset → Session → LoRA → Artifact → Deployment →
  EvalScope Report 验收。

## 15. 验收门（G-offline）

全部满足才可称为“傻瓜式一键离线部署”：

- [x] 不修改、不触发现有 ECS/OSS 发布链；
- [x] 构建脚本从精确 git SHA 生成完整镜像锁和双层 checksum；
- [x] 全部镜像均固定为 `linux/amd64`，不存在 `latest` 或未解析引用；
- [ ] 目标机断网，安装过程无外部 DNS/HTTP 请求；
- [ ] `sudo ./install.sh` 在干净 Ubuntu 上一次成功；
- [x] 首次安装脚本自动生成 secret，目标权限 `0600`，终端/日志不输出 secret；
- [x] 重跑安装和执行升级复用现有 secret；
- [x] Compose 不含 `build:`、`latest`，所有服务 `pull_policy: never`；
- [x] Compose 只发布 Web 80，API/EvalScope/Swift Studio/Worker/PG/MinIO 不发布宿主机端口；
- [x] 本地 amd64 集成环境的 migration、readiness、ingest→query/audit→export 和
  `basic-clean@1`→lineage/reuse 全通过；
- [x] 本地 amd64 集成环境中 Caddy 将外部 `/api/*` 去前缀后代理到 API；`/datasets/<ref>`
  固定返回 SPA HTML，`/api/v2/datasets/<ref>` 固定返回 API JSON，不依赖 `Accept` 分流或禁止缓存；
- [ ] 宿主机重启后服务与数据恢复；
- [ ] 上一版本应用可回滚；
- [ ] 同一 generation 的 PostgreSQL + MinIO + EvalScope volume + Swift Session workspace +
  release bundle 可在干净环境恢复；
- [ ] 内网 NVIDIA 机显式启用 Swift 后，安装期 CUDA 快检和真实最小训练/推理/评测闭环通过；
- [ ] 使用真实目标规模数据完成内存、CPU、磁盘和超时压测。

## 16. 已接受决策与安装时输入

Owner 已接受：Ubuntu 22.04 amd64、本地 Mac Buildx、完整离线包、`/srv/databench`、小规模
首发、允许维护停机、保留当前版+上一版+稳定版、首版无应用鉴权、无 Docker bootstrap，并采用
本文的 `/api` 独立代理、必填 secret、停写升级和一致性备份建议。2026-07-27 后续修订确认
Python Worker 必须进入完整离线包，同时保持其他发布环境默认不启用。2026-07-29 的 ADR 0018
修订确认 Swift CUDA runtime 也进入完整离线包，但默认关闭，GPU 机由 operator 显式启用。

实现不再等待产品选型；现场首次安装前只需提供 agent 可达的稳定服务器地址以及异机/NAS 备份
目标。启用 Swift 时还需提供 GPU device id，并提前把模型放入 `/srv/databench/swift-models`。
需要更细粒度网络隔离时再提供可选 CIDR。未提供备份目标时可以测试安装，但不得标记为
production-ready。

## 17. 决策记录要求

本方案让 MinIO 从“本地开发 backend”扩展为“隔离内网单机 production backend”。
[ADR 0012](../decisions/0012-offline-single-host-deployment.md) 已接受并修订 ADR 0008，明确：

- 阿里云生产仍使用 OSS；
- on-prem/offline 生产允许使用 MinIO；
- 两者通过同一个 `Store` 接口选择，不改变业务调用方；
- 该离线部署决策是“新增部署目标”，不是替换已有生产平台。

该决策只授权新增 `deploy/offline/**` 发布通道，不替换现有 ECS/OSS 发布，也不解决公共云 API
托管平台 D3。实现仍按 P0..P4 独立闸门推进。
