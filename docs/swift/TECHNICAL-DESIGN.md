# ms-swift 原生 Gradio Studio 集成技术方案

- **状态:** Accepted
- **日期:** 2026-07-28
- **决策:** [ADR 0018](../decisions/0018-ms-swift-native-gradio-studio.md)
- **实施计划:** [PLAN.md](PLAN.md)
- **实施状态:** [STATUS.md](STATUS.md)
- **上游:** `modelscope/ms-swift@v4.4.2`
- **上游 commit:** `f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d`

## 1. 决策摘要

首期不迁移 ms-swift Gradio UI，也不把原生训练 callback 改写成 Databench Training Run。Databench
嵌入完整原版 Gradio，并只实现四个桥：

```text
Studio Session
Dataset exact export
GPU/Session workspace
Model Artifact import
```

首期运行形态为一个 GPU-enabled Swift Studio instance、一个 active Databench Session、一个真实训练
smoke。用户可以看到并使用锁定上游提供的全部页面；Databench 只对已经通过 capability gate 的运行组合
作支持声明。

完整产品闭环分两层：

```text
最小训练闭环：Dataset → Studio → Model Artifact
完整评测闭环：Dataset → Studio → Artifact → Deployment → EvalScope
```

## 2. 设计目标

### 2.1 首期目标

1. 在 Databench `/training` 中显示完整原生 ms-swift Gradio；
2. 从 Databench Ref 锁定 exact Dataset version，并确定性导出 ms-swift JSONL；
3. 把导出路径和 Session output root 预填到原生 UI，不改写业务 callback；
4. 在真实 Linux/NVIDIA GPU 上完成小模型 SFT + LoRA 和原生 Infer；
5. 把 LoRA output 导入为 immutable Databench Model Artifact；
6. 为后续 Deployment → EvalScope 保留稳定 Artifact 和 lineage；
7. 保持上游升级可审计，不让 Gradio config 变成公共契约。

### 2.2 后续目标

- 多 Session、多 GPU 与资源分配；
- merged/full/quantized model importer；
- managed Deployment；
- 原生任务与 Databench Training Run 的选择性同步；
- 按 SFT/DPO/GRPO 页面逐步接管 callback；
- 可替换为 React 原生训练页而不改变 Dataset/Artifact API。

### 2.3 非目标

- 首期实现 Training Run/Attempt/lease/fencing；
- 首期重写全部 Gradio UI；
- 首期把所有原生 task 写入 Postgres；
- 首期支持多用户共享同一个 Studio instance；
- 首期自动导入任意 output_dir；
- 首期导入 optimizer/resume checkpoint；
- 首期把所有上游可选依赖组合标记为已验证；
- 首期将 Swift 纳入 ADR 0012 的默认 CPU-only 离线安装。

## 3. 已验证的当前事实

### 3.1 上游 UI

锁定源码 `swift/ui/app.py` 构建一个 Gradio `Blocks`，并注册：

```text
LLMTrain
LLMRLHF
LLMGRPO
LLMInfer
LLMExport
LLMEval
LLMSample
```

随后调用：

```python
app.queue(...).launch(
    server_name=server,
    server_port=port,
    share=share,
)
```

上游默认 `server_name=0.0.0.0`、`server_port=7860`、`share=False`。环境变量
`WEBUI_SERVER`、`WEBUI_PORT`、`WEBUI_SHARE` 和 `SWIFT_UI_LANG` 可覆盖部分行为。

### 3.2 Dataset 与 output

上游 Train Dataset 使用 `gr.Dropdown(multiselect=True, allow_custom_value=True)`，支持内置 Dataset 和
本地文件/目录。训练超参数中包含可编辑 `output_dir`。因此 Databench 无需新增自定义 Dataset loader；
只要产生兼容 JSONL 并把 provider-local 路径预填到 Dropdown 即可。

原生 callback 自己构造 `swift <stage>` argv、环境变量、GPU visibility、logging/output dir，并直接启动
进程。首期不改变这条执行路径。

### 3.3 依赖基线

上游 v4.4.2 声明 Python `>=3.10`，README 推荐 Python 3.12、CUDA 12.8/13.0、Torch 2.8/2.11 和
Gradio 5.32.1；`requirements/framework.txt` 允许 `gradio>=3.40.0,<6.0`。Databench 不能依赖这个宽范围，
S0 必须锁定一个真实安装组合和 image digest。

