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
- `/etc/databench/mcp.env` 的完整内容（public base 可单独报告，但不要粘贴整份容器 Env）；
- `/etc/databench/evalscope.env`；
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

### 2.5 CPU 或内存不足

```bash
getconf _NPROCESSORS_ONLN
awk '/^MemTotal:/ {printf "%.1f GiB\n", $2/1024/1024}' /proc/meminfo
```

不训练、Swift UI-only 的控制面首次安装最低要求为 6 logical CPUs 和 15 GiB 可见 RAM；显式
GPU mode 首次安装要求 12 logical CPUs 和 40 GiB。已经正常运行的安装环境在升级时不再执行
CPU/RAM/磁盘固定容量门槛，但仍检查系统、架构、Docker 和端口；备份或镜像写入实际空间不足
仍会使升级失败并恢复旧版。15 GiB 规格下不要同时运行大型 Data-Juicer 转换和大型 EvalScope
压测，否则服务会争抢资源。

### 2.6 磁盘不足

```bash
df -h /
sudo du -xh /var/lib/docker --max-depth=1 | sort -h
sudo du -xh /srv/databench --max-depth=2 | sort -h
```

先转移旧离线归档或非 Databench 文件。不要直接删除 `/var/lib/docker`、PostgreSQL 或 MinIO
目录。清理 Docker 镜像前先确认它们没有被当前、previous 或 stable release 使用。

### 2.7 TCP 80 已占用

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

### 3.5 增量包提示基线版本或 bundle SHA 不匹配

增量包只能应用到 `update-manifest.json` 声明的精确基线。先检查：

```bash
sudo databenchctl version
cat update-manifest.json
sudo cat /opt/databench-offline/current/release-bundle.sha256
```

版本不一致时不要跳过中间包；先按顺序应用缺失的增量版本，或改用一个更高版本的完整包。版本
相同但 SHA 不一致，说明目标机安装的不是构建时指定的那个基线发布物；不要编辑 manifest 或
`release-bundle.sha256` 绕过，应重新生成绑定正确基线的增量包，或者发布完整包。

增量包目录中没有 `install.sh` 是正常行为。空机器必须先安装完整离线包。

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

### 7.0 Worker unhealthy 或 `basic-clean` 失败

```bash
docker inspect --format '{{json .State.Health}}' databench-offline-worker
docker logs --tail 300 databench-offline-worker
docker exec databench-offline-worker /app/.venv/bin/databench-worker-healthcheck
docker inspect --format '{{json .NetworkSettings.Networks}}' databench-offline-worker
docker inspect --format '{{json .NetworkSettings.Networks}}' databench-offline-api
```

- healthcheck 失败：先看 Worker 日志是否为依赖加载失败、只读文件系统或 `/tmp` 空间不足；
- Worker healthy 但 API 启动失败：确认两者都连接 `databench-offline` 网络，API 目标由发布包固定为
  Compose DNS `worker:50051`；不要手工固定容器 IP 或发布宿主机 50051；
- 作业返回 `artifact_transfer_failed`：同时检查 API、Worker 和 MinIO 日志，确认容器私网与 MinIO
  exact-key 签名 URL 可达；日志或工单中不得粘贴完整签名 URL；
- `/tmp` 达到 4 GiB：等待当前作业结束并确认 Worker 自动清理。不要扩大 tmpfs 掩盖超过当前
  512 MiB canonical artifact 上限的异常输入。

Worker 镜像固定 CPU-only Torch；以下命令不应输出 CUDA/NVIDIA package：

```bash
docker exec databench-offline-worker /app/.venv/bin/python -c \
  'import torch; print(torch.__version__, torch.version.cuda)'
docker exec -e UV_CACHE_DIR=/tmp/uv-cache databench-offline-worker \
  /usr/local/bin/uv pip list --python /app/.venv/bin/python | \
  grep -Ei 'nvidia|cuda|triton' || true
```

预期 `torch.version.cuda` 为 `None`，第二条无输出。

### 7.1 API unhealthy

```bash
docker logs --tail 300 databench-offline-api
docker inspect --format '{{json .State.Health}}' databench-offline-api
sudo databenchctl doctor
```

