# EvalScope 离线运行手册

EvalScope 在离线包中是 Databench 的 backend-only 评测服务。用户只访问 Databench 的
`/evaluations/*` 页面；浏览器请求经同源 `/evalscope-api`、Databench API 的 exact-route gateway 到达
Compose 私网中的 `evalscope:9000`。EvalScope 不发布宿主机端口，也不携带原生 SPA。

## 安装前模型端点

离线运行不会下载 Benchmark 数据。需要运行测评时，目标机所在可信内网应已有 OpenAI-compatible
模型端点。安装前从 `model-endpoint-policy.example.json` 建立严格 JSON policy，例如：

```bash
export DATABENCH_MODEL_ENDPOINT_POLICY_SOURCE=/root/model-endpoint-policy.json
sudo -E ./install.sh
```

每条 private 规则要求 hostname 与 CIDR 同时命中，scheme/port 也必须 exact；`public_network` 在离线
profile 必须为空。不要允许 metadata、link-local、宿主控制面或不受 operator 管理的整段网络。未配置时
安装器生成 deny-all policy，服务和报告页面仍可用，但所有新测评/performance 模型 URL 会 fail closed。

模型 bearer secret 的权威文件是 `/etc/databench/secrets/model-credentials.json`（`root:root 0640`）。
该文件不挂入容器；API 与 EvalScope 分别只读 `api-model-credentials.json` 和
`evalscope-model-credentials.json`，每个 ref 还需同时通过 consumer 与 Deployment ID ACL。更新必须先
增加 authority 的 `generation`，再用包内 projector 生成同代的两份最小 projection；不得把 secret 放进
env、argv 或任务配置。authority 条目格式为：

```json
{
  "profile": "model-credentials-v1",
  "generation": 2,
  "projection_for": "authority",
  "credentials": {
    "internal-serving-a": {
      "kind": "bearer",
      "secret": "replace-with-the-exact-bearer-value",
      "allowed_consumers": ["api-health", "evalscope"],
      "allowed_deployments": ["123e4567-e89b-42d3-a456-426614174000"]
    }
  }
}
```

在维护窗口通过临时文件、`chown root:root`、`chmod 0640` 和同目录 `mv` 替换 authority，然后执行：

```bash
sudo databenchctl model-credentials-project
sudo databenchctl restart
```

projector 在已锁定 API 镜像内以 `--network none`、只读 rootfs、无 Linux capabilities 运行；它拒绝未知
字段、错误 ACL、相同 generation 内容漂移和 generation 回滚。输出为 `root:root 0444`，运行容器必须经
restart 重新挂载后才读取新 generation。authority 与 policy 进入加密 backup escrow，projection 可由
authority 重建，不单独备份。

安装脚本生成 `/etc/databench/evalscope.env`，权限固定为 `root:root 0600`。其中 task HMAC key 和 operator
token 是稳定 secret，重启和升级必须原样保留；不得复制到浏览器、任务 URL、日志或报告。

## 默认容量边界

| 资源 | 默认上限 |
|---|---:|
| EvalScope container | 4 CPU、12 GiB RAM、1024 PIDs、无 GPU |
| 同时 evaluation / performance | 2 / 2 |
| 单任务运行时间 | 24 小时 |
| input / output admission | 1 GiB / 4 GiB |
| 单归档 | 1 GiB |
| evaluation samples | 100,000 |
| evaluation batch / repeats | 256 / 10 |
| performance parallel / requests | 256 / 1,000,000 |
| performance rate | 10,000 requests/s |
| model tokens | 32,768 |
| 单模型请求 timeout | 3,600 秒 |
| task directories | 10,000 |

这些值可在维护窗口下调。不能超过 runtime 的编译上限；修改后先执行 `databenchctl restart`，再做一条小
Dataset 测评。Compose volume 本身不提供文件系统 quota，operator 仍应对 `/srv/databench/evalscope` 和
MinIO 设置宿主监控与告警。

