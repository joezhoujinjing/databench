# Databench Ubuntu 单机离线部署与运维手册

本文面向实际执行构建、传输、安装和运维的人员。目标环境固定为：

- Ubuntu 22.04 LTS；
- amd64/x86_64；
- 单台服务器；
- 服务器无公网、无内部镜像仓库；
- Docker Engine 已预装；
- 允许升级和备份期间短暂停机。

如果只需要快速安装，先看 [README.zh-CN.md](README.zh-CN.md)。遇到错误时看
[TROUBLESHOOTING.zh-CN.md](TROUBLESHOOTING.zh-CN.md)。Agent 接入和 Excel 使用方式见
[MCP-AGENT-GUIDE.zh-CN.md](MCP-AGENT-GUIDE.zh-CN.md)。
EvalScope 模型 allowlist、容量、drain 与离线验收见
[EVALSCOPE-OPERATOR-GUIDE.zh-CN.md](EVALSCOPE-OPERATOR-GUIDE.zh-CN.md)。
Swift GPU、离线模型、训练与部署见
[SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md](SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md)。

## 1. 重要边界

1. 离线包不包含 Docker Engine，也不会在目标机安装或升级 Docker。
2. 安装和运行期间不会执行 `docker pull`、`docker build`、`pnpm install` 或访问公网。
3. 宿主机只发布 TCP 80。API、EvalScope 9000、Swift 7860/7861、Worker gRPC 50051、PostgreSQL、MinIO 和 MinIO Console
   不发布宿主机端口。
4. 当前 Web、REST 和 MCP 都没有应用层鉴权。服务器必须位于不暴露公网的可信内网；任何能访问
   TCP 80 的主体都有完整权限。CIDR/iptables 是可选加固，不是安装前置条件。
5. 单机部署没有高可用。生产数据必须备份到另一台机器、NAS 或离线介质。
6. 不要执行 `docker compose down -v`，不要删除 `/srv/databench`，不要手工清理数据库目录。
7. 应用版本只接受无前导零的三段数字，例如 `1.0.0`；不要使用 `v1.0.0`、`1.0` 或
   `1.0.0-rc.1`。

## 2. 交付物与角色

联网构建机负责生成：

```text
databench-offline-1.0.0-linux-amd64.tar.gz
databench-offline-1.0.0-linux-amd64.tar.gz.sha256
```

目标 Ubuntu 只接收并使用这两个文件。`.tar.gz` 包含八张 `linux/amd64` 镜像（API、Web、
CPU-only Worker、backend-only EvalScope、CUDA Swift Studio、PostgreSQL、MinIO、MinIO Client）、Compose、安装脚本、运维脚本、固定
smoke fixtures 和本文档。

已安装完整八镜像基线后的普通代码更新可以改用：

```text
databench-offline-update-0.7.5-to-0.7.6-linux-amd64.tar.gz
databench-offline-update-0.7.5-to-0.7.6-linux-amd64.tar.gz.sha256
```

增量包只包含变化的应用镜像和 `upgrade.sh`，不包含 `install.sh`，不能用于首次安装。

历史五镜像包实测：

- `images.tar`：约 412 MB；
- 最终 `.tar.gz`：约 409.4 MiB；
- 当前 CPU-only Worker 单镜像约 499 MiB；
- 2026-07-27 六镜像记录只代表 EvalScope 纳入前的旧 bundle；当前八镜像体积必须按当次构建记录；
- 正式交付必须记录当次完整归档的实际大小和 SHA-256；
- 业务数据和备份不包含在该体积中。

建议职责：

| 角色 | 责任 |
|---|---|
| 发布人员 | 从干净 Git 提交构建离线包，记录版本、Git SHA 和 SHA-256 |
| 传输人员 | 同时传输归档与 `.sha256`，不改名、不二次压缩 |
| 现场管理员 | 检查目标机、执行安装、确认不暴露公网、完成验收 |
| 备份管理员 | 将数据备份、匹配发布包和 `backup.key` 分开保存到异机 |

## 3. 联网构建机操作

### 3.1 构建机要求

