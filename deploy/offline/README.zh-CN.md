# Databench Ubuntu 单机离线部署

> 本文件是离线包的快速入口。首次生产部署、升级或恢复前，请先阅读完整手册。

## 文档导航

- [完整部署与运维手册](DEPLOYMENT-GUIDE.zh-CN.md)：构建、传输、安装、验收、备份、升级、
  回滚和恢复的逐步操作；
- [故障排查手册](TROUBLESHOOTING.zh-CN.md)：按错误现象定位并安全恢复；
- [内网 Agent 接入指南](MCP-AGENT-GUIDE.zh-CN.md)：配置 MCP、Excel 三种意图与重试规则；
- [EvalScope 运维指南](EVALSCOPE-OPERATOR-GUIDE.zh-CN.md)：模型 allowlist、容量、drain、备份和断网验收；
- [Swift Studio GPU 指南](SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md)：GPU 启用、离线模型、训练、部署和备份；
- [技术方案](docs/offline-single-host-plan.zh-CN.md)：部署架构、发布契约和设计边界；
- [ADR 0012](docs/ADR-0012.md)：Ubuntu 单机离线部署的正式决策记录；
- [ADR 0018](docs/ADR-0018.md)：完整原生 ms-swift Gradio Studio 集成决策。

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

脚本固定构建 `linux/amd64` 的 API、Web、CPU-only Python Worker、pinned backend-only EvalScope
和 CUDA Swift Studio，拉取精确版本的 PostgreSQL 17、MinIO 和 MinIO Client，检查八张镜像的平台和内容 ID，并写入
`images.lock`。
如果数据库迁移不再向后兼容，构建时必须显式改变两个配套属性：

```bash
DATABASE_MIGRATION=restore-on-rollback \
ROLLBACK_MODE=restore-backup \
deploy/offline/build-bundle.sh 2.0.0
```

## 首次安装

目标机前置条件：Ubuntu 22.04 LTS amd64、Docker Engine 24+、Compose plugin 2.20+、至少
12 logical CPUs、40 GiB 可见 RAM、60 GiB 系统盘和 12 GiB Databench 数据文件系统可用空间。
Docker 的安装和升级不属于本发布包。

将 `.tar.gz` 和 `.sha256` 一起复制到服务器。服务器必须位于不暴露公网的可信内网；当前没有
应用层认证，任何能访问 TCP 80 的主体都有完整权限。企业内网本身已经封闭时，不需要额外配置
CIDR 或 iptables。首次安装执行：

```bash
sha256sum -c databench-offline-1.0.0-linux-amd64.tar.gz.sha256
tar -xzf databench-offline-1.0.0-linux-amd64.tar.gz
cd databench-offline-1.0.0-linux-amd64
sudo env DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api ./install.sh
```

在已安装 NVIDIA 驱动和 NVIDIA Container Toolkit 的 GPU 机上，一次性显式启用 Swift Studio：

```bash
sudo env \
  DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api \
  DATABENCH_ENABLE_SWIFT_GPU=true \
  ./install.sh
```

安装器只执行快速 CUDA/Studio readiness，不运行训练。离线包包含完整运行时但不包含第三方模型权重；
启用前必须将至少一个完整模型预置到 `/srv/databench/swift-models`，空目录会被安装器拒绝。完整步骤见
[Swift Studio GPU 指南](SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md)。

若可信内网已有模型端点，同时提供 exact allowlist，例如：

```bash
sudo -E env \
  DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api \
  DATABENCH_EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST='http|10.10.0.15/32|8000' \
  ./install.sh
```

安装器还会再次验证外层归档和包内 `SHA256SUMS`，不会访问公网。首次安装自动生成数据库、
MinIO 和 v2 cursor secret，直接写入 `/etc/databench/databench.env`，权限为 `0600`；重跑或
升级不会覆盖它们。备份 escrow key 会单独写入 `/etc/databench/backup.key`，同样为 `0600`。

历史五/六/七镜像包只用于旧版回滚兼容，不能作为当前包体积估算。当前八镜像包新增可选 CUDA Swift Studio；正式
交付以当次 `ls -lh`、`RELEASE.txt` 和 `.sha256` 为准。业务数据、EvalScope 在线结果、备份和 Docker 已有
缓存不包含在包体积中；服务器仍须满足安装器的 60 GiB 系统盘可用空间检查。