### 3.4 Databench 已有 Dataset converter

`packages/io/src/v2/converter-projection.ts` 已实现 `ms-swift` converter：

- version `1.0.0`；
- media type 为 JSONL；
- 每个 selected candidate 生成一行；
- 输出 `messages`；
- `tools` 使用确定性 JSON string；
- config hint 固定 minimum ms-swift `4.2.0`；
- config hint 提供 `is_binary_loss_scale`；
- preference/verification 等未进入 SFT 投影的信息会进入 fidelity change。

现有 REST 已提供：

```text
POST /v2/datasets/{ref_or_version}:inspect-export
POST /v2/datasets/{dataset_version}:export
```

因此 Swift Studio 不新增 Dataset list/inspect/export 私有实现。

## 4. 总体架构

```text
Browser
  │
  ├─ Databench Web /training
  │    ├─ exact Dataset selector
  │    ├─ Session status/actions
  │    ├─ Artifact import panel
  │    └─ iframe /swift-studio/
  │
  ├─ Databench /v2 REST
  │    └─ API → Workspace → Schema/Catalog/Store
  │
  └─ /swift-studio/* Gateway
       └─ Swift Studio Gradio :7860

Workspace
  │
  └─ internal exact Studio Provider client
       └─ Swift Studio Provider :7861
            ├─ Session input/output management
            ├─ exact Dataset download and verification
            ├─ output discovery
            └─ Artifact staging

Swift Studio container
  ├─ pinned ms-swift + Gradio
  ├─ NVIDIA GPU
  ├─ persistent model cache
  └─ persistent session workspace

Object Store
  ├─ immutable Dataset artifacts
  ├─ exact temporary model staging
  └─ immutable Model Artifact tar.zst
```

## 5. 组件职责

### 5.1 `apps/web`

新增 `apps/web/src/training/`：

```text
training/
├─ api/                 generated Databench API wrappers only
├─ components/          Dataset selector、Session banner、Artifact importer
├─ routes/              /training lazy route
├─ styles/              仅 Databench 外层壳样式
└─ domain/              typed UI state；不复制 Gradio config
```

职责：

- 选择 Ref/exact version；
- 调用 inspect，展示 output count 和 fidelity；
- 创建/查询/关闭 Studio Session；
- iframe 加载固定 `/swift-studio/`；
- 查询当前 Session 可导入 output；
- 发起 Artifact import 并显示结果；
- 从 Artifact 进入后续 Deployment/Evaluation。

不负责：

- 渲染 ms-swift 字段；
- 构造训练 argv；
- 解析 Gradio `/config`；
- 查询原生 PID；
- 伪造任务进度。

### 5.2 Databench API/Workspace

公共 REST 的 Zod contract 位于 `@databench/schema`，路由只调用 Workspace。Workspace 负责：

- resolve Ref → exact Dataset version；
- `ms-swift` converter inspect/fidelity approval；
- Session idempotency 与单 active Session conflict；
- 调用内部 Studio Provider；
- 保存 Session/Artifact import 元数据；
- Model Artifact finalization；
- 生成浏览器可用的相对 `studio_path`，不返回 internal origin/absolute path。

API 不直连 Catalog、Store 或 IO。Web 对 Databench REST 只消费 generated OpenAPI client。

### 5.3 Swift Studio Provider

新增 Python provider source：

```text
workers/swift-studio/
├─ pyproject.toml
├─ uv.lock
├─ src/databench_swift_studio/
│  ├─ app.py             internal control API
│  ├─ config.py
│  ├─ sessions.py        exact session directories and state
│  ├─ databench.py       exact inspect/export client
│  ├─ outputs.py         bounded output discovery
│  ├─ artifacts.py       LoRA validation/archive/staging
│  └─ errors.py
└─ tests/
```

Provider 与 Gradio 共享 Session workspace，但 Provider：

- 不连接 Databench Postgres；
- 不读取 internal object key；
- 不持有 OSS/MinIO 长期凭据；
- 不创建 Training Run；
- 不替换原生 callback；
- 不负责原生任务级进度和取消。

Provider control API 只允许 Databench internal origin 访问，不进入浏览器 generated client。