- 能访问 npm registry 和 Docker Hub；
- Docker daemon 正常；
- Docker Buildx 可用；
- Docker 支持 `docker image save --platform`，建议 Docker 28 或更新版本；
- Git 工作树干净；
- 建议至少预留 50 GiB 可用空间给 Worker/Swift 依赖、镜像层、构建缓存和归档。

检查命令：

```bash
git status --short
docker version
docker compose version
docker buildx version
df -h .
```

`git status --short` 必须没有输出。构建脚本会拒绝 dirty worktree，确保发布物能追溯到唯一
Git SHA。

### 3.2 本地构建

在仓库根目录执行：

```bash
deploy/offline/build-bundle.sh 1.0.0
```

默认产物：

```text
output/offline/databench-offline-1.0.0-linux-amd64.tar.gz
output/offline/databench-offline-1.0.0-linux-amd64.tar.gz.sha256
```

脚本会自动执行以下操作：

1. 固定 `linux/amd64` 构建 API、Web、CPU-only Python Worker、pinned backend-only EvalScope 和 CUDA Swift Studio；
2. 拉取精确版本的 PostgreSQL 17、MinIO 和 MinIO Client；
3. 检查八张镜像的 OS、架构和内容 ID；
4. 在 amd64 仿真下执行镜像 executable smoke，确认 Worker CPU-only、EvalScope 无原生 Web/CUDA/NVIDIA
   包且本地 Plotly asset 存在，并确认 Swift Provider 与完整原生 Gradio 可在无 GPU 构建机启动；
5. 生成 `images.lock`、`release-manifest.json` 和 `RELEASE.txt`；
6. 生成包内 `SHA256SUMS`；
7. 生成外层归档和 `.sha256`。

构建成功后，在构建机再次检查：

```bash
cd output/offline
sha256sum -c databench-offline-1.0.0-linux-amd64.tar.gz.sha256
ls -lh databench-offline-1.0.0-linux-amd64.tar.gz*
```

预期看到：

```text
databench-offline-1.0.0-linux-amd64.tar.gz: OK
```

不要只传 `.tar.gz`；必须同时传对应的 `.sha256`。

### 3.3 非向后兼容数据库迁移

普通发布默认：

```text
database_migration=expand-only
rollback_mode=image-only
```

只有发布者确认数据库迁移不能向后兼容时，才使用：

```bash
DATABASE_MIGRATION=restore-on-rollback \
ROLLBACK_MODE=restore-backup \
deploy/offline/build-bundle.sh 2.0.0
```

这种发布的回滚会恢复升级前备份，停机更长。PostgreSQL major、MinIO 数据格式或对象布局迁移
不属于通用升级，必须单独设计，不能只修改这两个变量。

### 3.4 构建增量升级包

保留最近完整包的 `.sha256` 后，可以自动分析基线 Git revision 与当前提交之间的变化：

```bash
deploy/offline/build-update-bundle.sh 0.7.5 0.7.6
```

也可以显式限制组件：

```bash
deploy/offline/build-update-bundle.sh 0.7.5 0.7.6 --components web
deploy/offline/build-update-bundle.sh 0.7.5 0.7.6 --components api,web
```

允许的组件为 `api,web,worker,evalscope,swift`。脚本只构建、smoke、保存列出的镜像，并生成
`changed-images.lock` 和精确绑定基线 bundle SHA-256 的 `update-manifest.json`。如果本地没有
基线 API 镜像，可加 `--base-ref <git-ref>`；如果基线校验文件不在默认输出目录，可加
`--base-checksum <path>`。

增量包只适用于应用镜像内容变化。Compose、安装/升级基础框架、第三方基础镜像、服务集合、
持久化布局或对象迁移变化时必须构建新的完整包。

## 4. 目标 Ubuntu 安装前检查

### 4.1 硬件和软件最低要求

- Ubuntu 22.04 LTS；
- `uname -m` 为 `x86_64`；
- Docker Engine 24.0.0 或更新版本；
- Docker Compose plugin 2.20.0 或更新版本；
- UI-only/不训练模式至少 6 logical CPUs；
- UI-only/不训练模式下 `/proc/meminfo` 至少显示 15 GiB RAM；
- 根文件系统至少 60 GiB 可用空间；
- `/srv/databench` 所在文件系统至少 12 GiB 可用空间；
- TCP 80 未被其他容器发布；
- 已确定 agent 可达的稳定内网 IP 或 DNS，用于 `http(s)://<host>/api`；
- 管理员具备 `sudo` 权限。

