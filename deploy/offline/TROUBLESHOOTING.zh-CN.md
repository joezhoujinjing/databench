# Databench 单机离线部署故障排查

本文按“现象 → 检查 → 处理”组织。所有命令默认在目标 Ubuntu 上执行。

## 1. 先收集这些信息

```bash
sudo databenchctl version
sudo databenchctl status
sudo databenchctl doctor
sudo databenchctl logs api
```

另开终端收集：

```bash
docker version
docker compose version
df -h /
df -h /srv/databench
sudo ss -lntp
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

不要在工单或聊天中粘贴以下内容：

- `/etc/databench/databench.env`；
- `/etc/databench/backup.key`；
- `docker inspect` 的完整 Env；
- 完整 `DATABASE_URL`；
- MinIO access key/secret。

## 2. 安装前检查失败

### 2.1 `target must be Ubuntu 22.04 LTS`

检查：

```bash
cat /etc/os-release
```

处理：只支持 Ubuntu 22.04。不要通过修改 `/etc/os-release` 或删除 preflight 绕过。需要其他
发行版时必须先单独验证并更新发布契约。

### 2.2 `target architecture must be amd64/x86_64`

检查：

```bash
uname -m
```

处理：目标必须输出 `x86_64`。当前包不能在 arm64/aarch64 服务器运行，也不要使用 QEMU 作为
生产运行时。

### 2.3 Docker 或 Compose 版本过低

检查：

```bash
docker version --format 'server={{.Server.Version}}'
docker compose version --short
```

处理：由服务器管理员在有离线 Docker 安装介质的维护流程中升级。业务发布包不会升级 Docker。

### 2.4 `Docker daemon is not available`

```bash
sudo systemctl status docker --no-pager
sudo journalctl -u docker --since '-30 min' --no-pager
sudo systemctl start docker
```

如果当前用户执行 `docker info` 权限不足，安装仍应使用 `sudo ./install.sh`。不要为了方便把
Docker socket 改成全局可写。

### 2.5 磁盘不足

```bash
df -h /
sudo du -xh /var/lib/docker --max-depth=1 | sort -h
sudo du -xh /srv/databench --max-depth=2 | sort -h
```

先转移旧离线归档或非 Databench 文件。不要直接删除 `/var/lib/docker`、PostgreSQL 或 MinIO
目录。清理 Docker 镜像前先确认它们没有被当前、previous 或 stable release 使用。

### 2.6 TCP 80 已占用

```bash
sudo ss -lntp '( sport = :80 )'
docker ps --filter publish=80 --format 'table {{.Names}}\t{{.Ports}}'
```

停止或迁移明确识别出的冲突服务后重跑安装。不要直接杀死未知进程。Databench 当前不支持通过
安装参数改成其他宿主机端口。

## 3. 发布包校验失败

### 3.1 外层 SHA-256 失败

```bash
sha256sum -c databench-offline-1.0.0-linux-amd64.tar.gz.sha256
```

处理：删除本次损坏的传输副本并重新传输归档和 `.sha256`。不要重新生成一个新的 `.sha256`
去“修复”失败。

### 3.2 `missing original bundle archive beside extracted directory`

安装/升级脚本要求以下三项同级且保持原名：

```text
databench-offline-1.0.0-linux-amd64.tar.gz
databench-offline-1.0.0-linux-amd64.tar.gz.sha256
databench-offline-1.0.0-linux-amd64/
```

把原始归档和校验文件放回解压目录旁边，不要只复制解压后的目录。

### 3.3 包内 `SHA256SUMS` 失败

说明解压文件被破坏、修改或漏传。重新从通过外层校验的归档解压，不要手工修改 compose、脚本
或 manifest 后继续生产安装。

### 3.4 构建时报 dirty worktree

```bash
git status --short
```

构建正式包必须来自已提交、可追溯的干净工作树。提交或妥善处理改动后重新构建；不要修改构建
脚本绕过检查。

## 4. 镜像导入或平台校验失败

### 4.1 `bundle image was not loaded`

检查归档空间和 Docker daemon 日志：

```bash
df -h /
sudo journalctl -u docker --since '-30 min' --no-pager
```

重新运行同一个安装/升级脚本，它会再次执行 `docker load`。不要联网 `docker pull` 替代离线包
中的镜像，否则内容 ID 与 release lock 不再一致。

### 4.2 `loaded image digest mismatch`

说明目标机同名 tag 指向了不同镜像，或归档内容不匹配。先保留现场信息：

```bash
docker image inspect <报错中的镜像名> --format '{{.Id}} {{.Os}}/{{.Architecture}}'
```

重新校验归档和包内 checksum。不要强制改 tag 或编辑 `images.lock`。

### 4.3 `loaded image has wrong platform`

正确值必须是 `linux/amd64`。回到联网构建机重新构建；目标机不能通过运行 arm64 镜像绕过。

## 5. PostgreSQL 问题

### 5.1 容器不健康

```bash
docker logs --tail 200 databench-offline-postgres
docker inspect --format '{{json .State.Health}}' databench-offline-postgres
df -h /srv/databench
sudo stat -c '%U:%G %a %n' /srv/databench/postgres
```

常见原因：磁盘满、数据目录损坏、上次异常断电、权限被手工修改。不要删除 `postmaster.pid` 或
数据目录后重建。先制作磁盘级副本并由数据库管理员判断。

### 5.2 migration 失败

```bash
docker logs --tail 200 databench-offline-migrate
sudo databenchctl logs postgres
```

首次安装失败时，修复数据库问题后重跑相同 `install.sh`。升级失败时不要手工重复 SQL；升级
脚本会自动恢复 previous release。保留升级前 backup generation 和日志。

### 5.3 doctor 返回 `database.ok=false`

```bash
docker exec databench-offline-postgres sh -ec \
  'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
