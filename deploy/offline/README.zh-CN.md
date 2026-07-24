# Databench Ubuntu 单机离线部署

> 本文件是离线包的快速入口。首次生产部署、升级或恢复前，请先阅读完整手册。

## 文档导航

- [完整部署与运维手册](DEPLOYMENT-GUIDE.zh-CN.md)：构建、传输、安装、验收、备份、升级、
  回滚和恢复的逐步操作；
- [故障排查手册](TROUBLESHOOTING.zh-CN.md)：按错误现象定位并安全恢复；
- [技术方案](docs/offline-single-host-plan.zh-CN.md)：部署架构、发布契约和设计边界；
- [ADR 0012](docs/ADR-0012.md)：Ubuntu 单机离线部署的正式决策记录。

本目录实现 ADR 0012：在联网构建机生成一个包含全部 `linux/amd64` 镜像的完整发布包，再将
发布包复制到没有公网、没有内部镜像仓库的 Ubuntu 22.04 amd64 服务器。

## 构建发布包

构建机需要支持 `docker image save --platform` 的 Docker Engine（当前建议 Docker 28+）、
Buildx 和可访问 Docker Hub 的网络。工作树必须干净，版本号必须是三段数字：

```bash
deploy/offline/build-bundle.sh 1.0.0
```

默认产物位于 `output/offline/`：

```text
databench-offline-1.0.0-linux-amd64.tar.gz
databench-offline-1.0.0-linux-amd64.tar.gz.sha256
```

脚本固定构建 `linux/amd64`，拉取精确版本的 PostgreSQL 17、MinIO 和 MinIO Client，检查每个
镜像的平台和内容 ID，并写入 `images.lock`。如果数据库迁移不再向后兼容，构建时必须显式
改变两个配套属性：

```bash
DATABASE_MIGRATION=restore-on-rollback \
ROLLBACK_MODE=restore-backup \
deploy/offline/build-bundle.sh 2.0.0
```

## 首次安装

目标机前置条件：Ubuntu 22.04 LTS amd64、Docker Engine 24+、Compose plugin 2.20+，以及至少
20 GiB 可用空间。Docker 的安装和升级不属于本发布包。

将 `.tar.gz` 和 `.sha256` 一起复制到服务器，然后执行：

```bash
sha256sum -c databench-offline-1.0.0-linux-amd64.tar.gz.sha256
tar -xzf databench-offline-1.0.0-linux-amd64.tar.gz
cd databench-offline-1.0.0-linux-amd64
sudo ./install.sh
```

安装器还会再次验证外层归档和包内 `SHA256SUMS`，不会访问公网。首次安装自动生成数据库、
MinIO 和 v2 cursor secret，直接写入 `/etc/databench/databench.env`，权限为 `0600`；重跑或
升级不会覆盖它们。备份 escrow key 会单独写入 `/etc/databench/backup.key`，同样为 `0600`。

当前五张 amd64 镜像实测 `images.tar` 约 412 MB，最终 `.tar.gz` 预计约 410–430 MB。业务数据、
备份和 Docker 已有缓存不包含在这个数字中；传输和落盘建议至少预留 2 GB 临时空间，服务器
整体仍按安装器要求保留至少 20 GiB 可用空间。

安装后只开放宿主机 TCP 80。必须由现场防火墙限制允许访问的内网网段。

页面地址使用 `http://<服务器地址>/datasets`、`/ingest`、`/transforms` 等无版本路径；浏览器调用的后端地址统一为同源
`http://<服务器地址>/api/...`。Caddy 会去掉 `/api` 再转发，因此后端 Hono 路由本身不变，
页面与 JSON API 也不会再因相同 URL 的浏览器缓存发生冲突。

## 日常运维

```bash
sudo databenchctl status
sudo databenchctl logs api
sudo databenchctl doctor
sudo databenchctl restart
sudo databenchctl backup
```

备份位于 `/srv/databench/backups/<generation>`。每次备份会停写，包含 PostgreSQL dump、MinIO
bucket mirror、版本信息、校验值和加密的配置 escrow。必须把备份、匹配 SHA-256 的离线发布
包以及 `/etc/databench/backup.key` 分开复制到 NAS/异机；只保存在本机不算备份。

## 离线升级与回滚

把新版本的归档和校验文件复制到服务器并解压：

```bash
cd databench-offline-1.1.0-linux-amd64
sudo ./upgrade.sh
```

升级会停止 API、创建一致性备份、导入镜像、迁移数据库，再运行 doctor 和固定 v1/v2 生命周期
冒烟。任一步失败会自动恢复 previous release。普通向后兼容迁移可以直接回滚应用镜像：

```bash
sudo databenchctl rollback 1.0.0
```

如果目标发布清单声明 `restore-backup`，回滚时必须显式提供对应升级前备份：

```bash
sudo databenchctl rollback 1.0.0 --backup 20260724T120000Z-a1b2c3d4
```

显式恢复是破坏性操作，会先创建安全备份：

```bash
sudo databenchctl restore 20260724T120000Z-a1b2c3d4 --confirm
```

PostgreSQL major、MinIO 数据格式或对象 key/layout 的不兼容升级不走通用 `upgrade.sh`。