显式启用 Swift GPU mode 时提高到 12 logical CPUs/40 GiB RAM，并要求 NVIDIA 驱动、NVIDIA
Container Toolkit 和已经离线预置的模型目录；安装器会
运行一次短暂 `torch.cuda.is_available()` 检查，不执行训练。

试运行容量建议为 12 vCPU、48 GiB RAM、100 GiB 系统盘。真实生产规格应根据最大数据集、
EvalScope 模型请求并发和在线报告保留周期另做压测。

### 4.2 现场检查命令

```bash
cat /etc/os-release
uname -m
getconf _NPROCESSORS_ONLN
awk '/^MemTotal:/ {printf "%.1f GiB\n", $2/1024/1024}' /proc/meminfo
docker version --format 'server={{.Server.Version}}'
docker compose version --short
docker info >/dev/null && echo 'docker daemon: OK'
df -h /
df -h /srv/databench 2>/dev/null || true
docker ps --filter publish=80 --format 'table {{.Names}}\t{{.Ports}}'
```

预期：

- `VERSION_ID="22.04"`；
- `x86_64`；
- Docker server 不低于 24；
- Compose 不低于 2.20；
- UI-only/不训练模式 logical CPUs 不低于 6，RAM 不低于 15 GiB；
- 根文件系统可用空间不低于 60 GiB；
- `/srv/databench` 所在文件系统可用空间不低于 12 GiB；
- 端口检查没有其他容器占用 80。

安装脚本会重复这些检查，不满足时直接退出，不会修改数据。

## 5. 传输、校验和解压

将以下两个文件放到目标机同一目录：

```text
databench-offline-1.0.0-linux-amd64.tar.gz
databench-offline-1.0.0-linux-amd64.tar.gz.sha256
```

传输方式可以是移动介质、SFTP、SCP、SMB 或内网文件服务器。传输后执行：

```bash
sha256sum -c databench-offline-1.0.0-linux-amd64.tar.gz.sha256
```

必须显示 `OK`。失败时不要解压或安装，重新传输两个文件。

解压时不要删除、移动或重命名旁边的原始归档和校验文件：

```bash
tar -xzf databench-offline-1.0.0-linux-amd64.tar.gz
cd databench-offline-1.0.0-linux-amd64
```

`install.sh` 和 `upgrade.sh` 会再次检查旁边的原始归档、外层 SHA-256 和包内 `SHA256SUMS`。

可先查看发布身份：

```bash
cat RELEASE.txt
cat release-manifest.json
```

这些文件不含密码。

## 6. 首次安装

### 6.1 执行安装

在解压目录执行。服务器必须位于不暴露公网的可信内网；匿名 MCP 启动后没有第二层认证，任何能
访问 TCP 80 的主体都有完整权限。首次安装必须显式提供 agent 可达的稳定 public base，安装器
不会从 Host、容器名或 `hostname -I` 猜测：

```bash
sudo env DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api ./install.sh
```

GPU 机显式启用：

```bash
sudo env \
  DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api \
  DATABENCH_ENABLE_SWIFT_STUDIO=true \
  DATABENCH_ENABLE_SWIFT_GPU=true \
  ./install.sh
```

控制面只需要显示 Swift 原生界面时使用：

```bash
sudo env \
  DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api \
  DATABENCH_ENABLE_SWIFT_STUDIO=true \
  DATABENCH_SWIFT_RUNTIME_MODE=ui-only \
  ./install.sh
```

不要手工改脚本，也不要在脚本前手工 `docker load`。Public base 必须是绝对 HTTP(S) URL，path
精确为 `/api`，且不含 credential、query、fragment 或尾随 `/`；DNS 使用小写，默认 HTTP(S)
端口必须省略，非默认端口使用无前导零的十进制。
安装器会按固定顺序完成：

1. 校验外层和包内 SHA-256；
2. 检查 OS、架构、Docker、Compose、磁盘和端口；
3. 创建安装、配置和数据目录；
4. 自动生成数据库、MinIO、应用访问、v2 cursor、Deployment、EvalScope 和 Swift Provider secret，
   把显式 MCP public base 写入独立的 `/etc/databench/mcp.env`，并创建稳定的
   `/etc/databench/evalscope.env` 与 `/etc/databench/swift.env`；
