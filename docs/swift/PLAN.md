# ms-swift 原生 Gradio Studio 集成实施计划

- **状态:** Accepted
- **日期:** 2026-07-28
- **决策:** [ADR 0018](../decisions/0018-ms-swift-native-gradio-studio.md)
- **技术方案:** [TECHNICAL-DESIGN.md](TECHNICAL-DESIGN.md)
- **状态真源:** [STATUS.md](STATUS.md)
- **基线分支:** `feat/evalscope-integration-design@25931d6`（EvalScope E7 complete）
- **实施分支:** `feat/swift-studio-integration`

## 实施原则

1. 一个 accepted Step 一个 PR/commit；owner 于 2026-07-28 明确后置真实 GPU gate，因此
   S1-S4 的 non-GPU gate 全绿即可继续，deferred GPU gate 仍是最终闭环必要条件；
2. 首期完整保留原版 ms-swift Gradio UI，不以 React 复刻或 SFT-only 页面替代；
3. 首期只桥接 Session、Dataset、workspace 和 Artifact，不伪造 Training Run；
4. Databench 公共 REST 只经 Workspace + Schema，Web 对 `/v2/*` 只使用 generated OpenAPI
   client；S1 的非公共 Provider runtime 状态仅通过隔离、锁定的 Zod adapter 读取；
5. Dataset payload 不进 Postgres，Model Artifact immutable + conditional create；
6. 页面存在与运行能力验证分开，所有支持声明来自 runtime capability manifest；
7. Swift 实现不混入 EvalScope E8 未提交工作树；后续需要 E8/E9 时显式 merge/rebase；
8. 每个运行时 Step 保持 disabled-by-default，真实 GPU gate 通过后才扩大启用范围。

## Step 概览

| Step | 目标 | 首要交付 | 进入条件 |
|---|---|---|---|
| S0 | 上游与兼容性基线 | lock、manifest、fixtures、license、patch baseline | ADR/方案 accepted |
| S1 | 本地完整 GPU Studio | pinned image、完整 Gradio、Gateway/iframe、真实 LoRA | S0 green |
| S2 | Dataset + Session bridge | exact export、Session 表/API、预填 patch、单 active conflict | S1 code-complete；GPU deferred |
| S3 | LoRA Artifact import | output discovery、deterministic archive、immutable Artifact | S2 non-GPU green |
| S4 | Deployment + EvalScope | Artifact deployment、opaque ID、真实 Evaluation lineage | S3 non-GPU green |
| S5 | 多 Session/GPU | per-session runtime、allocator、quota、retention | S4 green + owner demand |
| S6 | Training control plane | Run/Attempt/Profile、callback 接管、Worker lease | S4 green + separate owner decision |

S0-S4 构成当前 accepted 主计划。S5/S6 是保留扩展点，不属于首期完成声明。

GPU 后置只改变实施顺序：每个 Step 的 GPU 项标记 deferred，非 GPU 契约与真实
Postgres/MinIO/Provider/浏览器 gate 仍必须通过。未补齐 deferred 项前不声明完整闭环。

2026-07-28 implementation checkpoint：S3 non-GPU gate 已关闭，output discovery、真实 ms-swift/PEFT LoRA
布局、safetensors 结构、deterministic tar.zst、signed staging、conditional immutable publication、Artifact
REST/Web/download 与 Session-independent retention 已验证。GPU gate 按 owner 决策继续 deferred。当前按
accepted 顺序进入 S4，不在 S4 提前引入 Training Run/Attempt 或 GPU allocator。

S4 owner checkpoint：GPU 训练、adapter inference 与 GPU serving 全部后置。S4 先关闭
`operator_attested + openai_compatible + auth_mode=none` 的 non-GPU registry/resolve/lineage 契约；最终状态
只允许写为 `S4 non-GPU contract green / GPU deferred`。

## S0 — 上游、能力与兼容性基线

### 目标

把上游版本、完整 UI 范围、依赖组合、route/config/callback 和 downstream patch 边界固定下来，避免“打开
了全部 Tab”被误写成“所有训练组合已验证”。

### 交付

- `third_party/ms-swift/upstream.lock`：
  - `modelscope/ms-swift@v4.4.2`；
  - commit `f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d`；
  - source tree/archive digest；
  - Apache-2.0 license digest；
  - Python/CUDA/Torch/Transformers/Gradio/base image lock；
- `third_party/ms-swift/runtime-capabilities.json`：
  - 七个顶级 UI surface；
  - 每项 optional dependencies；
  - `surface-present/runtime-installed/runtime-validated` 三态；
- `third_party/ms-swift/gradio-routes.json`：
  - method/path/stream type；
  - Queue/SSE/WebSocket/upload/download 分类；