### 5.4 第三方构建输入与 Swift Studio 部署

上游源码、补丁与兼容性基线属于第三方集成构建输入，位于：

```text
third_party/ms-swift/
├─ upstream.lock
├─ README.md
├─ upstream-manifest.json
├─ gradio-baseline.json
├─ gradio-routes.json
├─ runtime-capabilities.json
├─ patches/
│  └─ 0001-databench-session-prefill.patch
└─ vendor/
   └─ ms-swift-upstream.tar.gz
```

部署资产单独位于：

```text
deploy/swift-studio/
├─ Dockerfile
├─ compose.yaml
└─ gateway/              deployment-only 配置
```

`deploy/` 不持有 Python Provider 源码、vendored upstream、补丁或兼容性 fixture。镜像构建只消费
`third_party/ms-swift/` 与 `workers/swift-studio/` 的固定输入。

`upstream.lock` 至少固定：

- repo/tag/commit/tree；
- Apache-2.0 license digest；
- base image digest；
- Python、CUDA、Torch、Transformers、Gradio、ms-swift dependency lock；
- downstream patch digest；
- Gradio route/config/callback baseline digest；
- image build input digests。

### 5.5 Gateway

Gateway 代理完整锁定 Gradio App，而不是复制其 REST：

```text
/swift-studio/* → swift-studio:7860
```

必须支持：

- HTML/config/static assets；
- POST/streaming request；
- Gradio Queue 与 SSE；
- WebSocket upgrade；
- upload/download；
- long-running timeouts；
- `X-Forwarded-*` 与 root path；
- 关闭不适合流式响应的 proxy buffering。

本地开发由 Vite proxy 或本地 Caddy 提供；离线/生产由统一 reverse proxy 提供。`7860` 不单独发布为
产品 URL。

## 6. 首期部署拓扑

```text
swift-studio service
  ports:
    7860  Gradio，private
    7861  Provider control，private
  devices:
    NVIDIA GPU(s)
  volumes:
    /workspace/sessions   persistent, provider + Gradio shared
    /workspace/cache      persistent model cache
    /tmp                  bounded ephemeral
```

首期只允许一个 active Session：

```text
none
  → preparing
  → ready
  → closing
  → closed

preparing/ready/closing
  └→ failed
```

`ready` 只表示 Dataset 和工作目录准备完成、Gradio 可打开，不表示存在或正在执行训练。

### 6.1 GPU 边界

- Studio service 通过 NVIDIA Container Runtime 获取 operator 配置的 GPU；
- 容器外只暴露已分配设备，原生 GPU selector 只能选择容器内可见设备；
- MVP gate 使用一张 GPU、一个 active Session、一个训练任务；
- Studio idle 时仍占有 deployment allocation，这是首期接受的资源成本；
- 多用户/多 GPU allocator 属于 S5。

### 6.2 网络模式

首期支持 `online-internal`：Studio 可按 operator 配置访问 ModelScope/Hugging Face、模型 endpoint 和
原生功能需要的服务。模型/token 配置仍由部署环境注入，不从 Databench Dataset 元数据推断。

`offline` 是独立能力：必须预置 image、模型缓存和运行依赖，并通过断网 gate 后才能声明。S1 的联网
GPU smoke 不改变 ADR 0012。

## 7. Studio Session 数据模型

### 7.1 `swift_studio_sessions_v2`

建议字段：

```text
id                         UUID / opaque public id
namespace                  bounded namespace
create_digest              canonical idempotency digest
status                     preparing|ready|closing|closed|failed
dataset_version            exact Dataset FK, RESTRICT
display_ref                nullable display-only ref
converter                  ms-swift
converter_version          1.0.0
normalized_options         bounded JSON
fidelity_digest            export approval digest
export_output_count        bigint
export_digest              nullable until provider ready
export_size_bytes           nullable until provider ready
provider                   swift-studio
provider_session_id         bounded opaque locator
upstream_commit             fixed commit
image_digest                fixed image digest
runtime_capability_digest   fixed manifest digest
failure                     nullable bounded sanitized error
created_at
ready_at
closed_at
```

约束：

