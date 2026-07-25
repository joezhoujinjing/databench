# Databench Ubuntu 单机离线部署与运维手册

本文面向实际执行构建、传输、安装和运维的人员。目标环境固定为：

- Ubuntu 22.04 LTS；
- amd64/x86_64；
- 单台服务器；
- 服务器无公网、无内部镜像仓库；
- Docker Engine 已预装；
- 允许升级和备份期间短暂停机。

如果只需要快速安装，先看 [README.zh-CN.md](README.zh-CN.md)。遇到错误时看
[TROUBLESHOOTING.zh-CN.md](TROUBLESHOOTING.zh-CN.md)。

## 1. 重要边界

1. 离线包不包含 Docker Engine，也不会在目标机安装或升级 Docker。
2. 安装和运行期间不会执行 `docker pull`、`docker build`、`pnpm install` 或访问公网。
3. 宿主机只发布 TCP 80。API、PostgreSQL、MinIO 和 MinIO Console不发布宿主机端口。
4. 当前没有应用层鉴权。必须通过现场防火墙把 TCP 80 限制到获准内网网段，禁止暴露公网。
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

目标 Ubuntu 只接收并使用这两个文件。`.tar.gz` 包含五张 `linux/amd64` 镜像、Compose、安装
脚本、运维脚本、固定 smoke fixtures 和本文档。

当前实测：

- `images.tar`：约 412 MB；
- 最终 `.tar.gz`：约 409.4 MiB；
- 为依赖波动预留后，传输按 410–430 MB 估算；
- 业务数据和备份不包含在该体积中。

建议职责：

| 角色 | 责任 |
|---|---|
| 发布人员 | 从干净 Git 提交构建离线包，记录版本、Git SHA 和 SHA-256 |
| 传输人员 | 同时传输归档与 `.sha256`，不改名、不二次压缩 |
| 现场管理员 | 检查目标机、执行安装、配置防火墙、完成验收 |
| 备份管理员 | 将数据备份、匹配发布包和 `backup.key` 分开保存到异机 |

## 3. 联网构建机操作

### 3.1 构建机要求

- 能访问 npm registry 和 Docker Hub；
- Docker daemon 正常；
- Docker Buildx 可用；
- Docker 支持 `docker image save --platform`，建议 Docker 28 或更新版本；
- Git 工作树干净；
- 建议至少预留 10 GiB 可用空间给镜像层、构建缓存和归档。

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

1. 固定 `linux/amd64` 构建 API 和 Web；
2. 拉取精确版本的 PostgreSQL 17、MinIO 和 MinIO Client；
3. 检查五张镜像的 OS、架构和内容 ID；
4. 在 amd64 仿真下执行镜像 executable smoke；
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

## 4. 目标 Ubuntu 安装前检查

### 4.1 硬件和软件最低要求

- Ubuntu 22.04 LTS；
- `uname -m` 为 `x86_64`；
- Docker Engine 24.0.0 或更新版本；
- Docker Compose plugin 2.20.0 或更新版本；
- 根文件系统至少 20 GiB 可用空间；
- TCP 80 未被其他容器发布；
- 管理员具备 `sudo` 权限。

试运行容量建议为 8 vCPU、32 GiB RAM、100 GiB 系统盘。真实生产规格应根据最大数据集另做
压测。

### 4.2 现场检查命令

```bash
cat /etc/os-release
uname -m
docker version --format 'server={{.Server.Version}}'
docker compose version --short
docker info >/dev/null && echo 'docker daemon: OK'
df -h /
docker ps --filter publish=80 --format 'table {{.Names}}\t{{.Ports}}'
```

预期：

- `VERSION_ID="22.04"`；
- `x86_64`；
- Docker server 不低于 24；
- Compose 不低于 2.20；
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

在解压目录执行：

```bash
sudo ./install.sh
```

使用包内标准入口 `sudo ./install.sh`，不要手工改脚本，也不要在脚本前手工 `docker load`。
安装器会按固定顺序完成：

1. 校验外层和包内 SHA-256；
2. 检查 OS、架构、Docker、Compose、磁盘和端口；
3. 创建安装、配置和数据目录；
4. 自动生成数据库、MinIO、应用访问和 v2 cursor secret；
5. 导入五张离线镜像；
6. 启动 PostgreSQL 和 MinIO；
7. 创建 MinIO bucket、应用用户和 bucket-scoped policy；
8. 执行 `prisma migrate deploy`；
9. 启动 API 和 Web；
10. 执行 doctor、Caddy proxy 检查和固定数据集生命周期 smoke；
11. 安装 `/usr/local/bin/databenchctl`。

安装期间出现的密码不会输出到终端或日志。

### 6.2 安装成功输出

成功时最后会显示类似：

```text
Databench installation succeeded

URL: http://10.0.0.10
Configuration: /etc/databench/databench.env
Data: /srv/databench
Version: 1.0.0
```

如果脚本中途失败，可以修正原因后重新执行同一个 `sudo ./install.sh`。它会复用已经生成的
secret，不会静默创建第二套配置。

## 7. 安装后验收

### 7.1 服务状态和依赖

```bash
sudo databenchctl version
sudo databenchctl status
sudo databenchctl doctor
```

doctor 成功的精确输出为：

```json
{"database":{"ok":true},"store":{"ok":true}}
```

### 7.2 HTTP 检查

在服务器本机执行：

