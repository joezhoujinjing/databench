# ADR 0018 — ms-swift 原生 Gradio Studio 嵌入与 Databench 桥接

- **状态:** Accepted——owner 于 2026-07-28 确认采用完整原生 Gradio 的最小集成方案；
  同日进一步确认真实 NVIDIA gate 后置，不阻塞 S2-S4 代码实施
- **日期:** 2026-07-28
- **决策者:** owner
- **依赖:** [ADR 0003](0003-storage-postgres-object-store.md)、
  [ADR 0008](0008-object-store-aliyun-oss.md)、
  [ADR 0009](0009-canonical-post-training-record-v2.md)、
  [ADR 0011](0011-identity-hashing-versioning-v2.md)、
  [ADR 0012](0012-offline-single-host-deployment.md)、
  [ADR 0013](0013-v2-product-cutover-and-v1-retirement.md)、
  [ADR 0017](0017-evalscope-native-ui-integration.md)
- **详细方案:** [ms-swift 集成技术方案](../swift/TECHNICAL-DESIGN.md)
- **实施计划:** [ms-swift 集成实施计划](../swift/PLAN.md)
- **上游基线:** `modelscope/ms-swift@v4.4.2`，commit
  `f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d`

## 背景

Databench 已具备 Dataset 管理与 EvalScope 评测产品面。训练能力需要先以最小成本接入，尽快验证
真实 NVIDIA GPU、Databench Dataset、ms-swift 训练、模型产物和 EvalScope 之间的闭环，同时避免在
首期重写 ms-swift 数百个 Gradio 字段、Tab、显隐关系和 Python callback。

ms-swift v4.4.2 的 Web UI 使用 Gradio Blocks 构建。上游
`swift/ui/app.py` 注册七个顶级业务面：`LLMTrain`、`LLMRLHF`、`LLMGRPO`、`LLMInfer`、
`LLMExport`、`LLMEval` 和 `LLMSample`，并直接在 Gradio callback 中启动、查询和停止训练、推理、
部署、导出与评测进程。它不是可以从 Python 声明自动转换为可维护 React 源码的静态页面。

此前评估过两条路线：

1. 把全部 Gradio 页面迁成 Databench React，并把 callback 重写成 Databench Training Run；
2. 直接嵌入上游完整 Gradio，把 Databench 集成限制在 Studio 会话、Dataset 导出、运行目录和模型产物。

owner 决定首期采用第二条路线。首期目标是“完整原生工具可用并形成最小数据/产物桥”，不是立即把
ms-swift 内部所有任务语义重建成 Databench 原生训练控制面。

## 决策

### 1. 首期完整嵌入锁定版本的原生 Gradio UI

- Databench 新增无版本产品入口 `/training`，在 Databench 页面壳内通过 iframe 显示完整 ms-swift
  Gradio；
- 保留上游七个顶级业务面、全部原生字段、显隐关系、Runtime、日志和 callback；
- 不以 CSS 隐藏未集成功能，不把页面收缩为 SFT + LoRA，也不在首期复刻 React UI；
- 不把 Gradio runtime config 当作 Databench 长期 API contract；它只属于锁定上游镜像的内部实现；
- Databench 可以维护极小 downstream patch，用于固定 root path、读取当前 Studio Session、预填
  Dataset/output_dir 和显示 Databench 上下文，但不得借此替换或删减原生业务 callback；
- 上游锁、vendor archive、downstream patch 与 Gradio 兼容性 fixture 统一归属
  `third_party/ms-swift/`；Databench Python Provider 归属 `workers/swift-studio/`；Dockerfile、Compose、
  gateway 配置等部署资产归属 `deploy/swift-studio/`。三者不得混放；
- Gradio 页面“可见”与某项可选运行时依赖“已验证”分开记录。能力清单必须标明
  `surface-present`、`runtime-installed` 与 `runtime-validated`，不能把页面存在等同于所有 GPU/框架组合
  已过真实 gate。

### 2. 首期 Databench 只拥有四个桥接点

```text
Studio Session
Dataset exact export
GPU/目录运行边界
Model Artifact import
```

- Databench 选择并锁定 exact Dataset version，使用现有 `ms-swift@1.0.0` converter inspect/export；
- Studio Provider 把确定性 JSONL 放入当前 Session 的只读 input 目录，并把路径预填到原生 Dataset 字段；
- 原生 Gradio 在 GPU-enabled Studio 容器中自行启动和管理进程；
- Databench 只从当前 Session 的固定 output root 发现可导入产物；首个 importer 只承诺 LoRA Adapter；
- 导入后的 Model Artifact 使用 Databench immutable object、digest、manifest 和 lineage；
- 训练参数、任务状态、取消、Retry、Resume 和 GPU lease 首期仍由原生 Gradio/ms-swift 管理，不伪装成
  Databench Training Run。