5. 导入八张离线镜像；
6. 启动 PostgreSQL 和 MinIO；
7. 创建 MinIO bucket、应用用户和 bucket-scoped policy；
8. 执行 `prisma migrate deploy`；
9. 启动 Worker，等待标准 gRPC health 为 `SERVING`；
10. 启用时先启动 Swift Studio，再按 API → EvalScope → Web 启动其余应用服务；
11. 执行 doctor、Caddy proxy、MCP SDK/companion、固定数据集和 `basic-clean@1` 生命周期 smoke；
12. 安装 `/usr/local/bin/databenchctl`。

安装期间出现的密码不会输出到终端或日志。

上述环境变量只用于首次创建 `/etc/databench/mcp.env`。创建成功后，重跑安装直接执行：

```bash
sudo ./install.sh
```

正常升级同样不需要再次传入。只有从完全不包含 MCP 配置的旧版本首次升级时，才需要为
`upgrade.sh` 再提供一次。

### 6.2 安装成功输出

成功时最后会显示类似：

```text
Databench installation succeeded

URL: http://10.0.0.10
Configuration: /etc/databench/databench.env
MCP endpoint: http://10.0.0.10/api/mcp
Data: /srv/databench
Version: 1.0.0
```

如果脚本中途失败，先检查 `/etc/databench/mcp.env` 是否已经创建。已创建时，修正原因后执行
`sudo ./install.sh`；尚未创建时，重新执行 6.1 中带 `DATABENCH_MCP_PUBLIC_BASE_URL` 的首次安装
命令。脚本会复用已经生成的 secret，不会静默创建第二套配置。

## 7. 安装后验收

### 7.1 服务状态和依赖

```bash
sudo databenchctl version
sudo databenchctl status
sudo databenchctl doctor
docker inspect --format '{{.State.Health.Status}}' databench-offline-worker
docker inspect --format '{{.State.Health.Status}}' databench-offline-evalscope
```

doctor 成功的精确输出为：

```json
{"database":{"ok":true},"evalscope":{"ok":true},"store":{"ok":true}}
```

Worker 与 EvalScope inspect 都必须输出 `healthy`。安装 smoke 还会提交一次 `basic-clean@1`，验证结果 Dataset、
lineage 和重复提交的 deterministic reuse；因此安装成功不仅表示 gRPC 端口打开，也表示完整处理链可用。

### 7.2 HTTP 检查

在服务器本机执行：

```bash
curl -fsS http://127.0.0.1/api/health
curl -fsS http://127.0.0.1/api/version
curl -fsS http://127.0.0.1/api/capabilities
curl -fsS 'http://127.0.0.1/api/v2/refs?limit=1'
curl -fsS 'http://127.0.0.1/api/v2/transforms'
curl -fsS 'http://127.0.0.1/evalscope-api/health'
curl -fsS 'http://127.0.0.1/evalscope-api/api/v1/config'
curl -fsS 'http://127.0.0.1/datasets' | grep -F '<div id="root"></div>'
```

`/api/version` 中的 `service_version` 必须等于本次安装版本。离线部署的浏览器页面仍保持
无版本产品路径，只有 API 调用使用 `/api/v2/...`；Caddy 转发时会去掉 `/api` 前缀，后端内部契约不变。
`/api/openapi.json` 会声明相对 server URL `/api`，使用该文档生成的客户端也会走正确的网关
前缀。

从获准内网客户端访问：

```text
http://<服务器IP或内部DNS>
```

确认 SPA 能打开，并能完成一次实际业务查询。还需要直接打开
`http://<服务器IP或内部DNS>/datasets` 并刷新一次；刷新后必须仍显示数据集页面。打开浏览器
Network 面板，API Request URL 应以 `/api/` 开头，响应 `Content-Type` 应为
`application/json`，不能是 `text/html`。

从目标 agent 配置 Streamable HTTP endpoint：

```text
http://<服务器IP或内部DNS>/api/mcp
```