检查实际镜像和版本：

```bash
docker inspect --format '{{.Config.Image}}' databench-offline-api
curl -fsS http://127.0.0.1/api/version
sudo databenchctl version
```

三者版本必须一致。若升级脚本失败，优先确认它是否已经自动恢复 previous release。

### 7.2 Web 打不开或返回 502

```bash
docker logs --tail 200 databench-offline-web
curl -v http://127.0.0.1/api/health
docker inspect --format '{{.State.Status}}' databench-offline-api
```

- 本机正常、客户端失败：检查内网路由；如启用了可选防火墙/CIDR allowlist，再检查对应规则；
- 本机也失败且 Web running：检查 Caddy 日志和 API 状态；
- 502：通常是 API 未运行或尚未 healthy；
- SPA 能打开但 API 请求失败：检查请求 URL 是否为 `/api/v2/*`、
  `/api/version`，且响应 `Content-Type` 是 JSON。

### 7.3 页面正常，但 API 返回 HTML 或显示“后端不可达”

离线部署已经把页面和 API 分成不同 URL：页面使用 `/datasets` 等无版本路径，API 统一使用 `/api/...`。
Caddy 去掉 `/api` 后再转给后端，不再按 `Accept` 分流，也不要求全站禁止缓存。

```bash
curl -fsS 'http://127.0.0.1/datasets' | grep -F '<div id="root"></div>'
curl -fsS -D- 'http://127.0.0.1/api/v2/transforms' -o /tmp/databench-api-response.json
head -c 200 /tmp/databench-api-response.json
docker inspect --format '{{.Config.Image}}' databench-offline-web
```

第一条必须是 SPA HTML；第二条必须包含 JSON `Content-Type`，正文不能是 `index.html`。

- 浏览器 Network 中 Request URL 仍是 `/v2/...`：旧页面标签页或旧 Web 资源仍在运行，先做一次
  强制刷新；再打开连接设置，点击 Reset 后 Apply，默认 API base 应为 `/api`。
- `/api/v2/...` 返回 HTML：当前 Web 镜像或 Caddy 配置仍是旧版本，确认容器镜像后使用更高版本
  的完整离线包升级，不要手工编辑已安装 release。
- `/api/v2/...` 返回 502：API 容器未健康，按 7.1 检查。

这次修复不依赖关闭浏览器缓存。页面 URL 与 API URL 不同后，浏览器缓存键天然隔离；升级时
已有打开的旧标签页仍需刷新一次，之后不需要长期禁用缓存。

### 7.4 v2 records/export 报只读文件系统

当前镜像会把 `DATABENCH_ROOT=/var/lib/databench` 传给 API 和 CLI，并挂载可写 workspace。检查：

```bash
docker exec databench-offline-api sh -ec \
  'test -w /var/lib/databench && echo writable'
docker inspect --format '{{json .Mounts}}' databench-offline-api
```

如果 workspace 挂载缺失，不要把整个容器改成可写；恢复当前版本的原始 Compose/release 资产后
重建 API。

### 7.5 EvalScope unhealthy、draining 或任务被拒绝

```bash
sudo databenchctl status
sudo databenchctl evalscope-status
sudo databenchctl logs evalscope
sudo stat -c '%U:%G %a %n' /etc/databench/evalscope.env
df -h /srv/databench/evalscope
```

- `runtime_draining`：维护正在进行；等待结束。确认没有维护任务后可由 operator 执行
  `sudo databenchctl evalscope-resume`；
- `task_capacity_invalid` / `task_concurrency_exceeded`：缩小 samples、parallel、requests、tokens 或等待
  现有任务完成，不要直接删除容量检查；
- `model_endpoint_*_rejected`：模型 URL 未同时通过
  `/etc/databench/model-endpoint-policy.json` 的 hostname、scheme/port、DNS 全量地址与 CIDR 规则，按
  [EVALSCOPE-OPERATOR-GUIDE.zh-CN.md](EVALSCOPE-OPERATOR-GUIDE.zh-CN.md) 在维护窗口原子更新 policy 并重启；