- Gradio `/config` component/dependency/callback baseline fixture；
- `third_party/ms-swift/` 下的 upstream source/license/patch manifest；
- `THIRD_PARTY_NOTICES.md` 增加适用 notice；
- downstream patch 骨架，仅允许 root path、Session context、Dataset/output prefill、banner；
- scripts：lock/check/manifest drift gate；
- docs 中记录 image profile 与未验证能力。

### Gate GS0

- tag/commit/tree/archive/license digest 全部一致；
- 七个顶级业务面在 component/capability manifest 中一一对应；
- upstream source ↔ patch ↔ capability backlink 完整；
- route/config/callback fixture 可重复生成且无 drift；
- patch dry-run clean apply；
- runtime capability 不允许 `runtime-validated=true` 且没有 evidence；
- `pnpm swift:baseline:check` 与负向 fixture tests；
- `git diff --check`、Markdown links/fences/status checks。

### 不包含

- 构建 GPU image；
- 新增 Web route/API/DB；
- 启动 Gradio；
- 宣称任何训练能力已验证。

## S1 — 完整原生 GPU Studio 与 iframe

### 目标

在本地 Linux/NVIDIA 环境跑起锁定镜像，在 Databench `/training` 内完整显示原生 Gradio，并用原生
callback 完成一次小模型 LoRA + Infer。

### 交付

- `deploy/swift-studio/Dockerfile` 与 deployment-only 资产；
- Linux exact dependency lock（若为第三方构建输入则位于 `third_party/ms-swift/`）；
- Swift Studio runtime：
  - Gradio `:7860`；
  - Provider health/runtime `:7861`，此 Step 只提供只读 runtime 信息；
- root path `/swift-studio` downstream patch；
- local Compose optional profile `swift-gpu`；
- `/swift-studio/*` streaming/WS reverse proxy；
- `apps/web/src/training/` lazy route 与主导航；
- capability/unavailable boundary；
- iframe loading/error/reconnect/fullscreen shell；
- 完整七业务面浏览器 evidence；
- `Qwen/Qwen3-0.6B` 或 `Qwen/Qwen2.5-0.5B-Instruct` 原生 LoRA + Infer smoke；
- `scripts/run-swift-s1-gpu-gate.mjs` 可移植 Linux/NVIDIA runner、固定 JSONL fixture、原生 callback
  driver、结构化 evidence 与 fail-closed checker；
- disabled-by-default config。

### Gate GS1

- image source/base/dependencies/patch 与 S0 lock 一致；
- `WEBUI_SHARE=false`；7860/7861 不直接发布为产品端口；
- `/training` direct refresh、iframe root path、静态资源、Queue、SSE、WS、upload/download smoke；
- 浏览器确认七个顶级业务面全部存在，无被隐藏或删除的原生 callback；
- 真实 GPU：32～100 条本地兼容 JSONL，LoRA rank 8、2～5 steps 完成；
- 先在 `S1-in-progress` 镜像上产生 candidate proof，再更新 capability/lock、重建最终镜像并产生
  final proof；candidate 不能关闭 GS1；
- native 训练子进程必须真实 exit `0`；Stop/Infer 后 exact process tree、GPU compute context 和显存必须
  释放；GPU 容器必须经 `rm` 与 post-remove inspect 双重确认不存在；
- gate-only 容器使用 host PID namespace，使 NVML/`nvidia-smi` 的 host PID 能与 exact native
  process tree 交叉验证；这个扩大只用于验收容器，不进入 Studio 产品部署；
- 原生 Runtime 展示日志并能停止单独的长任务；
- 原生 Infer 加载 Adapter 成功；
- unavailable GPU/provider 时 Databench 页面稳定降级；
- Web bundle 不静态打入 Gradio/ms-swift source；
- Python tests、image lock check、全仓 lint/build/typecheck/test/openapi/status/peer/offline；
- 浏览器 console 0 unexpected error/warning。

### 不包含

- Databench Dataset selector/export；
- Session DB/API；
- Model Artifact；
- 多用户/多 GPU；
- Databench 任务状态。

## S2 — exact Dataset 与单 Session bridge

### 目标

让用户在 Databench 选择 exact Dataset，创建一个可审计的 Swift Studio Session，并在完整原生 UI 中预填
Dataset/output/logging path。

### 交付

- `@databench/schema`：
  - Swift Session create/view/list/close；
  - state/conflict/error contracts；
- `@databench/hashing`：Session create domain/profile/fixed vector；
- Prisma additive migration `swift_studio_sessions_v2`；
- Catalog Session repository；
- Workspace：
  - exact Ref/version resolution；
  - `ms-swift@1.0.0` inspect/fidelity approval；
  - output_count admission；
  - create replay/single active conflict；
  - Provider client；