### 3. 首期使用单实例、单活跃 Session 的 GPU Studio

- 部署一个固定版本、GPU-enabled 的 Swift Studio service；
- service 暴露 Gradio 数据面和一个仅供 Databench 使用的内部 Provider control API；
- 首期同一 Studio instance 同时只允许一个 active Databench Session；
- Studio 可以在一个 Session 内启动上游允许的多个任务，但 Databench 不声明这些任务彼此隔离或已纳入
  统一调度；真实 gate 使用单任务；
- GPU 在 Studio 运行期间由该实例占用。首期不实现 cluster scheduler、Worker lease、多租户配额或
  Kubernetes placement；
- 后续需要并发时，升级为“一 Session 一容器 + GPU allocator”，不改变 Dataset/Artifact 公共契约。

这项单活跃限制是运行正确性边界，不是通过隐藏 UI 实现。Provider 必须对第二个 active Session 返回
typed conflict。

### 4. Dataset 绑定只对受验证的导出成立

- 用户先在 Databench 外层页面选择 Ref 和 exact Dataset version；Ref 只用于显示，Session 永远绑定
  exact version；
- Workspace 重新执行 converter inspect，保存 converter/version/normalized options、fidelity digest、
  output count 与 config hints；
- `output_count=0` 不创建 ready Session；语义 fidelity loss 必须由现有 fidelity approval 流程确认；
- Studio Provider 从 Databench exact export 接口流式取得 `ms-swift.jsonl`，校验 bytes digest、size 和行数，
  再以 `.partial → fsync → rename` 写入 Session input；
- downstream patch 只负责把这个只读文件路径预填给 Gradio。用户仍可在原生 UI 中选择其他 Dataset；
- Artifact importer 只有在 ms-swift 输出元数据中的 Dataset 路径与当前 exact export 相符时，才把
  `dataset_lineage` 标记为 `verified`。其他情况必须标记为 `external_or_unverified`，不得错误继承
  Session 的 Dataset lineage。

### 5. Studio Session 不是 Training Run

首期新增 `swift_studio_sessions_v2`，只表达：

- 谁/哪个 namespace 打开了 Studio；
- 绑定的 exact Dataset export；
- Provider 与上游版本；
- `preparing → ready → closing → closed` 或 `failed` 的会话生命周期；
- 当前 input/output provider locator 与 retention 状态。

它不表达：

- 用户点击了几次训练；
- 每次训练使用的完整参数；
- 原生进程的 authoritative 状态；
- 自动重试、恢复或 cancel fence；
- GPU 使用计费。

若后续需要这些语义，必须在新 Step 中增加 immutable Training Run/Attempt 控制面，并逐个接管上游
callback；不得从 Session 表反推或伪造 Training Run。

### 6. iframe 与 Gateway 以兼容完整 Gradio 为目标

- 浏览器只访问 Databench 提供的 `/swift-studio/*` Gateway，不直接访问容器 `7860`；
- Gradio 固定 root path 为 `/swift-studio`；Gateway 必须支持 HTML、静态资源、Queue、SSE、WebSocket、
  upload/download 和上游所需的所有相对路径；
- 与 EvalScope 的 default-deny exact API gateway 不同，Swift Gateway 代理的是一个完整的锁定 Web App，
  因而按锁定 route manifest 做整应用兼容，不把它描述成有限 REST allowlist；
- iframe 使用 Databench 外层页面提供 Dataset/Session/Artifact 操作，Gradio 自己保留应用标题、Tab 和
  运行页面；
- `7860` 与内部 Provider control port 不发布为普通产品入口；
- `WEBUI_SHARE=false`，不创建 Gradio 公网分享链接。

owner 已明确首期是可信内部工具，不要求以多租户攻击模型收缩 UI。但 Gateway、固定版本、Session 边界、
请求容量和路径边界仍属于可运行性与数据正确性要求，不能省略。

### 7. Model Artifact 导入与原生输出目录分离

- 原生 ms-swift output 先落在 Session 本地持久化目录；它不是 Databench immutable Artifact；
- Provider 只列出当前 Session output root 下的相对候选，不接受浏览器提交绝对路径；
- S3 首个 importer 只接收 LoRA Adapter allowlist，至少要求 `adapter_config.json` 和 safetensors adapter；
- 原始 `args.json` 只作为提取来源，Databench 生成 sanitized manifest，不原样保存路径、token、env 或
  plugin 字段；
