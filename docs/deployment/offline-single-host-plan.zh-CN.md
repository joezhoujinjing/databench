# Databench 内网单机离线发布方案

> **状态：Draft / 仅方案，不进入实现。**
>
> 本文记录 D3 的一个新增部署目标：在**没有公网、没有内部镜像仓库**的环境中，
> 将 Databench 一键安装到单台 Ubuntu。现有阿里云 ECS、RDS、OSS/CDN 发布链保持
> 不变；本方案只新增一条并列的离线发布通道。

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
                    │ Web + API + PG + MinIO       │
                    └─────────────────────────────┘
```

目标操作体验：

```bash
tar -xzf databench-offline-<version>-linux-amd64.tar.gz
cd databench-offline-<version>
sudo ./install.sh
```

目标机安装期间和运行期间均不执行 `docker pull`、`pnpm install`，也不访问 GitHub、
npm registry 或其他公网服务。

## 2. 范围与非目标

### 2.1 本方案覆盖

- 联网环境构建 API/Web 应用镜像；
- 拉取并锁定 PostgreSQL、MinIO、MinIO Client 等第三方镜像；
- 将所有镜像和部署资产组装为一个带校验值的离线包；
- 在干净 Ubuntu 上一键导入、初始化、迁移、启动和冒烟；
- 首次安装自动生成密码并写入服务器 `.env`；
- 后续离线升级、失败回滚、备份和恢复；
- 宿主机重启后的自动恢复和持久化；
- 只开放 Web 入口，API/PG/MinIO 走容器内部网络。

### 2.2 本方案不覆盖

- 不替换或修改现有 `deploy/ecs/**` 及其 GitHub Actions；
- 不在当前代码大重构期间冻结 API、数据库或对象 key 的最终形态；
- 不实现多机高可用、Postgres 主从或 MinIO 分布式集群；
- 不把 Docker Engine 混进每个业务版本包；
- 不把生产密码、证书或用户数据打进镜像/离线包；
- 不把 MinIO 重新定义为所有生产环境的默认对象存储。

## 3. 与当前代码重构的边界

离线交付机制的大部分内容与业务代码无关，但最终实现必须依赖一层稳定的“部署契约”。
在重构完成前只接受本文方案，不开始写最终 Compose、镜像和脚本。

### 3.1 不受业务重构影响的通用部分

- `docker buildx`、`docker save/load` 和离线包校验；
- Docker Compose 的单机网络、持久化、日志轮转和重启策略；
- PostgreSQL/MinIO 的生命周期；
- 密码生成、配置文件权限和升级时复用旧 secret；
- 安装器、备份器、恢复器和版本切换框架；
- 联网构建、人工传输、内网安装的责任边界。

### 3.2 重构完成后必须重新确认的应用契约

| 契约 | 当前候选值 | 重构后的确认要求 |
|---|---|---|
| API 架构 | Node 22 + Linux 原生插件 | 明确支持的 `linux/amd64`/`arm64` |
| API 监听 | 容器内 `8000` | 保持或在发布清单显式版本化 |
| API 启动 | `node apps/api/dist/index.js` | 由最终 Dockerfile 固定 |
| 数据库 | `DATABASE_URL` + Prisma | 明确 migration 命令和回滚边界 |
| 对象存储 | `DATABENCH_OBJECT_STORE=s3` + `S3_*` | 确认 MinIO adapter 仍受支持 |
| 健康检查 | `/health` | 另有真正检查 PG/MinIO 的 readiness |
| Web API base | 同源空 base | 确认前端仍支持同源路由 |
| OpenAPI/业务路径 | `/v1/*` + meta paths | 网关 matcher 与最终路径同步 |
| 临时空间 | 容器 `/tmp` | 按最大上传/处理中间文件设容量 |

如果重构改变以上任一项，只调整应用镜像和契约适配层，不改变离线包的总体流程。

## 4. 单机运行拓扑

```text
内网用户
   │
   ▼ 80/443（唯一业务入口）
┌───────────────────────────────┐
│ Web Gateway                   │
│ Caddy + apps/web 静态产物     │
│ /v1、meta paths → api:8000    │
│ 其他路径 → SPA index.html     │
└──────────────┬────────────────┘
               ▼
┌───────────────────────────────┐
│ Databench API                 │
│ Node 22 + Hono + nodejs-polars│
└───────────┬───────────┬───────┘
            │           │
            ▼           ▼
     PostgreSQL 17     MinIO
     catalog/control   Parquet/vocab data
```

计划中的 Compose 服务：

| 服务 | 作用 | 宿主机端口 | 持久化 |
|---|---|---:|---|
| `web` | Caddy + Vite 静态文件 + API 反代 | `80`，可选 `443` | 证书/网关状态按 TLS 方案决定 |
| `api` | Databench API | 不映射 | 临时目录，可选 workspace volume |
| `postgres` | catalog/control plane | 不映射 | `/srv/databench/postgres` |
| `minio` | Parquet/vocabulary data plane | 不映射 | `/srv/databench/minio` |
| `minio-init` | 首次/幂等创建 bucket | 不映射 | 无，一次性任务 |
| `migrate` | `prisma migrate deploy` | 不映射 | 无，一次性任务 |

MinIO Console 默认不对业务网段开放；需要管理时使用 SSH 隧道或临时仅绑定
`127.0.0.1`。Postgres、MinIO 和 API 不能发布到 `0.0.0.0`。

## 5. 离线发布物规范

### 5.1 文件名

```text
databench-offline-<app-version>-linux-<arch>.tar.gz
databench-offline-<app-version>-linux-<arch>.tar.gz.sha256
```

版本必须唯一，禁止覆盖已经生成的同名发布物。

### 5.2 包内结构

```text
databench-offline-<app-version>/
├── images.tar                 # docker load 的完整镜像集合
├── images.lock               # image name/tag/digest/platform
├── compose.yml
├── release.env               # 只含版本和镜像名，不含 secret
├── env.example
├── caddy/Caddyfile
├── install.sh
├── upgrade.sh
├── rollback.sh
├── backup.sh
├── restore.sh
├── smoke.sh
├── RELEASE.txt               # git SHA、构建时间、平台、工具版本
└── SHA256SUMS                 # 包内文件校验
```

外层 `.sha256` 在解包前校验整个发布物；`SHA256SUMS` 在解包后再次校验关键文件。

### 5.3 镜像集合

- `databench-api:<app-version>`；
- `databench-web:<app-version>`，最终层包含 Caddy 和静态 Web；
- 精确版本/摘要的 PostgreSQL 镜像；
- 精确版本/摘要的 MinIO 镜像；
- 精确版本/摘要的 MinIO Client 镜像。

Compose 只引用 `release.env` 中的精确镜像名，并设置 `pull_policy: never`；离线 Compose
中禁止 `build:`、`latest` 和未解析的外部镜像。

### 5.4 构建入口

核心入口是仓库内可重复执行的：

```bash
deploy/offline/build-bundle.sh <version> <linux/amd64|linux/arm64>
```

在它之上提供一个单独的、仅手动触发的 GitHub Actions workflow：

```text
workflow_dispatch(version, platform)
  → checkout 精确 commit
  → build API/Web
  → pull 第三方镜像
  → 记录 digest/platform
  → docker save
  → 生成校验值
  → 上传 Artifact
```

该 workflow **只生成包，不连接内网服务器，也不触发已有 ECS/OSS 发布**。如果 GitHub
Artifact 超出容量/时间限制，则在受控联网 Linux 构建机运行同一个脚本，产物格式不变。

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
2. 检查 Ubuntu 版本、CPU 架构、Docker Engine、Compose、磁盘、端口；
3. 拒绝含 `build:`、`latest`、缺失本地镜像或允许 pull 的离线配置；
4. `docker load` 导入全部镜像；
5. 创建 `/opt/databench-offline`、`/etc/databench`、`/srv/databench`；
6. 首次安装生成 secret，已有配置则原样复用；
7. 启动 PostgreSQL 和 MinIO 并等待健康；
8. 幂等创建 MinIO bucket；
9. 执行数据库 migration；
10. 启动 API 和 Web；
11. 执行 readiness 和完整生命周期冒烟；
12. 输出访问地址、配置位置、数据位置和运维命令。

任何一步失败都要输出明确的失败阶段和排障命令；不得删除已有数据，不得静默生成第二套
密码或覆盖配置。

### 6.3 安装成功输出

```text
Databench 安装成功

访问地址：http://<server-ip-or-hostname>
配置文件：/etc/databench/databench.env
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
S3_ACCESS_KEY_ID=databench
S3_SECRET_ACCESS_KEY=<generated-secret>
S3_FORCE_PATH_STYLE=true
DATABENCH_OBJECT_STORE=s3
```

约束：

- 文件 owner 为 `root:root`，权限 `0600`；
- 安装器自动构造并验证 URL encoding；
- secret 不写入镜像、Git、发布包、终端输出或日志；
- `install.sh`/`upgrade.sh` 发现现有配置时绝不覆盖；
- 升级不轮换密码；轮换是单独、显式、有备份的运维动作；
- Compose interpolation 后的配置属于敏感信息，不进入诊断包。

### 7.2 应用凭据与管理员凭据

正式实现时应优先为 API 创建最小权限的 Postgres 用户和 MinIO access key，不长期使用
Postgres superuser 或 MinIO root。首次版本若受限于 MinIO 自动化，可先保留 root 初始化，
但必须把“创建应用用户并降权”列为实现验收项。

## 8. Docker Engine 引导包

Docker Engine 是宿主机前置条件，不跟随每个 Databench 业务版本重复交付。为完全隔离环境
单独提供一次性的、按 Ubuntu 版本和架构构建的 bootstrap 包：

```text
databench-host-bootstrap-ubuntu24.04-amd64/
├── packages/*.deb
├── install-docker.sh
├── SHA256SUMS
└── README.txt
```

它包含 Docker Engine、containerd、Buildx/Compose plugin 的 `.deb` 及依赖。业务离线包只
检查版本，不擅自升级宿主机 Docker。

## 9. 升级、回滚和版本保留

### 9.1 升级入口

```bash
sudo ./upgrade.sh
```

升级顺序：

1. 校验新包与目标平台；
2. 检查目标版本高于/不同于当前版本；
3. 生成升级前 Postgres 备份并验证非空；
4. 导入新镜像，不停止旧服务；
5. 执行 migration；
6. 原子切换当前 `release.env`；
7. 重建 API/Web；
8. 冒烟通过后记录成功版本；
9. 保留至少上一版应用镜像和发布清单。

MinIO 数据对象是持久化数据，不随应用镜像升级；任何脚本禁止用 `docker compose down -v`。

### 9.2 回滚边界

```bash
sudo ./rollback.sh <previous-version>
```

- migration 向后兼容：切回旧 `release.env` 并重建 API/Web；
- migration 不向后兼容：停止写入，恢复升级前 Postgres 备份，再切旧镜像；
- 对象 key/layout 发生不可逆变化：必须由对应版本迁移设计提供双读/回填/恢复方案，通用
  发布脚本不能猜测；
- 回滚不自动删除新版本写入的 MinIO 对象，防止扩大数据损失。

这也是为什么最终升级/回滚实现要等当前大重构的数据模型和 identity/layout 方案稳定。

## 10. 备份与恢复

单机部署不是高可用。服务器或数据盘损坏会导致整体停机，因此上线前必须配置第二存储
位置（NAS、另一台内网服务器或离线介质）。同机 `/srv/databench/backups` 只能作为临时
中转，不能算最终备份。

`databenchctl backup` 至少产出：

- 一致性 PostgreSQL dump；
- MinIO bucket mirror/snapshot；
- 不含明文 secret 的版本和镜像清单；
- 独立校验值；
- 备份时间、应用版本、数据库 migration 版本。

`restore.sh` 是破坏性操作，必须要求显式 `--confirm`，恢复前再次备份当前状态，并在恢复
完成后运行完整生命周期冒烟。上线门要求在一台干净测试机上成功做过至少一次恢复演练。

## 11. 网络与安全

默认安全边界：

- 宿主机只对获准内网网段开放 `80/443`；
- SSH 只对管理网段开放；
- API、PG、MinIO 不发布宿主机端口；
- MinIO Console 默认关闭外部访问；
- 使用内部 DNS，例如 `databench.internal`；
- HTTPS 使用内部 CA；如果首发先用 HTTP，必须限定可信 VLAN，不能误暴露到公网；
- 宿主机防火墙和 Docker published ports 一起纳入端口扫描验收；
- 容器日志设置 `max-size`/`max-file`，防止写满系统盘。

当前 API 没有实际认证中间件；“在内网”不等于已鉴权。实现前必须在以下方案中拍板：

1. 仅受控网段访问（最低门槛）；
2. Caddy Basic Auth（快速但能力有限）；
3. 内部 OIDC/SSO 或 API Bearer 校验（正式多用户方案）。

离线发布框架不替业务层定义用户/RBAC，但必须允许网关认证配置，并确保 secret 不泄漏。

## 12. 可观测性与资源

### 12.1 健康检查

当前 `/health` 仅能作为进程 liveness。最终部署契约还需要 readiness，至少验证：

- Prisma 能连接 Postgres 且 migration 已应用；
- MinIO endpoint 可达且 bucket 存在；
- API 能完成一次只读业务查询。

安装后的 G-prod 冒烟还要实际执行一个最小的：

```text
ingest → persist → ref/query → export
```

以同时覆盖 Postgres 和 MinIO。

### 12.2 初始容量建议

仅作为首轮压测起点，不作为硬编码要求：

- 试运行：8 vCPU、32 GiB RAM；
- 大数据/多人并行：16 vCPU、64–128 GiB RAM；
- 系统盘：至少 100 GiB；
- 数据盘：预计保留 Parquet 数据的 1.5–2 倍，备份空间另算；
- 数据盘优先 NVMe，并监控磁盘剩余量、inode、I/O latency。

当前 ingest/transform 存在内存和临时文件峰值，最终规格必须用重构后的真实最大数据集做
压测；安装器只能检查最低值，不能替代容量规划。

## 13. 计划中的仓库结构

实现阶段拟新增，不改现有 ECS 发布资产：

```text
deploy/offline/
├── README.zh-CN.md
├── compose.yml
├── env.example
├── Caddyfile
├── Dockerfile.web
├── build-bundle.sh
├── install.sh
├── upgrade.sh
├── rollback.sh
├── backup.sh
├── restore.sh
├── smoke.sh
└── lib/
    ├── common.sh
    ├── config.sh
    └── health.sh

.github/workflows/
└── build-offline-bundle.yml
```

现有以下文件保持原行为：

```text
deploy/ecs/**
.github/workflows/deploy-backend.yml
.github/workflows/deploy-frontend.yml
```

## 14. 分阶段实施计划（重构完成后）

### P0：冻结部署契约

- 确认最终 API start/port/env/migration/readiness；
- 确认对象存储的 MinIO adapter 与 key/layout 兼容；
- 确认 Web 同源 API 行为；
- 拍板目标 Ubuntu、CPU 架构、内部域名/TLS 和认证方案；
- 新增或修订 ADR，允许 MinIO 作为该 on-prem 生产形态的数据面。

### P1：构建与发布物

- API/Web 镜像；
- 第三方镜像版本锁；
- `images.lock`、`RELEASE.txt`、双层 checksum；
- 本地构建脚本；
- 手动 GitHub workflow。

### P2：一键安装

- Compose；
- 自动 secret 和 `.env`；
- PG/MinIO 初始化；
- migration；
- liveness/readiness/full smoke；
- 幂等重跑和错误诊断。

### P3：运维闭环

- `databenchctl`；
- 升级/回滚；
- 备份/恢复；
- 日志轮转和容量预警；
- Docker bootstrap 包。

### P4：真离线验收

- 干净 Ubuntu，断开公网；
- 只导入发布包和 bootstrap 包；
- 一条命令安装；
- 重启宿主机后自动恢复；
- 完整生命周期；
- 新版本升级和失败回滚；
- 在另一台干净机恢复备份；
- 端口扫描仅见预期入口。

## 15. 验收门（G-offline）

全部满足才可称为“傻瓜式一键离线部署”：

- [ ] 不修改、不触发现有 ECS/OSS 发布链；
- [ ] 发布包从精确 git SHA 构建，包含完整镜像锁和 checksum；
- [ ] 目标机断网，安装过程无外部 DNS/HTTP 请求；
- [ ] `sudo ./install.sh` 在干净 Ubuntu 上一次成功；
- [ ] 首次安装自动生成 secret，权限 `0600`，终端/日志不泄漏；
- [ ] 重跑安装和执行升级不改变现有 secret；
- [ ] Compose 不含 `build:`、`latest`，所有服务 `pull_policy: never`；
- [ ] 宿主机只暴露批准的 Web/SSH 端口；
- [ ] migration、readiness 和 ingest→query→export 全通过；
- [ ] 宿主机重启后服务与数据恢复；
- [ ] 上一版本应用可回滚；
- [ ] PG + MinIO 备份可在干净环境恢复；
- [ ] 使用真实目标规模数据完成内存、CPU、磁盘和超时压测。

## 16. 实现前待 owner 最终确认

以下项目不阻塞方案评审，但阻塞 P0 后的实现：

1. 目标 Ubuntu 版本和 CPU 架构；
2. 内网域名、内部 CA/HTTPS 策略；
3. 访问控制：网段、Basic Auth 还是 OIDC/API auth；
4. 数据盘路径、容量和备份目标；
5. GitHub Artifact 是否能容纳完整镜像包，还是固定使用联网构建机；
6. 当前大重构完成后，最终 API/DB/object layout 的部署契约；
7. 是否把 Docker bootstrap 包纳入同一交付批次但保持独立版本。

## 17. 决策记录要求

本方案会让 MinIO 从“本地开发 backend”扩展为“隔离内网单机生产 backend”，与
ADR-0008 当前的生产 OSS 约束不同。因此在开始实现前必须新增或修订 ADR，明确：

- 阿里云生产仍使用 OSS；
- on-prem/offline 生产允许使用 MinIO；
- 两者通过同一个 `Store` 接口选择，不改变业务调用方；
- 该 D3 决策是“新增部署目标”，不是替换已有生产平台。

本文在 owner 接受并补齐上述部署契约前保持 Draft，不据此进入 S22 代码实现。