- Provider：
  - exact Dataset export download；
  - digest/size/count verification；
  - partial/fsync/rename；
  - Session manifest与 exact cleanup；
- downstream prefill patch；
- REST/OpenAPI/generated Web client；
- `/training` Dataset selector、fidelity review、Session status/close；
- input/output retention config and operator view；
- Session metrics/log correlation。

### Gate GS2

- create identity fixed vector 与 permutation/replay tests；
- 真实 Postgres migration、FK/check/unique/active conflict；
- 真实 MinIO/OSS adapter-compatible exact export；
- Ref 移动后 Session 仍绑定原 exact version；
- inspect → export 精确匹配 converter/version/options/fidelity/output count；
- `output_count=0` 拒绝；semantic fidelity 未确认拒绝；
- Provider 下载中断不暴露 partial input；callback 丢失可 reconcile；
- duplicate create 只返回一个 logical Session；第二个不同 active Session 409；
- iframe Dataset/output/logging 预填正确；原生其他 Dataset 选择仍保留；
- 真实 Databench Dataset 完成小模型 LoRA + Infer；
- close/cleanup 只使用 exact Session locator，活动任务时不误删；
- OpenAPI generated client 无 drift；
- 全仓 gates + Provider tests + 真实依赖 + 浏览器 + GPU gate。

上述两个 GPU 项按 owner 修订后置；S2 代码提交仍要求 exact Dataset materialization、
prefill、singleton conflict 与所有 non-GPU gate 真实通过。

### 不包含

- 导入 Model Artifact；
- Training Run/Attempt；
- 记录原生任务完整参数和进度；
- per-user container。

## S3 — LoRA Model Artifact import

### 目标

把当前 Session output root 中的一个 LoRA Adapter 导入为可下载、可验证、不可变的 Databench Model
Artifact。

### 交付

- `@databench/schema`：
  - output candidate/handle；
  - Artifact import create/view/state；
  - Model Artifact list/view；
  - kind/format/lineage/base-model binding；
- Prisma additive migration：
  - `model_artifact_imports_v2`；
  - `model_artifacts_v2`；
- Provider：
  - bounded output discovery；
  - opaque snapshot handle；
  - LoRA file allowlist/denylist；
  - symlink/realpath/type/size checks；
  - args/config sanitize；
  - deterministic tar.zst；
  - exact staging upload/terminal manifest/replay；
- Store：
  - model artifact key/conditional create；
  - exact import staging；
  - digest/size reader；
- Workspace finalizer：
  - staging verify；
  - immutable create；
  - Catalog transaction；
  - exact cleanup；
- `/training` Artifact import drawer/status；
- Model Artifact detail/download/lineage；
- Linux deterministic archive golden；
- explicit base + adapter clean-directory infer script。

### Gate GS3

- output discovery 不返回绝对路径，handle 与 Session/generation/snapshot 绑定；
- traversal、symlink、device、socket、oversize、unknown file、pickle、raw args 泄漏负向 tests；
- Dataset path 完全匹配时为 `verified`，改变/增加 Dataset 时为 `external_or_unverified`；
- adapter config/base-model 提取与用户确认一致；
- 两次归档产生完全相同 tar.zst bytes；
- staging exact key + short-lived PUT，Provider 无长期 Store credential；
- conditional create race 不覆盖；
- finalize response-loss 幂等 replay；
- Session output 删除不影响 immutable Artifact；
- 全新目录下载，explicit base + adapter + `load_args=false` Infer 成功；
- 样本、token、绝对路径、完整日志不进 Postgres/manifest；
- 真实 Postgres/MinIO/浏览器/GPU 与全仓 gates。

### 不包含

- optimizer/resume checkpoint；
- merged/full/quantized importer；
- 自动部署；
- 删除原生 output。

## S4 — Model Deployment 与 EvalScope 闭环

### 目标

让已导入 Artifact 获得稳定 Deployment ID，并由现有 EvalScope 产品面完成真实评测与 lineage。

### 交付

- ADR 0017/0018 与 Swift/EvalScope technical design 固定 Deployment contract；
- `model_deployments_v2`、`model-deployment-create-v1` identity 与 additive migration；
- verified-base LoRA Artifact deployability validation 与跨 namespace composite FK；
- 首个 provider 固定为 operator-confirmed OpenAI-compatible endpoint，
  `registration_mode=operator_attested`、`auth_mode=none`；
- public projection 隐藏 endpoint/create digest，operator Bearer 保护 create/check/disable，service credential
  独占 internal resolve；