- 同一 runtime 首期最多一条 `preparing|ready|closing` Session；
- create digest 绑定 namespace、exact Dataset、converter plan、provider/image；
- 同 digest 重放返回既有 Session；不同 digest 在 singleton active 时返回 409；
- DB 不保存 provider absolute input/output path；
- Session 不保存样本 payload、完整 Gradio config、完整 argv 或日志。

### 7.2 create identity

若 Session create 参与幂等 identity，必须使用新的 domain/profile，经
`@databench/hashing` RFC 8785 + BLAKE3 路径构造，至少绑定：

```text
namespace
dataset_version
converter/version/normalized_options
fidelity_digest
output_count
provider
upstream_commit
image profile
```

不得用裸 `JSON.stringify`。S2 必须增加 fixed vector。

## 8. Dataset Bridge

### 8.1 创建流程

```text
Web selects Ref/exact version
  → POST inspect-export {converter:"ms-swift", options:{}}
  → user accepts fidelity when required
  → POST /v2/swift-studio-sessions
  → Workspace resolves exact Dataset again
  → Workspace re-inspects exact converter plan
  → Catalog inserts preparing Session idempotently
  → Workspace calls Provider create-session
  → Provider streams exact export from Databench
  → Provider verifies digest/size/count
  → Provider fsync/rename + atomic session manifest
  → Workspace transitions Session to ready
  → Web loads iframe
```

### 8.2 Provider filesystem layout

```text
/workspace/sessions/<provider-session-id>/
├─ session.json
├─ input/
│  ├─ ms-swift.jsonl
│  └─ export.json
├─ output/
├─ logs/
└─ tmp/
```

Provider 写入流程：

1. `sessions/<id>.partial` 创建在同一 filesystem；
2. 以 exclusive create 写 `input/ms-swift.jsonl.partial`；
3. 流式计算 BLAKE3、size 和 newline/output count；
4. 与 Workspace/HTTP metadata 对比；
5. file fsync；
6. rename 成 `ms-swift.jsonl`；
7. 写 canonical/bounded `export.json` 与 provider-owned `session.json`；
8. directory fsync；
9. rename `<id>.partial` → `<id>`；
10. 返回 provider session locator、digest、size、count。

失败时只清理记录过的 exact partial paths，不使用 glob/prefix delete。

### 8.3 Gradio 预填 patch

downstream patch 只允许以下集成变化：

- `.launch()` 接收固定 `root_path=/swift-studio`；
- page load 从 Provider 当前 active Session 读取：
  - `dataset_path`
  - `output_dir`
  - `logging_dir`
  - Dataset display label；
- Train/RLHF/GRPO 共用的 Dataset Dropdown 默认包含当前 JSONL；
- output/logging 默认指向当前 Session；
- 页面顶部显示 Databench Dataset Version 与“只有 output root 内产物可导入”的说明。

不得修改：

- 七个顶级业务面的注册；
- 原生表单字段集合；
- 原生 submit/stop/runtime callback；
- `more_params`、env、GPU 等原生字段；
- 原生 infer/export/eval/sample 行为。

每次上游升级必须验证 patch 可以干净应用，并比较 component/dependency/callback manifest。

### 8.4 lineage 证明

Session 绑定 Dataset 不代表 Session 内所有任务都使用它。LoRA importer 使用三态：

```text
verified
external_or_unverified
not_applicable
```

`verified` 必须同时满足：

- Artifact 来源 output 位于当前 Session；
- sanitized args 中的训练 Dataset 精确解析为当前 provider-local export；
- export digest 与 Session 中记录一致；
- 没有额外 Dataset，或 importer 能完整记录所有额外 Dataset；
- converter minimum version 与实际 ms-swift version 匹配。

不能证明时仍可在可信内部模式导入，但必须显式标记 `external_or_unverified`，不能自动进入“verified
Dataset → Model”报表。

## 9. 公共 REST 契约

以下为目标操作面；精确 schema 在 S2/S3 实现时进入 `@databench/schema`：

```text
POST /v2/swift-studio-sessions
GET  /v2/swift-studio-sessions
GET  /v2/swift-studio-sessions/{session_id}
POST /v2/swift-studio-sessions/{session_id}:close

GET  /v2/swift-studio-sessions/{session_id}/outputs
POST /v2/model-artifact-imports
GET  /v2/model-artifact-imports/{import_id}
GET  /v2/model-artifacts
GET  /v2/model-artifacts/{artifact_id}
```