不配置用户名、密码或 bearer token。确认 agent 可以 initialize、看到四个 tools，并能访问
prepare 返回的同一 `/api` base 下绝对 PUT/GET URL。随后按
[MCP-AGENT-GUIDE.zh-CN.md](MCP-AGENT-GUIDE.zh-CN.md) 用真实 Excel 完成三种意图验收。

### 7.3 端口检查

```bash
sudo ss -lntp
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Databench 业务容器只应看到宿主机 `0.0.0.0:80->80/tcp`。Worker 50051、PostgreSQL 5432、
MinIO 9000/9001 和 API 8000 不应发布到宿主机。API 使用 Compose DNS `worker:50051`，不固定
Docker 子网，因此从历史五镜像版本升级时不需要重建已有网络。

### 7.4 网络边界与可选防火墙加固

安装器不会修改宿主机防火墙。只要企业网络已经保证服务器和 TCP 80 不暴露公网，安装前不要求
再配置 CIDR allowlist 或 iptables。当前无应用认证，因此整个可访问内网都被视为可信边界；所有
能访问 TCP 80 的主体都有完整 Web、REST 与 MCP 权限。

MCP 对浏览器请求的 `Origin` 校验仍然生效；它是浏览器协议安全能力，不是 CIDR 网络限制，也不
会为普通无 `Origin` 的 code agent 提供身份认证。

如果现场需要把访问进一步限制到特定 agent/用户网段，可以优先使用企业边界防火墙或云/虚拟化
平台安全策略。若选择使用 Docker 的 `DOCKER-USER` 链，可在变更窗口参考以下可选模板，先替换
`<APPROVED_CIDR>`：

```bash
sudo iptables -I DOCKER-USER 1 -s <APPROVED_CIDR> -p tcp --dport 80 -j ACCEPT
sudo iptables -A DOCKER-USER -p tcp --dport 80 -j DROP
sudo iptables -L DOCKER-USER -n --line-numbers
```

规则持久化方式取决于现场网络规范，本发布包不安装 `iptables-persistent`。启用可选 allowlist 后，
应分别从获准和未获准客户端验证；未启用时只需确认不存在公网路由、端口映射或安全组放行。

## 8. 安装目录、数据和 secret

| 路径 | 内容 | 是否可删除 |
|---|---|---|
| `/opt/databench-offline/releases/<version>` | 各版本部署脚本和 release manifest | 稳定前不要删除 |
| `/opt/databench-offline/current` | 当前版本原子软链接 | 不要手工改，使用升级/回滚脚本 |
| `/opt/databench-offline/state` | current/previous/backup marker | 不要删除 |
| `/etc/databench/databench.env` | 数据库、MinIO 和 v2 secret | 不要提交、打印或随意编辑 |
| `/etc/databench/mcp.env` | 匿名模式与 agent 可达 public base | 维护窗口显式修改，禁止改成公网 URL |
| `/etc/databench/evalscope.env` | EvalScope stable secrets、model allowlist 与容量 | 维护窗口修改，保持 0600 |
| `/etc/databench/backup.key` | 备份配置 escrow 加密密钥 | 必须异机单独保存 |
| `/srv/databench/postgres` | PostgreSQL 数据目录 | 禁止手工修改 |
| `/srv/databench/minio` | MinIO 对象数据 | 禁止手工修改 |
| `/srv/databench/workspace` | API 临时/工作空间 | 保留 |
| `/srv/databench/evalscope/outputs` | EvalScope 在线报告、task claim | 禁止手工修改 |
| `/srv/databench/evalscope/inputs` | exact Dataset 输入 staging | 由服务管理 |
| `/srv/databench/backups` | 本机备份中转 | 不能作为唯一备份 |

检查权限但不要输出内容：

```bash
sudo stat -c '%U:%G %a %n' \
  /etc/databench/databench.env /etc/databench/mcp.env \
  /etc/databench/evalscope.env /etc/databench/backup.key