- endpoint/served model 变化创建新 Deployment ID；disable terminal、health 与 lifecycle 独立；
- 浏览器只使用 opaque Deployment ID；EvalScope 服务端 resolve endpoint/model；
- Evaluation model selector 支持 Manual endpoint 与 Databench Deployment，且与 Dataset source 独立；
- `evaluation-run-create-v2` 绑定 Deployment/Artifact/digest 与 exact Dataset；
- Artifact → Deployment → Evaluation lineage UI；
- terminal replay 不依赖当前磁盘、endpoint 或 Deployment live state；disable 后新 Run 返回稳定 typed
  admission error；
- 真实 vLLM/transformers deployment smoke 保持 GPU-deferred。

### Gate GS4 non-GPU

- LoRA Deployment 显式绑定 base model + adapter；
- endpoint 只由服务端/Provider 解析，浏览器不能用 Deployment ID 注入任意 URL；
- operator/service role separation、unset/wrong/cross-role credential、public non-leak、internal non-OpenAPI、
  query smuggling 与 endpoint normalization tests；
- fake/CPU OpenAI-compatible `/models` health probe；
- 同一 Deployment 的 EvalScope exact Databench Dataset evaluation contract 完成；
- Evaluation Report 可追溯 exact Dataset、Artifact、Deployment；
- Studio Session 关闭后 registered Deployment 的定义与状态仍正确；
- endpoint 不健康、disable、EvalScope callback loss/replay 均有确定状态；
- 浏览器证据验证 Deployment + exact Dataset → completed report，并捕获 invoke body 只有 opaque
  Deployment ID、无 `model/api_url/api_key`；
- 真实 Postgres/MinIO lifecycle 与全仓、Provider、浏览器、OpenAPI/parity/offline 边界 gates。

### Deferred GPU Gate

- 真实 vLLM/transformers LoRA serving；
- OpenAI `/chat/completions` smoke 与模型输出可用性；
- 真实 Dataset → native SFT/LoRA → immutable Artifact → Deployment → Evaluation → Report；
- Linux/NVIDIA、driver/CUDA、显存与 stop/cleanup 证据。

### S4 完成声明

GS4 non-GPU 通过后只可以声明：

```text
S4 non-GPU contract green / GPU deferred。
Databench 已具备可信内部模式的 Dataset/Session/Artifact/Deployment/Evaluation lineage 契约，
浏览器只使用 opaque Deployment ID。
```

不能声明：

- GPU 训练、GPU 推理部署或真实模型输出已经验证；
- 真实 Dataset → GPU Training → Evaluation 全链路已经 green；
- Databench 已接管全部训练任务；
- 多用户训练平台 production ready；
- Swift 所有可选能力已验证；
- V16/V17 已完成。

## S5 — 多 Session、容器与 GPU allocator（后续）

### 触发条件

- 需要两个以上并发用户；
- Studio idle 占卡不可接受；
- 需要 GPU 配额/排队；
- 需要不同 CUDA/dependency image profile。

### 方向

```text
Session request
→ resource allocator
→ per-session container/pod
→ dynamic Gateway routing
→ idle/close cleanup
```

保持 S2/S3 public API，扩展 Provider driver。需要独立 ADR 决定 Docker/Kubernetes/云平台，公共云仍受 D3。

## S6 — Databench Training Control Plane（后续）

### 触发条件

- 需要统一 Run 状态、进度、取消、Retry/Resume；
- 需要自动训练流水线；
- 需要精确资源计费与审计；
- 需要从 Dataset 一键训练而不进入原生 Studio。

### 方向

- versioned TrainingProfile；
- immutable Training Run + Attempt；
- 复用内部 gRPC WorkerService；
- DB-clock lease/heartbeat/token fence；
- strict argv compiler；
- exact cancel/reconcile/drain fence；
- 自动 Model Artifact finalization；
- 逐个替换已经纳管的 Gradio callback；
- 原生 Studio 保留为 Expert Mode。

S6 不回填或篡改历史 Studio Session，使“原生工具任务”和“Databench 管理任务”始终可区分。

## 统一 Gate

所有代码 Step：

```bash
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

按 Step 增加：

- Python lock check/tests；
- image lock/build/smoke；
- 真实 Postgres/MinIO；
- 真实 Linux/NVIDIA GPU；
- 浏览器 direct refresh/iframe/console；
- deterministic bytes/fixed vectors；
- restart/replay/cleanup/容量 negative tests。

`STATUS.md` 必须记录真实命令、环境、image digest、GPU、模型 revision、Dataset version、Artifact digest、
Deployment ID 和 Evaluation Run；不能只写“本地验证通过”。