### 9.1 创建 Session

概念请求：

```json
{
  "dataset_version": "<64-hex>",
  "display_ref": "optional",
  "converter": "ms-swift",
  "options": {},
  "accepted_fidelity_digest": "<64-hex-or-null>"
}
```

概念响应：

```json
{
  "id": "<uuid>",
  "status": "preparing",
  "dataset_version": "<64-hex>",
  "converter_version": "1.0.0",
  "output_count": 100,
  "studio_path": null
}
```

`ready` 后 `studio_path` 只能是 Databench 相对路径 `/swift-studio/`，不得返回 internal origin、端口、
provider path 或 credential。

### 9.2 Output discovery

Provider 只返回 opaque output handle 和相对显示信息：

```json
{
  "items": [
    {
      "handle": "<opaque>",
      "display_name": "checkpoint-5",
      "candidate_kinds": ["lora_adapter"],
      "size_bytes": 12345678,
      "modified_at": "...",
      "importable": true,
      "reason": null
    }
  ]
}
```

浏览器不提交 absolute path。handle 必须绑定 Session、relative path snapshot 和 provider generation，防止
output 改变后导入另一个目录。

### 9.3 Artifact import

概念请求：

```json
{
  "studio_session_id": "<uuid>",
  "output_handle": "<opaque>",
  "artifact_kind": "lora_adapter",
  "display_name": "customer-service-lora",
  "base_model": {
    "reference": "Qwen/Qwen3-0.6B",
    "revision": "<pinned-revision-or-null>"
  }
}
```

Artifact import 可能需要上传 GB 级文件，必须异步：

```text
requested → staging → finalizing → completed
                         ├→ failed
                         └→ cancelled（仅 final create 前）
```

首期可以不开放用户 cancel，但状态机必须区分 staging/finalizing；API 响应丢失时相同 import identity 可
幂等查询或重放。

## 10. LoRA Model Artifact

### 10.1 首个可导入 kind

S3 只声明：

```text
artifact_kind = lora_adapter
artifact_format = swift-lora-adapter-v1
archive_format = deterministic-tar-zst-v1
```

最低必要文件：

```text
adapter_config.json
adapter_model.safetensors 或 adapter_model-*.safetensors + index
```

可选 allowlist：

```text
tokenizer.json
tokenizer_config.json
special_tokens_map.json
added_tokens.json
merges.txt
vocab.json
preprocessor_config.json
processor_config.json
chat_template.json
```

排除：

```text
training_args.bin
optimizer.pt
scheduler.pt
rng_state*.pth
*.pkl / *.pickle
原始 args.json
train.sh
完整日志
TensorBoard event 原始文件
任意 symlink/device/socket
```

### 10.2 sanitized manifest

Databench-owned manifest 至少包含：

```text
manifest_version
artifact_kind/format
archive_digest/size
file list + per-file digest/size
source Studio Session/upstream/image
dataset lineage status
exact Dataset/version/export digest（仅 verified）
base model reference/revision/binding status
sanitized training summary
created_at/created_by
```

训练摘要只提取 allowlist，例如 train stage、tuner type、LoRA rank/alpha/dropout、epoch/max steps、learning
rate、max length、dtype、seed。所有 env/token/plugin/local absolute path 被丢弃或用明确的
`redacted_fields` 计数表示。

### 10.3 deterministic archive

归档固定：

- UTF-8 POSIX relative path；
- ASCII/bytewise 排序；
- mtime `0`；
- uid/gid `0`，uname/gname 空；
- regular file mode 固定；
- 不跟随 symlink；
- tar header format 固定；
- zstd implementation/version/level 固定；
- digest 对最终 `.tar.zst` bytes 计算。

同一 output snapshot 的重试必须产生相同 bytes。S3 建立 Linux fixed archive golden。

### 10.4 staging/finalization

```text
Provider
  → exact import-scoped staging PUT
  → BLAKE3 + size + manifest digest callback
  → Workspace exact staging read/verify
  → conditional create objects/v2/model-artifact-v1/<shard>/<digest>.tar.zst
  → Catalog transaction registers model_artifacts_v2
  → exact staging cleanup
```