- `credential_reference_unknown` / `credential_reference_forbidden`：检查 authority 中 ref 的 consumer 与
  Deployment ID ACL；增加 generation 后运行 `sudo databenchctl model-credentials-project` 和
  `sudo databenchctl restart`。不要把 secret 写进 `.env` 或命令行；
- 容器启动即失败：确认配置为 `root:root 0600`、稳定 HMAC/operator secret 未丢失、Plotly asset digest
  未改变、output/input 目录 owner 为 UID/GID 10001；
- 页面 503 但容器健康：检查 API gateway 和 EvalScope health。不要把 9000 发布到宿主机作为绕过；
- `provider_interrupted`：表示强制重启前没有 terminal evidence，不是自动续跑。查看持久化状态并重新发起
  或使用受认证 reconciliation。

计划维护默认等待 active task 300 秒。超时会取消维护、恢复 Web/admission；让用户停止或完成任务后重试，
不要用 `docker kill` 绕过 drain。

### 7.6 内网 HTTP 报告 HTML 空白并返回 403

浏览器 Console 如果显示 `/evalscope-api/generated-documents/<opaque-id>` 返回 `403`，先在 Network 的
Request Headers 检查 `Sec-Fetch-Dest`。普通 `http://<内网 IP>` 不是 potentially trustworthy origin，
Chromium 会省略全部 Fetch Metadata；新版本离线 API 会使用受限的同源 `/evaluations/*` Referer
fallback。

```bash
docker exec databench-offline-api \
  printenv DATABENCH_EVALSCOPE_INTRANET_HTTP_DOCUMENTS
docker inspect --format '{{.Config.Image}}' databench-offline-api
grep '^DATABENCH_ORIGIN=' /etc/databench/evalscope.env
```

- 第一条必须是 `true`；缺失或为 `false` 表示仍是旧 API/Compose release，应使用完整离线包升级；
- `DATABENCH_ORIGIN` 必须与浏览器地址栏的 scheme、host 和显式 port 完全相同；
- 请求必须由 `/evaluations` 产品页中的 sandbox iframe 发起。直接粘贴 generated document URL、跨源
  Referer、非 Evaluation 页面或明确的顶层 `document` 仍会返回 403；
- 不要通过发布 EvalScope `9000`、关闭 CSP/sandbox 或让 Caddy 伪造浏览器请求头来绕过。

### 7.7 Swift GPU、Studio 或训练页面不可用

只有 `DATABENCH_SWIFT_RUNTIME_MODE=gpu` 才执行 NVIDIA/CUDA 检查。只查看界面时确认：

```bash
sudo grep '^DATABENCH_SWIFT_' /etc/databench/swift.env
```

其中应包含 `DATABENCH_SWIFT_ENABLED=true` 和
`DATABENCH_SWIFT_RUNTIME_MODE=ui-only`。GPU mode 安装报 NVIDIA/CUDA 错误时再检查：

```bash
nvidia-smi -L
docker info
sudo docker run --rm --gpus device=0 \
  "$(sed -n 's/^DATABENCH_SWIFT_IMAGE=//p' /opt/databench-offline/current/release.env)" \
  python -c 'import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))'
```

第一条失败说明宿主机驱动不可用；第二/三条失败通常说明 NVIDIA Container Toolkit 没有正确接入
Docker。修复宿主环境后重跑安装，不需要重新构建离线包。

容器已启动但 `/training` 不可用时检查：

```bash
sudo databenchctl logs swift-studio
sudo docker exec databench-offline-swift-studio python -c \
  'import json,urllib.request; print(json.load(urllib.request.urlopen("http://127.0.0.1:7861/runtime")))'
```

如果 Studio 正常但模型找不到，确认模型已完整复制到 `/srv/databench/swift-models`，并在原生
Model 字段使用容器路径 `/opt/databench-models/<模型目录>`。离线包不下载或附带第三方模型权重。
安装或升级提示 `no offline model is preloaded` 时，先按 Swift 指南复制至少一个完整模型目录并保存
revision/校验值，再重跑原命令。