- importer 验证普通文件、realpath、symlink、size、count、文件类型和模型元数据；
- Provider 生成 deterministic archive，上传 attempt-scoped exact staging；Workspace 校验 digest/size，
  conditional create 最终 immutable object，再事务注册 `model_artifacts_v2`；
- 原生 checkpoint、optimizer、scheduler、RNG 与 `training_args.bin` 不进入首个 LoRA Artifact；
- merged/full/quantized model importer 后续按独立 kind、容量与验证规则加入，不因 UI 已可见而自动支持。

### 8. Deployment 与 EvalScope 是 Artifact 之后的独立阶段

- 原生 Infer/Deploy/Eval 页面首期保持可用，但其任务仍只属于 Swift Studio；
- Databench 完整 lineage 必须从已导入的 Model Artifact 开始；
- 首期 Deployment bridge 固定为 `registration_mode=operator_attested`：operator 注册已经独立运行且确认
  稳定的 OpenAI-compatible endpoint，并绑定一个 verified-base LoRA Artifact；Databench 不在 S4 自动
  启动、停止或调度 serving 进程；
- 首期 provider 只接受 `openai_compatible`，`auth_mode` 只接受 `none`。这是可信内部、单 operator MVP，
  不是未来 provider/auth 扩展的通用终态；
- 创建、健康检查和禁用属于 operator action，使用独立 Bearer；列表/详情只返回 public projection，隐藏
  endpoint 与 create digest；EvalScope 使用独立 service credential 调用不进入 OpenAPI 的 internal
  resolver；
- Deployment identity 绑定 namespace、Artifact、provider、display/served model、规范化 endpoint 和 auth
  mode。endpoint 或 served model 变化必须创建新 Deployment ID，不能原地改写；
- `status=active|disabled` 是生命周期，`health_status=unknown|healthy|unhealthy` 是最近一次 `/models`
  观察，两者独立。健康检查不自动 disable；disable 是 terminal admission fence，不删除历史 Deployment、
  Artifact、Evaluation Run 或 Report；
- EvalScope 浏览器 payload 只接收 Databench opaque Deployment ID，由服务端解析 endpoint/model。只有与
  Databench exact Dataset 同时使用时才创建 Deployment-bound Evaluation Run；与原生 Benchmark 组合是
  不创建 Databench Run 的 expert/untracked 模式；
- 只有走通下列链路后，才声明完整“数据 → 训练 → 部署 → 评测”闭环：

```text
Dataset Version
→ Swift Studio Session
→ Model Artifact
→ Model Deployment
→ Evaluation Run
→ Evaluation Report
```

直接在原生 Swift Eval Tab 中完成一次评测，不自动形成 Databench Evaluation Run lineage。

S4 当前只验收 non-GPU contract：operator-attested endpoint 可以由 fake/CPU OpenAI-compatible service
验证 `/models`、opaque resolve、Evaluation Run identity 和浏览器 lineage。真实 vLLM/transformers LoRA
serving、`/chat/completions` 质量 smoke 与 NVIDIA 证据继续 deferred；不得据此声明 GPU 训练或部署可用。

### 9. 后续产品化不反向破坏首期桥接契约

后续可以逐步增加：

- per-session container 与 GPU allocator；
- `training_runs_v2` / `training_attempts_v2`；
- SFT、DPO、GRPO 等版本化 TrainingProfile；
- Gradio callback → Databench Run 的逐页接管；
- 统一 progress、log、cancel、retry、resume；
- Managed Deployment 与自动 EvalScope。

Dataset exact binding、Session、Model Artifact 和 Deployment ID 继续保持稳定。未来 React 原生训练页也应
消费这些公共契约，而不是依赖 Gradio runtime config。

### 10. 本集成不改变既有发布声明

- 本 ADR 不完成 V16/V17，不解除公共云 D3 决策门；
- Swift Studio 默认 disabled，S0-S4 未过不得进入普通离线 bundle；
- 新增 NVIDIA/CUDA 镜像不会替换 ADR 0012 的 CPU-only Worker；GPU Studio 是独立可选 profile；
- 离线安装如需支持 Swift，必须预置 digest-pinned image、模型缓存和依赖，不得把联网下载模型的开发
  smoke 当作离线 gate；
- ADR 0017 只禁止把 EvalScope SPA 作为第二个用户可见应用嵌入。它不自动禁止本 ADR 对 ms-swift Gradio
  作出的独立 iframe 决策。