Provider 只获得短期 exact-key PUT；最终 key 由 Databench Store 计算。不得 prefix scan/delete。

## 11. Model Artifact Catalog

建议 `model_artifacts_v2` 字段：

```text
id
namespace
kind
format
archive_digest
archive_size_bytes
object_locator
manifest_digest
manifest_json
source_kind = swift_studio_session
source_session_id
source_import_id
dataset_lineage_status
dataset_version nullable
dataset_export_digest nullable
base_model_reference
base_model_revision nullable
base_model_binding_status = verified|declared|unresolved
upstream_commit
image_digest
created_at
```

约束：

- archive digest/locator immutable；
- object 必须在 Catalog transaction 前完成 conditional create；
- Session 删除/过期不能删除 Artifact；
- Dataset FK 在 verified 时使用 `RESTRICT`；
- Artifact list 不读取原生 Studio output；
- 原生 output retention 与 immutable Artifact retention 分离。

## 12. Studio output retention

Session workspace 是可变 provider 数据，不是 canonical object。首期默认：

```text
ready/active Session        不自动清理
closed Session input        24h 后 exact cleanup
closed Session output       7d 后提醒，14d 后 operator cleanup
completed imported output   不因 Artifact 成功立即删除
model cache                 operator 管理
```

实际默认值在 S2 通过配置锁定。清理要求：

- 只使用 Catalog/Provider 记录的 exact Session locator；
- 拒绝 symlink/realpath escape；
- 不扫描任意 output root；
- 先关闭 Session，再确认没有原生活动任务；
- cleanup 失败保留状态并可重试；
- 物理删除不影响已发布 Artifact。

## 13. Gateway 与 iframe

### 13.1 产品路由

```text
/training                Databench 页面壳
/swift-studio/*          完整 Gradio reverse proxy
```

`/training` 进入主导航。Gradio 不注册 TanStack Router route，不 import 到 React bundle。

### 13.2 iframe

外层页面结构：

```text
Training header
Dataset/Session toolbar
Artifact import/status drawer
iframe /swift-studio/
```

iframe 至少允许原生 UI 所需的 scripts/forms/downloads；是否允许 popups 由 S1 对 Hub/docs/报告新窗口真实
测试决定。页面高度采用 viewport 计算，避免固定 800px 和双重滚动。

### 13.3 兼容性 manifest

S0/S1 固定：

- `/config` component/dependency digest；
- 七个顶级业务面存在性；
- submit/stop/runtime 等关键 callback presence；
- HTTP route/method 集合；
- Queue/SSE/WebSocket smoke；
- upload/download smoke；
- iframe direct refresh；
- root path 下静态资源无 404。

这里的 manifest 用于发现上游升级破坏，不用于把 Gradio API 变成 Databench 公共 API。

## 14. Provider internal contract

建议 exact operations：

```text
GET  /internal/health
GET  /internal/runtime
POST /internal/sessions
GET  /internal/sessions/{provider_session_id}
POST /internal/sessions/{provider_session_id}/close
GET  /internal/sessions/{provider_session_id}/outputs
POST /internal/sessions/{provider_session_id}/artifact-imports
GET  /internal/artifact-imports/{provider_import_id}
```

契约要求：

- strict JSON；
- method + exact path；
- bounded body/response；
- opaque locator，不返回 absolute path；
- request id/idempotency key；
- sanitized error；
- abort/timeout；
- provider generation 与 image/upstream digest；
- callback/reconcile 允许相同 terminal body 重放。

Provider API 不进入 OpenAPI public spec。Workspace 使用隔离的 typed adapter 和 contract fixtures。

## 15. 原生任务与 Session 的关系

首期明确：

```text
1 Studio Session
  ├─ 0..N 原生训练任务
  ├─ 0..N 原生推理/部署任务
  └─ 0..N output directories
```

Databench 只知道 Session 和经过 importer 选择的 output。以下 UI 文案禁止出现：

- “Databench 正在运行第 N 个训练任务”；
- “Databench 已取消训练”；
- “该 Session completed”；
- “自动恢复训练”；
- “训练参数已完整记录”。

外层状态使用：

```text
正在准备 Studio
Studio 可用
Studio 不可用
正在导入产物
产物已导入
```

训练状态仍在 iframe 的原生 Runtime 中显示。

## 16. Failure 与恢复

