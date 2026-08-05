# Databench Model Registry 离线运维指南

本文面向 Ubuntu 单机离线部署的 Model Registry 管理员，覆盖三种模型来源、operator CLI、
Deployment 安全边界以及备份、升级、回滚和恢复。完整领域契约见
[Model Registry 技术方案](docs/MODEL-REGISTRY-TECHNICAL-DESIGN.md)，决策边界见
[ADR 0019](docs/ADR-0019.md)，当前能力状态见
[Model Registry 状态](docs/MODEL-REGISTRY-STATUS.md)。

## 1. 先明确三个对象和三种来源

注册表的稳定层级是 `Model → Version → Deployment`：

- Model 是逻辑产品，例如“客服 Qwen”；
- Version 是不可变来源身份；同一个可变 tag、alias 或 endpoint 不能冒充不可变 Version；
- Deployment 是 Version 的可调用部署，拥有独立 lifecycle、health、endpoint policy、credential
  generation 和 capability 状态。Version 存在不代表一定存在 Deployment。

支持的三种来源是：

1. Databench Artifact：引用已经进入对象存储和 Catalog 的不可变模型 Artifact。权重不进入 CLI JSON；
2. 模型仓库：首批 runtime 支持 ModelScope 和 operator-managed。离线安装默认只对 ModelScope
   形成 declared-only 引用，不下载权重；Hugging Face 只保留 schema/profile，当前不启用 runtime adapter；
3. 已有服务：注册 OpenAI-compatible endpoint，并创建 registered Deployment。请求只传
   `credential_ref`，绝不能传 token、API key 或 Authorization header。

## 2. Operator CLI

离线包通过 `databenchctl model` 在 API 容器内运行正式 `databench model` CLI。注册请求应始终从
stdin 输入，避免 JSON、endpoint 信息或未来新增字段进入 shell history 和进程 argv。digest、Model ID、
Version ID 和 Deployment ID 不是 secret，可以作为参数传入。

常用只读命令：

```bash
sudo databenchctl model list --limit 50
sudo databenchctl model show <model-id>
sudo databenchctl model versions <model-id>
sudo databenchctl model deployment list <version-id>
```

ModelScope 离线 declared-only 注册请求示例：

```json
{
  "target": {
    "kind": "create_model",
    "key": "qwen-offline",
    "display_name": "Qwen Offline",
    "description": "ModelScope declared-only reference",
    "task_family": "chat",
    "tags": ["offline"]
  },
  "version_label": "modelscope-main",
  "source": {
    "kind": "repository_reference",
    "provider": "modelscope",
    "repository_id": "Qwen/Qwen3-0.6B",
    "revision": "main",
    "revision_kind": "tag",
    "base_model": null
  }
}
```

先保存为 `model-register.json`，再执行 Inspect。`umask 077` 确保 shell 创建的 plan 文件只对当前
用户可读；也可以只在终端查看结果而不落盘。

```bash
umask 077
sudo databenchctl model registration inspect --input - --compact \
  < model-register.json > model-register.plan.json
```

确认 plan 中的 normalized request、source mutability、verification、warning 和
`registration_digest`。Commit 必须重新提交原 strict request，而不是把 plan 当成写入指令：

```bash
sudo databenchctl model registration commit \
  --input - \
  --expected-digest <registration-digest-hex64> \
  --compact < model-register.json
```

CLI 将输入限制为 128 KiB，并拒绝 duplicate key、超深 JSON、未知字段和 schema 不匹配。Inspect 后
若原请求发生任何身份变化，Commit 返回稳定 digest conflict 且零写入。响应丢失时原样重试 Commit；
durable claim 会返回同一个 Model、Version 和 Deployment locator，并标记 replay。

## 3. 已有服务与 Deployment

已有服务请求中的 endpoint 必须先被 `/etc/databench/model-endpoint-policy.json` 明确允许。Bearer
credential 只在 `/etc/databench/secrets/model-credentials.json` authority 中保存，注册请求使用
`auth_profile: "bearer_ref"` 和 ref 名。authority 不挂入容器；API 和 EvalScope 只读各自最小 projection。