```

四个文件都应为 `root:root 600`。

升级不会轮换 secret。需要轮换时必须另做维护方案和恢复演练，不要直接编辑 `.env` 后只重启
部分容器。

## 9. 日常运维

### 9.1 状态、版本和日志

```bash
sudo databenchctl version
sudo databenchctl status
sudo databenchctl doctor
sudo databenchctl logs
sudo databenchctl logs api
sudo databenchctl logs worker
sudo databenchctl logs evalscope
sudo databenchctl logs swift-studio
sudo databenchctl logs web
sudo databenchctl logs postgres
sudo databenchctl logs minio
```

`logs` 默认显示最近 200 行并持续跟随，按 `Ctrl-C` 退出。

### 9.2 重启应用

```bash
sudo databenchctl restart
```

该命令先确认 Swift 没有原生任务、停止 Web、drain EvalScope，再停止 API/EvalScope/Worker/Swift；
随后按 Worker → Swift → API → EvalScope → Web
启动，等待健康后运行 doctor。
它不会删除或重建数据。

需要检查 Docker 自启动策略：

```bash
sudo systemctl is-enabled docker
sudo systemctl is-active docker
docker inspect --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' \
  databench-offline-postgres databench-offline-minio databench-offline-worker \
  databench-offline-evalscope databench-offline-swift-studio \
  databench-offline-api databench-offline-web
```

## 10. 备份

### 10.1 创建一致性备份

```bash
sudo databenchctl backup
```

备份会拒绝活动 Swift 原生任务，停止 Web admission、drain EvalScope 并停止 API/EvalScope/Worker/Swift，
依次生成 PostgreSQL custom dump、MinIO bucket mirror、EvalScope output/input volume、启用时的 Swift Session
workspace、migration 列表、版本清单、校验文件和加密的 Databench/MCP/EvalScope/Swift 配置 escrow，
然后按 Worker → Swift → API → EvalScope → Web 重新启动服务并运行 doctor。Swift 模型缓存和
`/srv/databench/swift-models` 使用独立备份，不会被普通恢复删除。

成功时输出 generation 路径，例如：

```text
/srv/databench/backups/20260724T120000Z-a1b2c3d4
```

验证：

```bash
sudo bash -c 'cd /srv/databench/backups/20260724T120000Z-a1b2c3d4 && sha256sum -c SHA256SUMS'
```

### 10.2 必须异机保存的三部分

每个可恢复点必须同时找到：

1. `/srv/databench/backups/<generation>`；
2. `backup-manifest` 中匹配文件名和 SHA-256 的完整离线发布包；
3. `/etc/databench/backup.key` 的安全副本。

示例（挂载好的 NAS 路径仅作占位）：

```bash
sudo rsync -a /srv/databench/backups/20260724T120000Z-a1b2c3d4/ \
  <NAS_MOUNT>/databench/backups/20260724T120000Z-a1b2c3d4/
sudo install -m 0600 /etc/databench/backup.key <SECURE_KEY_MOUNT>/databench-backup.key
```

不要把唯一的 `backup.key` 与唯一备份放在同一块服务器磁盘。普通 generation 不需要重复复制
`images.tar`。完整版本保存一份匹配完整包；增量版本必须同时保存最近完整包，以及从该完整
版本到当前版本的连续增量包。

## 11. 离线升级

### 11.1 升级前检查

1. 已有最近一次异机备份；
2. 新包版本严格高于当前版本；
3. 新归档和 `.sha256` 已传到服务器；
4. 有可接受的维护窗口；
5. 当前 doctor 正常。

```bash
sudo databenchctl version
sudo databenchctl doctor
sha256sum -c databench-offline-1.1.0-linux-amd64.tar.gz.sha256
```

若使用增量包，还必须确认当前版本就是文件名中的 base version；脚本会进一步校验当前安装记录中
原始发布包的 SHA-256，不能跨版本跳装。

升级不再执行首次安装的 CPU/RAM/磁盘固定容量门槛。它仍会检查 Ubuntu/amd64、
Docker/Compose 版本、TCP 80，以及显式 GPU mode 所需的 NVIDIA runtime；备份或镜像写入实际
空间不足仍会在激活目标版本前失败并恢复旧版。

### 11.2 执行升级

```bash
tar -xzf databench-offline-1.1.0-linux-amd64.tar.gz
cd databench-offline-1.1.0-linux-amd64
sudo ./upgrade.sh
```

增量包使用完全相同的入口：

```bash
sha256sum -c databench-offline-update-0.7.5-to-0.7.6-linux-amd64.tar.gz.sha256
tar -xzf databench-offline-update-0.7.5-to-0.7.6-linux-amd64.tar.gz
cd databench-offline-update-0.7.5-to-0.7.6-linux-amd64
sudo ./upgrade.sh
```

上式适用于已有 `/etc/databench/mcp.env` 的正常升级。首次从不含 MCP 配置的旧版本升级时，才需
提供一次稳定 public base：

```bash
sudo env DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api ./upgrade.sh
```

脚本会在停止写入前校验并原子创建独立配置，不修改已有 secret。文件已存在时脚本自动复用；如果
仍显式传入变量，其值必须与已持久化值完全一致。回滚到不包含 M2 配置的旧 release 时，该旧
Compose 不会加载 `mcp.env`，MCP 随旧版停用。

升级会：

1. 验证新包、版本范围、PostgreSQL major 和 rollback contract；
2. 停止 Web admission，拒绝活动 Swift 原生任务，drain EvalScope，active task 归零后停止 API/EvalScope/Worker/Swift；
3. 创建并校验升级前一致性备份；
4. 完整包导入八张镜像；增量包只导入变化镜像，并与已安装基线合成新的完整八镜像 release lock；
5. 执行 migration；
6. 按 Worker → Swift（启用时）→ API → EvalScope → Web 启动目标版本；
7. 执行 doctor、gateway、MCP、数据集和 `basic-clean@1` 生命周期 smoke；
8. 全部成功后才原子切换 `current`。

成功后检查：

```bash
sudo databenchctl version
sudo databenchctl status
sudo databenchctl doctor
curl -fsS http://127.0.0.1/api/version
```

实际容器镜像与版本必须一致：

```bash
docker inspect --format '{{.Config.Image}}' \
  databench-offline-worker databench-offline-api databench-offline-evalscope \
  databench-offline-web