### 16.1 Dataset prepare 失败

- Session 保持 `failed`；
- 保存 bounded error category；
- partial input exact cleanup；
- 相同 create digest 可查询既有失败，用户显式 Retry 创建新 Session 或 provider attempt；
- 不把 partial export 暴露给 Gradio。

### 16.2 Studio process 重启

- Provider 从当前 Session manifest 恢复 Dataset/output binding；
- Gradio 原生进行自身任务历史/进程恢复；
- Databench 不对重启前运行中的原生任务作成功/失败推断；
- 已完成 Artifact import 不依赖 Studio 存活。

### 16.3 Artifact import callback 丢失

- Provider terminal result 持久化在 import-local manifest；
- Workspace 以 import id + digest/size 幂等查询；
- final object conditional create；
- 相同 final result 重放成功；不同 digest 返回 conflict；
- staging cleanup 在 Catalog 注册成功后执行，失败可重试。

### 16.4 磁盘不足

- Session prepare 前检查 input + configured reserve；
- Artifact import 前计算 candidate snapshot size、archive working-set 与对象上传空间；
- 容量不足返回 typed capacity error，不生成部分 Artifact；
- 模型缓存和 output 使用独立容量指标。

## 17. 配置

建议配置键：

```text
DATABENCH_SWIFT_STUDIO_ENABLED=false
DATABENCH_SWIFT_STUDIO_ORIGIN=http://swift-studio:7860
DATABENCH_SWIFT_PROVIDER_ORIGIN=http://swift-studio:7861
DATABENCH_SWIFT_ROOT_PATH=/swift-studio
DATABENCH_SWIFT_SESSION_ROOT=/workspace/sessions
DATABENCH_SWIFT_MODEL_CACHE=/workspace/cache
DATABENCH_SWIFT_MAX_ACTIVE_SESSIONS=1
DATABENCH_SWIFT_SESSION_INPUT_MAX_BYTES=...
DATABENCH_SWIFT_SESSION_OUTPUT_MAX_BYTES=...
DATABENCH_SWIFT_ARTIFACT_MAX_BYTES=...
DATABENCH_SWIFT_SESSION_RETENTION_HOURS=...
DATABENCH_SWIFT_OUTPUT_RETENTION_HOURS=...
WEBUI_SHARE=false
SWIFT_UI_LANG=zh
```

API 与 Provider 各自用 Zod/Pydantic 等 strict config 校验。internal origins、filesystem roots、tokens 和
object credentials 不进入 public config 或 Web bundle。

## 18. 可观测性

Databench 指标：

```text
swift_studio_session_create_total{status}
swift_studio_session_prepare_seconds
swift_studio_active_sessions
swift_studio_export_bytes
swift_studio_output_bytes
swift_artifact_import_total{kind,status}
swift_artifact_import_bytes
swift_artifact_finalize_seconds
swift_studio_gateway_requests{route_class,status}
```

日志关联键：

```text
request_id
studio_session_id
provider_session_id
artifact_import_id
model_artifact_id
```

不把 Dataset 样本、prompt、完整 argv、token 或绝对路径写入 Databench 结构化日志。

原生 Gradio/ms-swift 日志仍留在 Session workspace/iframe Runtime；首期不复制进 Postgres。

## 19. 能力声明

`runtime-capabilities.json` 每项包含：

```text
capability id
upstream surface
required Python/system packages
required GPU/runtime
surface-present
runtime-installed
runtime-validated
validation evidence
known limitations
```

S1 最小 green：

```text
full-gradio-surface
databench-root-path-embed
single-session-context
qwen-small-sft-lora
transformers-lora-infer
```

其他 RLHF/GRPO/vLLM/DeepSpeed/Megatron/quantization/Eval/Sample 页面从第一天保留，但只有在真实 gate 后
才把对应 `runtime-validated` 置为 true。

## 20. 最小真实 GPU Gate

建议模型：

```text
Qwen/Qwen3-0.6B
或 Qwen/Qwen2.5-0.5B-Instruct
```

Dataset：32～100 条 Databench exact SFT records。

建议 smoke 参数：

```text
LoRA rank = 8
max_steps = 2～5
max_length = 128
batch_size = 1
gradient_accumulation_steps = 1
save_steps = 1
```