升级、备份或重启提示 `active native train/infer/deploy task` 时，先进入 Gradio Runtime Tab 停止任务，
等待进程退出，再重新执行维护命令。不要直接 `docker kill`，否则可能留下不完整 checkpoint。
提示 `active Swift Studio Session ... must be closed` 时，还要在 Databench `/training` 外层关闭 Session；
这通常发生在关闭 Swift、回滚到无 Swift 的版本或 image digest 变化时。

## 8. MCP 与 Agent 问题

### 8.1 安装/升级要求 `DATABENCH_MCP_PUBLIC_BASE_URL`

这表示 `/etc/databench/mcp.env` 还不存在。安装器不能安全猜出 agent 使用哪张网卡、IP 或内部
DNS；确认稳定地址后，为首次安装执行：

```bash
sudo env DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api ./install.sh
```

如果这是从不含 MCP 配置的旧版本首次升级，把最后的 `install.sh` 换成 `upgrade.sh`。URL path
必须精确为 `/api`，不能带 credential、query、fragment 或尾随 `/`；DNS 使用小写，默认 HTTP(S)
端口必须省略，非默认端口不能有前导零。

成功后该值会持久化到 `/etc/databench/mcp.env`。以后重跑安装或正常升级只执行
`sudo ./install.sh` 或 `sudo ./upgrade.sh`，脚本会自动复用；不需要重复传变量。若仍传入另一个值，
脚本会 fail closed，不会静默改地址。

### 8.2 Agent 连接失败或看不到 tools

先在服务器本机检查 Caddy 是否到达 MCP handler：

```bash
curl -i http://127.0.0.1/api/mcp
sudo stat -c '%U:%G %a %n' /etc/databench/mcp.env
sudo databenchctl logs api
```

第一条应返回 `405` 且 `Allow: POST`。Agent endpoint 必须是
`http://<稳定内网地址>/api/mcp`，transport 为 Streamable HTTP，不配置认证。

- `404`：当前 release 未启用 MCP，或 URL 缺少 `/api`；
- `502`：API 未 healthy；
- `403`：agent 发送了不在 public-base origin/allowlist 中的非空 `Origin`；普通非浏览器 agent
  不需要设置 Origin；
- initialize 成功但文件传输失败：确认 agent 也能访问 prepare 返回的绝对
  `/api/mcp-files/*` URL，不能只允许 `/api/mcp`。

### 8.3 一次性 URL、digest 和传输错误

| 现象 | 正确恢复动作 |
|---|---|
| `429 too_many_requests` + `Retry-After` | 等待后复用同一个 URL；不要重新 prepare 制造更多 token |
| `token_invalid_or_used` | token 已用、过期、active、超时或 API 已重启；重新 prepare |
| `input_digest_mismatch` | 上传 preview 对应的 exact bytes，或重新 preview 当前文件 |
| validation error | 按 line/path 修复临时 draft，再重新 prepare/upload |
| idle/total timeout 或 client abort | 重新 prepare；不要尝试续传旧 URL |
| import 响应丢失 | 用相同 exact bytes 重新 prepare/import，应返回同一 dataset version |
| materialize 响应丢失 | 用相同 exact bytes 重新 prepare/materialize，应返回相同 canonical JSONL |

不要保存、共享或猜测 `proc_*` / `exp_*` token。进程重启使未使用 token 失效，但不影响已提交
dataset。

### 8.4 临时文件或日志检查

正常完成、失败、timeout 和 abort 后，draft spool 都应清理：

```bash
sudo find /srv/databench/workspace/.databench-v2-temp -maxdepth 1 \
  -type f -name 'databench-v2-draft-*.jsonl' -print
```

没有正在运行的导入时不应有输出。不要手工删除 active 文件；先停止新请求并确认 API 状态。

Caddy access log在离线配置中默认关闭，runtime error log 会删除 request URI。若现场前置 LB/
代理开启 access log，必须跳过或脱敏 `/api/mcp-files/process/*`、`/api/mcp-files/export/*`，
再搜索日志确认没有完整 token。不要为了排障把完整一次性 URL 粘贴到工单。

## 9. 备份问题

### 9.1 备份失败后服务状态

备份脚本在普通调用失败时会尝试按 Worker → Swift（启用时）→ API → EvalScope → Web
重新启动应用服务。立即检查：

```bash
sudo databenchctl status
sudo databenchctl doctor
```