```

### 11.3 升级失败

从停止应用服务起，升级脚本安装了失败恢复 trap。备份、镜像、migration、
Worker/API/EvalScope/Web
启动、doctor 或 smoke
任一步失败，脚本会停止目标版本并重新启动 previous release。命令仍会非零退出，便于监控
发现升级失败。

失败后立即执行：

```bash
sudo databenchctl version
sudo databenchctl status
sudo databenchctl doctor
curl -fsS http://127.0.0.1/api/version
```

若输出提示 `automatic recovery failed`，不要继续尝试新升级；保留终端输出、两个 release 和
升级前备份，按故障排查手册的“升级恢复失败”处理。

## 12. 回滚

查看已安装 release：

```bash
sudo ls -1 /opt/databench-offline/releases
sudo databenchctl version
```

普通 `image-only` 发布回滚：

```bash
sudo databenchctl rollback 1.0.0
```

当前发布声明 `restore-backup` 时，必须提供升级前 generation：

```bash
sudo databenchctl rollback 1.0.0 \
  --backup 20260724T120000Z-a1b2c3d4
```

回滚前脚本会再创建一份安全备份。回滚成功后执行 version、doctor 和 HTTP 验收。脚本不会自动
删除较新 release、镜像或对象，避免扩大数据损失。

## 13. 恢复备份

### 13.1 原机恢复

恢复会覆盖当前 PostgreSQL catalog 和 MinIO bucket，必须在维护窗口执行：

```bash
sudo databenchctl restore 20260724T120000Z-a1b2c3d4 --confirm
```

默认流程会先为当前状态创建安全备份，再恢复指定 generation，执行 migration、doctor 和完整
smoke。恢复版本对应的 release 必须仍在 `/opt/databench-offline/releases`，且其离线包
SHA-256 必须与 backup manifest 一致。

### 13.2 干净机器恢复

在另一台满足要求的 Ubuntu 22.04 amd64 上：

1. 找到 backup manifest 指定的同版本完整离线包；
2. 按第 4～7 节完成该版本的全新安装；
3. 将 generation 完整复制到 `/srv/databench/backups/<generation>`；
4. 校验 generation 的 `SHA256SUMS`；
5. 执行显式恢复；
6. 完成 HTTP、doctor 和数据抽样验收。

示例：

```bash
sudo install -d -m 0750 /srv/databench/backups/20260724T120000Z-a1b2c3d4
sudo rsync -a <NAS_MOUNT>/databench/backups/20260724T120000Z-a1b2c3d4/ \
  /srv/databench/backups/20260724T120000Z-a1b2c3d4/