必须验证：

1. `/training` iframe 显示锁定上游全部七个顶级业务面；
2. Gradio static/config/Queue/SSE/WS/upload/download 的必要路径通过 Gateway；
3. exact Dataset inspect/fidelity/export 的 version、converter、digest、count 一致；
4. Gradio Dataset 和 output_dir 正确预填；
5. 使用预填 Dataset 完成真实 LoRA；
6. 原生 Runtime 能查看日志并停止一个长任务；
7. 原生 Infer 使用 Adapter 成功；
8. output discovery 只列出当前 Session root；
9. LoRA importer 拒绝 symlink、pickle 和 snapshot 变化；
10. finalize response 丢失后可幂等重放；
11. Artifact 从对象存储下载到全新目录后，以 explicit base + adapter 完成推理；
12. Studio 重启后已发布 Artifact 仍可用；
13. 第二个 active Session 收到确定 409；
14. 浏览器 direct refresh、console、连接失败和恢复状态正确。

## 21. Deployment 与 EvalScope 扩展

S4 增加独立 `model_deployments_v2` 或复用届时已接受的 Deployment contract。最低要求：

- Deployment 绑定 immutable Model Artifact；
- LoRA 必须绑定可解析的 base model；
- endpoint 由 operator/provider 注册，浏览器只使用 opaque Deployment ID；
- EvalScope provider 从 Databench 服务端解析 Deployment，不信任用户提交的内部 URL；
- Evaluation Run 保存 Deployment/Artifact/Dataset lineage；
- Studio Session 关闭不影响 managed Deployment；
- 原生 Studio Deploy 只有显式注册后才成为 Databench Deployment。

## 22. 后续迁移到 Databench Training Control Plane

当单实例/原生 Runtime 不能满足并发、审计或自动化时，进入 S6：

```text
原生 Gradio field values
  → versioned TrainingProfile
  → Databench Training Run
  → Workspace dispatcher
  → internal gRPC Swift Worker
  → immutable Model Artifact
```

迁移原则：

- 页面可以继续使用 Gradio；
- 只接管已经版本化的 capability callback；
- 未接管的原生页面仍留在独立 Studio 模式；
- Training Run 与 Studio Session 不复用表；
- Retry 创建新 Attempt，Resume/继续训练保持明确 lineage；
- 可以最终替换成 React Schema Form，但后端 contract 不依赖 Gradio。

现有 WorkerService 的 DB-clock lease、heartbeat、lease token fence、exact cancel、signed staging 和
finalizer 作为 S6 基础，不在 S1-S4 重复实现。

## 23. 目录与依赖方向

计划新增：

```text
apps/web/src/training/
apps/api/src/swift-studio/
apps/api/src/routes/v2/swift-studio.ts
apps/api/src/routes/v2/model-artifacts.ts
packages/schema/src/v2/swift-studio.ts
packages/schema/src/v2/model-artifact.ts
packages/catalog/src/v2/...
packages/store/src/v2/model-artifact*.ts
packages/workspace/src/v2/swift-studio.ts
packages/workspace/src/internal/swift-studio/
workers/swift-studio/
third_party/ms-swift/
deploy/swift-studio/
docs/swift/
```

依赖保持：

```text
apps/api → workspace + schema
workspace → catalog/store/io/schema/hashing + internal provider adapter
apps/web → generated OpenAPI client
workers/swift-studio → Databench REST/internal control contract，不进入 TS package DAG
third_party/ms-swift → deploy image build input，不进入 runtime import DAG
```

Studio Provider 不连接 Catalog/Store；最终 Artifact identity/publication 仍由 Workspace 拥有。

## 24. Gate 与发布边界

每个 accepted Step 一个 PR/commit。除 Step-specific gate 外，涉及代码的 Step 至少运行：

```text
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm openapi:check
pnpm v2:status:check
pnpm peers check
pnpm offline:check
git diff --check
```

涉及数据库、对象存储、Provider、浏览器或 GPU 的 Step 必须增加对应真实 gate，不能用 fake 替代后声明
完成。Swift runtime 保持 disabled-by-default，直到 S4 通过完整 Dataset → Artifact → Deployment →
EvalScope gate。即使 owner 允许内部试用，也不改变 V16/V17 状态或公共云 D3。