失败的临时 generation 会被清理，已完成 generation 不会被覆盖。

### 9.2 `backup escrow key is missing/empty`

不要随意生成新 key 取代丢失的 key；新 key 无法解密历史 `databench.env.enc`。从安全异机副本
恢复 `/etc/databench/backup.key`，并设置：

```bash
sudo chown root:root /etc/databench/backup.key
sudo chmod 0600 /etc/databench/backup.key
```

### 9.3 PostgreSQL dump、MinIO mirror、EvalScope 或 Swift volume 失败

```bash
sudo databenchctl logs postgres
sudo databenchctl logs minio
sudo databenchctl logs evalscope
df -h /srv/databench
```

不要把失败 generation 当成可恢复备份。修复后重新运行 `sudo databenchctl backup`，并在复制
到异机前执行 `sha256sum -c SHA256SUMS`。

## 10. 恢复问题

### 10.1 `matching release is not installed`

恢复要求 backup manifest 中的应用版本已经安装在：

```text
/opt/databench-offline/releases/<version>
```

找到 manifest 指定 SHA-256 的完整离线包，先安装同版本，再重新执行恢复。

### 10.2 `matching release bundle checksum is unavailable`

安装的 release 与备份引用的归档不是同一个构建。不要绕过校验。根据 `backup-manifest` 找到
精确的 bundle 文件名和 SHA-256。

### 10.3 恢复中途失败

恢复是破坏性过程。脚本失败后默认不会假装服务可用。保留：

- 原目标 generation；
- 恢复前自动创建的 safety generation；
- 当前和目标 release；
- PostgreSQL/MinIO 日志。

不要连续重复恢复。先判断失败发生在 PG、MinIO、migration 还是 smoke，再选择恢复原目标或
safety generation。

### 10.4 Swift enabled 状态与备份不一致

恢复提示 `current Swift enabled state does not match the backup` 时，读取：

```bash
grep '^swift_enabled=' /srv/databench/backups/<generation>/backup-manifest
sudo grep '^DATABENCH_SWIFT_ENABLED=' /etc/databench/swift.env
```

两者必须一致。干净机器恢复 enabled generation 时，可以先用
`DATABENCH_ENABLE_SWIFT_STUDIO=true DATABENCH_SWIFT_RUNTIME_MODE=ui-only` 安装匹配 release；
只有恢复后要训练时才预置模型并切换 `gpu`。disabled generation 使用默认关闭安装。不要绕过该检查，
否则 Catalog Session 与本地 workspace 可能来自不同 generation。

## 11. 升级和回滚问题

### 11.1 目标版本不高于当前版本

```bash
sudo databenchctl version
cat release-manifest.json
```

每个发布使用新的三段数字版本。相同版本重发或覆盖归档被明确禁止。

### 11.2 previous release 已自动恢复

升级命令非零退出，但看到：

```text
previous release <version> is serving again
```

这表示业务已恢复旧版，但升级仍失败。检查：

```bash
sudo databenchctl version
sudo databenchctl doctor
curl -fsS http://127.0.0.1/api/version
```

保留失败目标包和 pre-upgrade backup，修复发布问题后生成更高的新版本；不要用相同版本覆盖。

### 11.3 `automatic recovery failed`

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
`databenchctl status`、`databenchctl doctor` 和 `/api/version`；不能确认 contract 或 restore 失败时，
停止操作并交由发布/数据库负责人处理。

### 11.4 回滚要求 `--backup`

当前 release 声明 `restore-backup`。必须使用对应升级前 generation：

```bash
sudo databenchctl rollback <previous-version> --backup <generation>
```

不要随便选择更早或其他版本的 generation。

## 12. 宿主机重启后服务未恢复

```bash
sudo systemctl status docker --no-pager
docker ps -a --format 'table {{.Names}}\t{{.Status}}'
sudo databenchctl status
docker inspect --format '{{.State.Health.Status}}' databench-offline-worker
```

先启动 Docker：

```bash
sudo systemctl start docker
```

若个别容器 exited，查看对应日志。不要重新运行首次安装来掩盖数据盘、权限或容器启动问题。

## 13. 禁止操作清单

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