`DATABENCH_MCP_PUBLIC_BASE_URL` 必须是目标 agent 实际能访问的稳定地址，path 精确为 `/api`，
不能使用容器名、自动猜测的首个网卡地址或尾随 `/`；DNS 使用小写，默认 HTTP(S) 端口必须省略，
非默认端口使用无前导零的十进制。安装器把匿名 MCP 配置单独写入 `/etc/databench/mcp.env`，
后续升级复用，不会把它混进 secret 文件。

安装器另生成 `/etc/databench/evalscope.env`，保存稳定 task HMAC/operator/service secret、浏览器 origin、模型
allowlist 和容量上限。该文件同样是 `root:root 0600`；native Benchmark 的远程 Dataset allowlist 在离线
通道中固定为空。

安装器总会生成 `/etc/databench/swift.env`；默认 `DATABENCH_SWIFT_ENABLED=false`。只有安装命令显式
传入 `DATABENCH_ENABLE_SWIFT_GPU=true` 时才启动 `swift-gpu` profile。启用状态和 Provider credential
在后续重启、备份和升级中保持稳定。

`DATABENCH_MCP_PUBLIC_BASE_URL=...` 只在首次创建 `/etc/databench/mcp.env` 时需要提供。文件一旦
存在，重跑安装和正常升级都不需要再次传入。需要重跑安装时：

```bash
sudo ./install.sh
```

正常升级时：

```bash
sudo ./upgrade.sh
```

另一个需要提供一次的场景，是从完全不包含 MCP 配置的旧版本首次升级到当前版本。安装后只开放
宿主机 TCP 80。可以按现场需要再配置 CIDR/iptables 做更细粒度隔离，但这不是安装前置条件。

页面地址使用 `http://<服务器地址>/datasets`、`/ingest`、`/transforms`、`/training` 等无版本路径；浏览器调用的后端地址统一为同源
`http://<服务器地址>/api/...`。Caddy 会去掉 `/api` 再转发，因此后端 Hono 路由本身不变，
页面与 JSON API 也不会再因相同 URL 的浏览器缓存发生冲突。

内网 agent 使用 `http://<服务器地址>/api/mcp`，transport 为 Streamable HTTP，不配置认证。
任何能访问 TCP 80 的主体都有完整 MCP 能力，因此禁止把服务器或 TCP 80 暴露公网。完整流程见
[内网 Agent 接入指南](MCP-AGENT-GUIDE.zh-CN.md)。

## 日常运维

```bash
sudo databenchctl status
sudo databenchctl logs api
sudo databenchctl doctor
sudo databenchctl evalscope-status
sudo databenchctl restart
sudo databenchctl backup
```

备份位于 `/srv/databench/backups/<generation>`。每次备份会先 drain，包含 PostgreSQL dump、MinIO
bucket mirror、EvalScope output/input volume、启用时的 Swift Session workspace、版本信息、校验值和四份加密配置 escrow。必须把备份、匹配 SHA-256 的离线发布
包以及 `/etc/databench/backup.key` 分开复制到 NAS/异机；只保存在本机不算备份。

## 离线升级与回滚

把新版本的归档和校验文件复制到服务器并解压：

```bash
cd databench-offline-1.1.0-linux-amd64
sudo ./upgrade.sh
```

上式适用于已经存在 `/etc/databench/mcp.env` 的版本。首次从不含 MCP 配置的旧版升级时，必须
和首次安装一样显式提供一次稳定 public base：

```bash
sudo env DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api ./upgrade.sh
```

升级会先停止 Web admission并拒绝仍有原生训练任务的 Swift Studio；关闭 Swift、移除 Swift 或 image
digest 变化时还要求 active Studio Session 已关闭。随后 drain EvalScope、创建一致性备份、
导入镜像、迁移数据库，再按 Worker → Swift Studio → API → EvalScope → Web 启动并运行 doctor、gateway、固定数据集、MCP 和 `basic-clean@1`
生命周期冒烟。任一步失败会自动恢复 previous release；回滚到旧五/六/七镜像版本时旧 release 不启动
不存在的 Swift/EvalScope 服务，但不会隐式删除它们的数据。普通向后
兼容迁移可以直接回滚应用镜像：

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

恢复时当前 `DATABENCH_SWIFT_ENABLED` 必须与 generation 的 `swift_enabled` 一致；enabled generation
在干净机器上需要先预置模型并启用同版本 Swift。

PostgreSQL major、MinIO 数据格式或对象 key/layout 的不兼容升级不走通用 `upgrade.sh`。