### 11. Owner 修订：GPU gate 后置，实施继续

owner 于 2026-07-28 明确要求“GPU 先跳过，后面再弄，先继续”。因此：

- S1 可以在 non-GPU 全仓、Provider、Gateway、浏览器、镜像兼容和 GPU gate 工具本身全绿后，
  以 `code-complete / gpu-deferred` 状态提交；
- S2-S4 可继续实施非 GPU 契约、数据、Session、Artifact、Deployment 和 EvalScope 桥接，
  不再以 GS1 的真实 NVIDIA 证据作为代码进入条件；
- 所有未执行的 LoRA、Stop、Adapter Infer、Deployment/Evaluation GPU 证据依然保持
  `deferred/unvalidated`，不得伪装为 green；
- `runtime.qwen-small-sft-lora` 和 `runtime.transformers-lora-infer` 保持
  `runtime_validated=false`，直到 candidate/final 在真实 Linux/NVIDIA 主机通过；
- runtime 仍 disabled-by-default。对外声明完整 Dataset → Training → Evaluation 闭环之前，
  必须补齐方案中所有 deferred GPU gates。

这是实施顺序修订，不是验收标准删除。

### 12. Owner 修订：离线 UI-only 模式

owner 于 2026-07-30 明确要求内网控制面“Swift 保持开启、能看到完整界面、但不训练”，且升级不检查
NVIDIA。因此离线部署把 Studio enabled 与 GPU runtime 分离：

- `DATABENCH_SWIFT_ENABLED=true` 只表示 Provider、完整 Gradio 和 Databench Gateway 已启用；
- `DATABENCH_SWIFT_RUNTIME_MODE=ui-only` 不申请 NVIDIA device，不执行 `nvidia-smi`、容器 CUDA 和
  模型预置检查；Provider `ready=true` 即可通过健康检查；
- UI-only 仍保留七个原生业务面和 callback，页面明确显示 GPU 不可用，不声明训练、推理或部署可用；
- `runtime_mode=gpu` 继续使用 NVIDIA Compose overlay、严格 `gpu_available=true` 健康检查、模型预置和
  安装期 CUDA 快检；
- 旧 `swift.env` 缺少 mode 时在新版本升级中迁移为 `ui-only`，启用状态和 Provider credential 不变；
- 非 GPU/UI-only 安装与升级默认资源门槛为 6 logical CPUs/15 GiB RAM；GPU mode 保留
  12 logical CPUs/40 GiB RAM。

该修订只改变离线运行 profile 和升级前置条件，不改变 Session、Dataset、Artifact、Deployment 或
EvalScope 契约，也不把 UI-only 误报为 GPU gate green。

## 非目标

- 首期复刻 ms-swift React UI；
- 首期修改或移除原生业务 Tab；
- 首期让 Databench 接管所有 ms-swift callback；
- 首期宣称所有模型、CUDA、vLLM、DeepSpeed、Megatron、量化和 RLHF 组合均已验证；
- 从 Gradio `/config` 自动生成 Databench 长期 wire contract；
- 把样本、完整训练日志或 checkpoint payload 写入 Postgres；
- 让 Swift Studio 直接连接 Databench Postgres 或持有对象存储长期凭据；
- 从不受控 output 路径自动扫描或删除文件；
- 用 Session 状态伪造 Training Run 状态；
- 在当前 EvalScope E8 未提交工作树中混入 Swift 实现。

## 后果

- **+** 首期不重写数百个字段和 callback，最快获得完整上游 UI；
- **+** 原生训练、推理、部署、导出、评测和采样入口完整保留；
- **+** Databench exact Dataset 与 immutable Model Artifact 形成稳定桥接，后续可以继续产品化；
- **+** Swift 和 EvalScope 使用不同、明确的 UI 集成策略，各自符合上游实现形态；
- **+** 基于已提交的 EvalScope E7 基线开发，能够直接建设 Artifact → Deployment → Evaluation 链路；
- **−** 首期 Databench 看不到 Gradio 内每个任务的权威状态和完整参数；
- **−** 单实例、单 active Session 会限制并发，并在 Studio 运行期间占用 GPU；
- **−** 完整原生 UI 继续带有独立视觉、导航和交互语义，iframe 体验不等同于 Databench 原生页面；
- **−** 上游升级必须同时验证 Gradio routes、字段预填 patch、输出布局和可选依赖；
- **−** 页面全部可见不等于全部运行组合已获 Databench 支持声明，必须维护能力矩阵；
- **−** 未经 Artifact import 的原生输出不具备 Databench immutable、lineage 和 EvalScope 闭环语义。