```bash
curl -fsS http://127.0.0.1/api/health
curl -fsS http://127.0.0.1/api/version
curl -fsS http://127.0.0.1/api/capabilities
curl -fsS 'http://127.0.0.1/api/v2/refs?limit=1'
curl -fsS 'http://127.0.0.1/api/v2/transforms'
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

### 7.3 端口检查

```bash
sudo ss -lntp
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Databench 业务容器只应看到宿主机 `0.0.0.0:80->80/tcp`。PostgreSQL 5432、MinIO 9000/9001
和 API 8000 不应发布到宿主机。

### 7.4 防火墙

安装器不会猜测现场网段，也不会修改宿主机防火墙。上线前必须由现场管理员把 TCP 80 限制到
获准 CIDR。

优先使用企业边界防火墙或云/虚拟化平台安全策略。若使用 Docker 的 `DOCKER-USER` 链，可在
变更窗口参考以下模板，先替换 `<APPROVED_CIDR>`：

```bash
sudo iptables -I DOCKER-USER 1 -s <APPROVED_CIDR> -p tcp --dport 80 -j ACCEPT
sudo iptables -A DOCKER-USER -p tcp --dport 80 -j DROP
sudo iptables -L DOCKER-USER -n --line-numbers
```

规则持久化方式取决于现场网络规范，本发布包不安装 `iptables-persistent`。必须分别从获准和
未获准客户端扫描验证；不能只看服务器本机结果。

## 8. 安装目录、数据和 secret

| 路径 | 内容 | 是否可删除 |
|---|---|---|
| `/opt/databench-offline/releases/<version>` | 各版本部署脚本和 release manifest | 稳定前不要删除 |
| `/opt/databench-offline/current` | 当前版本原子软链接 | 不要手工改，使用升级/回滚脚本 |
| `/opt/databench-offline/state` | current/previous/backup marker | 不要删除 |
| `/etc/databench/databench.env` | 数据库、MinIO 和 v2 secret | 不要提交、打印或随意编辑 |
| `/etc/databench/backup.key` | 备份配置 escrow 加密密钥 | 必须异机单独保存 |
| `/srv/databench/postgres` | PostgreSQL 数据目录 | 禁止手工修改 |
| `/srv/databench/minio` | MinIO 对象数据 | 禁止手工修改 |
| `/srv/databench/workspace` | API 临时/工作空间 | 保留 |
| `/srv/databench/backups` | 本机备份中转 | 不能作为唯一备份 |

检查权限但不要输出内容：

```bash
sudo stat -c '%U:%G %a %n' /etc/databench/databench.env /etc/databench/backup.key
```

两个文件都应为 `root:root 600`。

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
sudo databenchctl logs web
sudo databenchctl logs postgres
sudo databenchctl logs minio
```

`logs` 默认显示最近 200 行并持续跟随，按 `Ctrl-C` 退出。

### 9.2 重启应用

```bash
sudo databenchctl restart
```

该命令重启 API 和 Web，等待健康后运行 doctor。它不会删除或重建数据。

需要检查 Docker 自启动策略：

```bash
sudo systemctl is-enabled docker
sudo systemctl is-active docker
docker inspect --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' \
  databench-offline-postgres databench-offline-minio databench-offline-api databench-offline-web
```

## 10. 备份

### 10.1 创建一致性备份

```bash
sudo databenchctl backup
```

备份会暂停 Web/API 写入，依次生成 PostgreSQL custom dump、MinIO bucket mirror、migration
列表、版本清单、校验文件和加密的配置 escrow，然后重新启动服务并运行 doctor。

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
`images.tar`；按版本保存一份匹配的完整离线包即可。

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

### 11.2 执行升级

```bash
tar -xzf databench-offline-1.1.0-linux-amd64.tar.gz
cd databench-offline-1.1.0-linux-amd64
sudo ./upgrade.sh
```

升级会：

1. 验证新包、版本范围、PostgreSQL major 和 rollback contract；
2. 停止 Web/API；
3. 创建并校验升级前一致性备份；
4. 导入新镜像；
5. 执行 migration；
6. 启动目标版本；
7. 执行 doctor、gateway 和数据集生命周期 smoke；
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
docker inspect --format '{{.Config.Image}}' databench-offline-api databench-offline-web
```

### 11.3 升级失败

从停止 API 起，升级脚本安装了失败恢复 trap。备份、镜像、migration、启动、doctor 或 smoke
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

## 15. 上线验收清单

- [ ] 归档外层 SHA-256 为 `OK`；
- [ ] 目标机为 Ubuntu 22.04 amd64；
- [ ] Docker/Compose 版本满足最低要求；
- [ ] `sudo ./install.sh` 一次成功；
- [ ] `databenchctl version` 与发布版本一致；
- [ ] `databenchctl doctor` 的 database/store 均为 true；
- [ ] `/api/version` 的 `service_version` 正确；
- [ ] Web 能从获准网段访问；
- [ ] 未获准网段不能访问 TCP 80；
- [ ] 5432、8000、9000、9001 未发布到宿主机；
- [ ] `/etc/databench` 两个文件权限均为 `0600`；
- [ ] 已创建一份一致性备份并校验；
- [ ] backup generation、匹配发布包和 `backup.key` 已异机保存；
- [ ] 已在测试机演练升级失败自动恢复；
- [ ] 已在测试机演练原机或干净机器恢复；
- [ ] 宿主机重启后服务和数据恢复；
- [ ] 已记录服务器地址、版本、Git SHA、备份位置和允许访问 CIDR。

生产交付记录只有在以上现场项目全部完成后才能签署。Mac 上的 amd64 仿真和 Compose 集成
测试不能替代真实 Ubuntu 目标机验收。