更新 authority 后按顺序执行：

```bash
sudo databenchctl model-credentials-project
sudo databenchctl restart
```

同一个 generation 的 projection 内容漂移、generation 回退、Deployment ACL 不匹配或 ref 不存在都会
fail closed。运行中的 Evaluation 使用任务开始时的 credential snapshot；rotation 不会在任务中途偷换 secret。

Deployment 命令为：

```bash
sudo databenchctl model deployment list <version-id>
sudo databenchctl model deployment activate <version-id> <deployment-id>
sudo databenchctl model deployment check <version-id> <deployment-id>
sudo databenchctl model deployment disable <version-id> <deployment-id>
```

`activate` 和 `check` 必须通过 endpoint policy、全量 A/AAAA/CIDR、credential ACL、generation 双读、
受控 discovery 和 capability admission。离线 profile 的 `public_network` 始终不可 activation 或
Evaluation；可信内网 endpoint 也必须使用 exact hostname、scheme、port 和 CIDR allowlist。

打包 CLI 不自行复制 API 进程持有的安全 transport。若当前 CLI 进程没有注入 endpoint runtime，
`activate/check` 会安全失败；此时使用 Web“模型”页的 Deployment 操作，由 API 的 pinned-address
runtime 执行。禁止用 `curl`、临时代理、关闭 policy 或把 token 放入 argv 来绕过此限制。

## 4. Archive、Alias 与 serving 边界

- `candidate` Alias 只允许指向 immutable 且 verification 合格的 Version，并使用 CAS 更新；
- staging/production Alias 当前不开放；
- archived Model 不再进入普通列表，但已经 active 的 Deployment 不被隐式停止；页面会显示
  archived-but-serving 告警；
- restore 只恢复 Model 可见性，不改变 Alias、Deployment lifecycle、health 或 credential generation；
- 要停止服务必须显式 disable 对应 Deployment，不能依赖 archive、升级或回滚的副作用。

## 5. Backup、restore、upgrade 与 rollback

Model、Version、Alias、Deployment、evidence 和 registration claim 位于 PostgreSQL；Databench Artifact
及其 manifest 位于 MinIO。Model endpoint policy、credential authority/projections 和稳定配置通过加密
escrow 纳入备份。执行：

```bash
sudo databenchctl backup
sudo databenchctl restore <generation> --confirm
sudo databenchctl upgrade <extracted-bundle>
sudo databenchctl rollback <version>
```

完整包和增量包都复用同一停写、备份、migration、doctor 和 lifecycle smoke。旧 release 回滚必须保留
legacy 与新 Model profile 可读，不会 prefix-delete 对象或隐式清理 Model 数据。若 release manifest
声明 `restore-backup`，按主部署手册提供升级前 generation；不要手工恢复单张表或只复制 MinIO。

恢复或升级后至少检查：

```bash
sudo databenchctl doctor
sudo databenchctl model list --compact
sudo databenchctl model versions <known-model-id> --compact
sudo databenchctl model deployment list <known-version-id> --compact
```

随后确认 archived-but-serving、Alias、Deployment lifecycle/health、credential generation 和 legacy
Evaluation 读取状态与变更前一致。

## 6. 当前明确不包含的能力

- 离线包不下载或搬运大模型权重；Artifact import 未来使用独立 streaming contract；
- 不启用 Hugging Face runtime adapter、managed serving 或公共云 egress；
- hosted secret backend 仍受 D3 owner 决策门约束；
- GPU gate 保持 deferred；Swift Studio GPU 是独立、显式启用的现场能力；
- Model Registry 完成不等于 V16/V17、GE9 或 production readiness 完成；
- Model Registry MCP tools 尚未授权，现有 MCP surface 不因注册表自动扩张。

任何放宽 public-network、secret backend、GPU、provider adapter 或 MCP surface 的变化都必须先更新 ADR、
技术方案和实施计划并取得 owner 决策。