## 状态、drain 与重启

```bash
sudo databenchctl status
sudo databenchctl evalscope-status
sudo databenchctl evalscope-drain
sudo databenchctl evalscope-resume
sudo databenchctl doctor
```

`evalscope-drain` 原子阻止新 invoke，但 progress/log/stop/report 继续可用。install/backup/upgrade/rollback/
restart 都会先停止 Web、进入 drain，并等待 active task 归零；默认 300 秒仍未归零时维护操作取消、服务恢复
admission，operator 应等待任务结束或让用户显式停止任务后重试。不要直接 `docker kill` 正在运行的服务。

若主机或容器被强制终止，启动时 reconciliation 会把无 terminal evidence 的任务标记为
`provider_interrupted`，重放 terminal callback；API 已启动后 EvalScope 才启动，保证正常 restart 的 startup
reconciliation 可以访问 Databench。

## 数据、备份与恢复

- 在线报告与 task claim：`/srv/databench/evalscope/outputs`；
- exact Dataset 临时输入：`/srv/databench/evalscope/inputs`；
- 完整结果归档：MinIO 中的 `objects/v2/evaluation-result-v1/`；
- run/archive locator：PostgreSQL `evaluation_runs_v2`。

`databenchctl backup` 在 drain 后生成同一 generation 的 PostgreSQL dump、MinIO mirror、
`evalscope-volume.tar`，并加密 escrow `databench.env`、`mcp.env`、`evalscope.env`、Model endpoint policy
与 credential authority。把 backup generation、对应
release bundle 和 `/etc/databench/backup.key` 分开复制到独立介质；仅留在本机不算灾备。
备份拒绝 EvalScope volume 中的 symlink、hardlink 和特殊文件；恢复前再次校验 tar 只含普通文件/目录且
根目录精确为 `outputs`、`inputs`，随后统一恢复为固定 EvalScope UID/GID、目录 `0750` 和文件 `0640`；
不能用手工重打包的 archive 绕过该检查。

恢复会精确清空并重建 EvalScope outputs/inputs，然后启动匹配的 release，执行 reconciliation、doctor 和
smoke。恢复前的安全备份仍由脚本自动创建。配置 escrow 不自动覆盖 `/etc/databench`；只在灾难恢复中由
operator 解密、审计后使用。

## 升级与回滚

升级包必须包含 digest-locked `databench-evalscope` image；目标机只执行 `docker load`，不会 build 或 pull。
标准流程：

```bash
sudo databenchctl upgrade /media/databench-offline-<version>-linux-amd64
sudo databenchctl doctor
sudo databenchctl rollback <previous-version>
```

升级前确认 `/evaluations/tasks` 没有长任务或预留足够 drain 时间。脚本依次 drain、备份、加载完整镜像集、执行
migration、启动 Swift Studio（启用时）→ API → EvalScope → Web、验证同源 gateway 和 smoke；失败会恢复上一 release。回滚到旧的
五/六镜像 release 时，旧 release 的 Compose 不启动 EvalScope，但 E9 创建的数据目录和配置不会被隐式删除。

## 断网验收

最终目标机 gate 必须在 Ubuntu 22.04 amd64、切断公网后完成：install、Dataset selection、evaluation、
native report、compare、performance、callback/archive、restart/reconcile、upgrade、rollback。另检查：

- `/evalscope-api/`、SPA/static、resume/scan 和 synthetic endpoint 均为 404；
- `/api/v1/config` 不含绝对路径；
- malicious HTML/Markdown 只能进入 sandbox generated document；
- DNS rebinding、redirect、metadata/link-local model URL 被拒绝；
- report/chart/performance 的 Plotly digest 固定，断网无 external asset request；
- API、Caddy、Worker、EvalScope 日志不含 credential、signed URL、prompt 或 prediction。

本地/macOS Compose smoke 不能替代这项真实目标机验收。