sudo bash -c 'cd /srv/databench/backups/20260724T120000Z-a1b2c3d4 && sha256sum -c SHA256SUMS'
sudo databenchctl restore 20260724T120000Z-a1b2c3d4 --confirm
```

恢复前读取 generation 的 `backup-manifest`。若 `swift_enabled=true`，新机器必须先预置模型并以
`DATABENCH_ENABLE_SWIFT_GPU=true` 安装同版本；若为 `false`，保持默认关闭。恢复脚本要求当前
`/etc/databench/swift.env` 的启用状态与 manifest 完全一致，不会把 disabled generation 和已有
Swift workspace 混在一起。

恢复脚本不会用备份里的 `databench.env.enc` 覆盖新机器当前配置。逻辑数据库 dump 和对象 mirror
使用新机器安装时生成的凭据恢复；加密配置 escrow 与独立 `backup.key` 用于审计和人工取证，
不应直接替换新 PostgreSQL/MinIO 已初始化的凭据。

## 14. 宿主机重启验收

维护窗口执行：

```bash
sudo reboot
```

机器恢复后：

```bash
sudo systemctl is-active docker
sudo databenchctl status
sudo databenchctl doctor
curl -fsS http://127.0.0.1/api/version
```

再从获准内网客户端访问 Web，抽查已有数据仍可读取。重启验收不应执行重新安装。
重启会使全部一次性 MCP URL 失效；目标 agent 必须重新 prepare，再确认导入/导出恢复。

## 15. 上线验收清单

- [ ] 归档外层 SHA-256 为 `OK`；
- [ ] 目标机为 Ubuntu 22.04 amd64；
- [ ] Docker/Compose 版本满足最低要求；
- [ ] UI-only/不训练模式的 CPU、RAM、系统盘、Databench 数据盘可用空间分别满足 6 logical CPUs、
      15 GiB、60 GiB、
      12 GiB 的最低要求；
- [ ] 首次安装使用稳定 public base 执行 `install.sh`，并一次成功；
- [ ] `databenchctl version` 与发布版本一致；
- [ ] `databenchctl doctor` 的 database/evalscope/store 均为 true；启用 Swift 时 `swift.gpu/ok` 也为 true；
- [ ] Worker 和 EvalScope 均为 `healthy`，安装 smoke 已完成 `basic-clean@1`、lineage、
      deterministic reuse、EvalScope path-free config、local Plotly 和 operator drain/resume；
- [ ] `/api/version` 的 `service_version` 正确；
- [ ] `/etc/databench/mcp.env` 为 `root:root 0600`，public base 是实际 agent 可达的 `/api`；
- [ ] 目标 agent 经 `/api/mcp` 完成 Excel direct import、preview/修改后 import 和 JSONL-only；
- [ ] MCP/companion 的 prepare URL、单次消费、重启失效、abort 清理和 exact-byte replay 已通过；
- [ ] API、Caddy 和现场前置代理日志不包含完整 `proc_*` / `exp_*` token；
- [ ] Web 能从可信内网访问；
- [ ] 服务器和 TCP 80 未暴露公网；如启用了可选 CIDR allowlist，获准/未获准网段验证符合预期；
- [ ] 50051、5432、8000、9000、9001 未发布到宿主机；
- [ ] `/etc/databench` 的 `databench.env`、`mcp.env`、`evalscope.env`、`swift.env`、`backup.key` 五个文件权限均为
      `0600`；
- [ ] 已创建一份一致性备份并校验；
- [ ] backup generation、匹配发布包和 `backup.key` 已异机保存；
- [ ] 已在测试机演练升级失败自动恢复；
- [ ] 已在测试机演练原机或干净机器恢复；
- [ ] 宿主机重启后 Worker、API、EvalScope、Web、PostgreSQL、MinIO 及启用的 Swift 服务和数据恢复；
- [ ] 已记录服务器地址、版本、Git SHA、备份位置；如启用了可选 CIDR allowlist，也已记录其范围。

生产交付记录只有在以上现场项目全部完成后才能签署。Mac 上的 amd64 仿真和 Compose 集成
测试不能替代真实 Ubuntu 目标机验收。