sudo databenchctl logs api
```

如果 PostgreSQL healthy 但 doctor 失败，检查 API 是否使用当前 release、配置文件是否仍为
`0600`，以及是否有人手工修改过 `.env`。不要输出 `.env` 内容到工单。

## 6. MinIO 问题

### 6.1 MinIO 容器不健康

```bash
docker logs --tail 200 databench-offline-minio
docker inspect --format '{{json .State.Health}}' databench-offline-minio
df -h /srv/databench
sudo du -sh /srv/databench/minio
```

不要删除 MinIO `.minio.sys` 或对象目录。磁盘 I/O/损坏问题应先停止写入并保存数据盘副本。

### 6.2 `minio-init` 失败

```bash
docker logs --tail 200 databench-offline-minio-init
sudo stat -c '%U:%G %a %n' /etc/databench/databench.env
```

常见原因：MinIO 未就绪、配置被修改、应用用户或 policy 创建失败。修复后重跑相同 install 或
upgrade。`minio-init` 是幂等任务，不需要手工进入 Console 建 bucket。

### 6.3 doctor 返回 `store.ok=false`

```bash
sudo databenchctl logs api
docker logs --tail 200 databench-offline-minio
docker logs --tail 200 databench-offline-minio-init
```

API 使用 bucket-scoped app key，不使用 MinIO root key。不要把 root secret 临时写入 API 配置
作为排障手段。

## 7. API 或 Web 问题

### 7.1 API unhealthy

```bash
docker logs --tail 300 databench-offline-api
docker inspect --format '{{json .State.Health}}' databench-offline-api
sudo databenchctl doctor
```

检查实际镜像和版本：

```bash
docker inspect --format '{{.Config.Image}}' databench-offline-api
curl -fsS http://127.0.0.1/version
sudo databenchctl version
```

三者版本必须一致。若升级脚本失败，优先确认它是否已经自动恢复 previous release。

### 7.2 Web 打不开或返回 502

```bash
docker logs --tail 200 databench-offline-web
curl -v http://127.0.0.1/health
docker inspect --format '{{.State.Status}}' databench-offline-api
```

- 本机正常、客户端失败：检查现场防火墙、路由和允许 CIDR；
- 本机也失败且 Web running：检查 Caddy 日志和 API 状态；
- 502：通常是 API 未运行或尚未 healthy；
- SPA 能打开但 API 请求失败：检查 `/v1/*`、`/v2/*`、`/version` 是否经同一地址访问。

### 7.3 v2 records/export 报只读文件系统

当前镜像会把 `DATABENCH_ROOT=/var/lib/databench` 传给 API 和 CLI，并挂载可写 workspace。检查：

```bash
docker exec databench-offline-api sh -ec \
  'test -w /var/lib/databench && echo writable'
docker inspect --format '{{json .Mounts}}' databench-offline-api
```

如果 workspace 挂载缺失，不要把整个容器改成可写；恢复当前版本的原始 Compose/release 资产后
重建 API。

## 8. 备份问题

### 8.1 备份失败后服务状态

备份脚本在普通调用失败时会尝试重新启动 Web/API。立即检查：

```bash
sudo databenchctl status
sudo databenchctl doctor
```

失败的临时 generation 会被清理，已完成 generation 不会被覆盖。

### 8.2 `backup escrow key is missing/empty`

不要随意生成新 key 取代丢失的 key；新 key 无法解密历史 `databench.env.enc`。从安全异机副本
恢复 `/etc/databench/backup.key`，并设置：

```bash
sudo chown root:root /etc/databench/backup.key
sudo chmod 0600 /etc/databench/backup.key
```

### 8.3 PostgreSQL dump 或 MinIO mirror 失败

```bash
sudo databenchctl logs postgres
sudo databenchctl logs minio
df -h /srv/databench
```

不要把失败 generation 当成可恢复备份。修复后重新运行 `sudo databenchctl backup`，并在复制
到异机前执行 `sha256sum -c SHA256SUMS`。

## 9. 恢复问题

### 9.1 `matching release is not installed`

恢复要求 backup manifest 中的应用版本已经安装在：

```text
/opt/databench-offline/releases/<version>
```

找到 manifest 指定 SHA-256 的完整离线包，先安装同版本，再重新执行恢复。

### 9.2 `matching release bundle checksum is unavailable`

安装的 release 与备份引用的归档不是同一个构建。不要绕过校验。根据 `backup-manifest` 找到
精确的 bundle 文件名和 SHA-256。

### 9.3 恢复中途失败

恢复是破坏性过程。脚本失败后默认不会假装服务可用。保留：

- 原目标 generation；
- 恢复前自动创建的 safety generation；
- 当前和目标 release；
- PostgreSQL/MinIO 日志。

不要连续重复恢复。先判断失败发生在 PG、MinIO、migration 还是 smoke，再选择恢复原目标或
safety generation。

## 10. 升级和回滚问题

### 10.1 目标版本不高于当前版本

```bash
sudo databenchctl version
cat release-manifest.json
```

每个发布使用新的三段数字版本。相同版本重发或覆盖归档被明确禁止。

### 10.2 previous release 已自动恢复

升级命令非零退出，但看到：

```text
previous release <version> is serving again
```

这表示业务已恢复旧版，但升级仍失败。检查：

```bash
sudo databenchctl version
sudo databenchctl doctor
curl -fsS http://127.0.0.1/version
```

保留失败目标包和 pre-upgrade backup，修复发布问题后生成更高的新版本；不要用相同版本覆盖。

### 10.3 `automatic recovery failed`

停止新的写入和重复操作，保留失败终端的完整输出。人工恢复取决于目标发布的 rollback
contract；以终端 `Manual recovery` 下打印的精确 release 和 generation 为准。

如果目标发布为 `restore-backup`，先执行终端打印的 restore 命令。只有恢复成功后才能启动
previous release，典型命令为：

```bash
sudo /opt/databench-offline/releases/<previous-version>/restore.sh \
  /srv/databench/backups/<pre-upgrade-generation> \
  --confirm --skip-safety-backup
```

如果目标发布为 `image-only`，不要恢复数据，直接执行终端打印的 Compose 命令启动 previous
release。`restore-backup` 的 restore 成功后也可用同一命令确认全部服务已启动：

```bash
sudo docker compose --project-name databench-offline \
  --env-file /opt/databench-offline/releases/<previous-version>/release.env \
  --env-file /etc/databench/databench.env \
  --file /opt/databench-offline/releases/<previous-version>/compose.yml \
  up -d
```

不要调用 `<previous-version>/rollback.sh <previous-version>`：此时 `current` 尚未切到失败目标，
本来就指向 previous release，该命令会报 `target is already current`。服务启动后检查
`databenchctl status`、`databenchctl doctor` 和 `/version`；不能确认 contract 或 restore 失败时，
停止操作并交由发布/数据库负责人处理。

### 10.4 回滚要求 `--backup`

当前 release 声明 `restore-backup`。必须使用对应升级前 generation：

```bash
sudo databenchctl rollback <previous-version> --backup <generation>
```

不要随便选择更早或其他版本的 generation。

## 11. 宿主机重启后服务未恢复

```bash
sudo systemctl status docker --no-pager
docker ps -a --format 'table {{.Names}}\t{{.Status}}'
sudo databenchctl status
```

先启动 Docker：

```bash
sudo systemctl start docker
```

若个别容器 exited，查看对应日志。不要重新运行首次安装来掩盖数据盘、权限或容器启动问题。

## 12. 禁止操作清单

除非已有单独、评审过的恢复方案，否则禁止：

```text
docker compose down -v
docker system prune -a --volumes
rm -rf /srv/databench
rm -rf /opt/databench-offline
手工编辑 PostgreSQL 数据文件
手工删除 MinIO 对象或 .minio.sys
编辑 images.lock/SHA256SUMS 后继续安装
用 docker pull 替换离线包镜像
把 /etc/databench/databench.env 发到工单或聊天
```

如果排障需要删除、覆盖或重建任何数据，先创建并异机保存可验证的备份，再由数据负责人批准。
