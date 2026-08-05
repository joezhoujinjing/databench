# ms-swift 原生 Gradio Studio 集成状态

> 每个 S Step 完成后更新真实状态、提交与 gate。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- swift-status
current_step: S4-non-gpu-green-gpu-deferred
last_completed_step: S4-non-gpu-contract-green-gpu-deferred
runtime_enabled: false
runtime_implemented: true
ui_route_enabled: true
upstream_tag: v4.4.2
upstream_commit: f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d
integration_mode: native-full-gradio
-->

## 当前检查点

- **当前分支:** `feat/swift-studio-integration`
- **基线:** EvalScope E7 complete commit `25931d6`，不包含原工作树未提交的 E8 修改
- **当前 Step:** S4 non-GPU contract green；GPU 训练、推理部署与真实模型评测证据 deferred
- **已完成:** ADR/技术方案/实施计划、S0、S1 non-GPU runtime、S2 exact Dataset + 单 active Studio
  Session bridge，以及 S3 immutable LoRA Model Artifact import
- **产品状态:** `/training` 已具备 Dataset selector、fidelity review、Session create/poll/close、output
  discovery/import，以及独立于 ready Session 的 Artifact library/detail/download；Artifact detail 已增加
  operator-attested Deployment 注册、健康检查、禁用与 Evaluation lineage；`/evaluations/tasks` 已增加与
  Dataset source 独立的 opaque Databench Deployment model source
- **运行状态:** runtime 默认 disabled；S3 production image
  `sha256:57f2448c3e06985d1989465703f8e4883aee71da40b79be3bdfb70e6dda1f74d` 已通过本机 CPU
  compatibility、Provider、动态 Gradio prefill、真实 ms-swift output import 与 non-GPU gate；owner 再次确认
  GPU 全部后置，GPU 状态保持 deferred，capability 不标 GPU green
- **首期模式:** 完整原生 Gradio；Databench 桥接 Session、exact Dataset、workspace、immutable Artifact、
  operator-attested Deployment 与 Evaluation lineage
- **控制面状态:** 没有 Training Run/Attempt；原生任务仍由 ms-swift Gradio 管理
- **发布声明:** S4 没有自动改变 V16/V17；两者随后已分别通过 GV16/GV-final。公共云 D3、
  ADR 0012、EvalScope E8/E9 与 GPU gate 仍按各自状态记录
- **离线交付:** ADR 0012 通道已接入第八张、默认关闭的 Swift CUDA 镜像；显式
  `DATABENCH_ENABLE_SWIFT_STUDIO=true` 可启用 UI-only Studio，只有 `runtime_mode=gpu` 才叠加
  NVIDIA profile。API 使用当次 bundle 的真实 local image digest；Caddy、Provider/Gradio doctor、
  GPU mode NVIDIA 快检、旧五/六/七镜像回滚、原生任务 idle
  fence、Session workspace 备份/恢复和 EvalScope 私网 Deployment allowlist 均已接通。基础模型权重
  不进入 bundle，由 operator 预置到 `/srv/databench/swift-models`
- **UI-only 修订:** owner 于 2026-07-30 要求控制面保持 Studio 可见但不训练。离线配置新增
  `DATABENCH_SWIFT_RUNTIME_MODE=ui-only|gpu`；UI-only 保持 enabled、完整 Gradio/Gateway/Session，
  不申请或检查 NVIDIA，GPU mode 保留原 CUDA、模型预置与严格健康 gate。

## Owner 决策

2026-07-28 owner 确认：

1. 首期不复刻 ms-swift React UI；
2. 直接嵌入完整原版 Gradio，保留全部上游页面和 callback；
3. 最小实施为原生 Studio + Databench Dataset Export + Session workspace + Model Artifact Import；
4. Training Run/Worker 接管放到真实使用后的后续阶段；
5. 从 EvalScope E7 已提交基线创建独立 Swift 分支，不基于缺少 Evaluation 产品面的原始 main，也不带入
   EvalScope E8 未提交文件；
6. 真实 NVIDIA gate 后置，S1 以 `code-complete / gpu-deferred` 收口并继续 S2-S4；
   deferred 不等于 green，最终真实 GPU 闭环声明前必须补齐；
7. S4 先关闭 non-GPU contract，最终状态只写
   `S4 non-GPU contract green / GPU deferred`，不宣称 GPU training/inference/deployment 已验证。

## Step 状态

| Step | 目标 | 状态 | Gate | 备注 |
|---|---|---|---|---|
| S0 | 上游、能力与兼容性基线 | ✅ | GS0 | digest-pinned image + 195-package hash lock |
| S1 | 完整原生 GPU Studio + iframe | 🟨 code complete | GS1 GPU deferred | 全七业务面；真实 LoRA + Infer 待补 |
| S2 | exact Dataset + 单 Session bridge | ✅ non-GPU | GS2 GPU deferred | Session API、预填、真实 Dataset |
| S3 | LoRA Model Artifact import | ✅ non-GPU | GS3 GPU deferred | deterministic archive、immutable finalize |
| S4 | Deployment + EvalScope 闭环 | ✅ non-GPU | GS4 non-GPU green；GPU deferred | opaque ID、exact lineage |
| S5 | 多 Session/GPU allocator | ⬜ 后续 | 待 ADR | 不属于首期 |
| S6 | Training control plane | ⬜ 后续 | 待 ADR | Run/Attempt/Worker/callback 接管 |

## S0 交付

- [x] `third_party/ms-swift/upstream.lock`
- [x] `third_party/ms-swift/runtime-capabilities.json`
- [x] `third_party/ms-swift/gradio-routes.json`
- [x] `third_party/ms-swift/gradio-baseline.json`（config/component/dependency/callback baseline）
- [x] `third_party/ms-swift/patches/0001-databench-session-prefill.patch`
- [x] `third_party/ms-swift/patches/0002-python311-attrdict3-metadata.patch`
- [x] vendored archive、source manifest 与 license/notice
- [x] baseline checker 与 11 个负向 tests
- [x] Python/CUDA/Torch/Transformers/Gradio/image 组合锁定
- [x] GS0 gate 记录

目录所有权已固定：第三方输入在 `third_party/ms-swift/`；Python Provider 在
`workers/swift-studio/`；Dockerfile、Compose 与部署说明在 `deploy/swift-studio/`；API Gateway 与
Web 外层壳分别在 `apps/api`、`apps/web`。Provider、Gateway 或 patch 源码不进入 `deploy/`。

## S1 当前进度

- [x] digest-pinned Linux/amd64 CUDA image 与 non-root launcher
- [x] 完整原生 Gradio + Provider health/runtime
- [x] `/swift-studio/*` HTTP/Queue/SSE/WebSocket/upload/download Gateway
- [x] HTTP/WS concurrency、byte、path 与 timeout 边界
- [x] `/training` lazy route、loading/error/reconnect/fullscreen 与真实 boot handshake
- [x] 七个原生顶级业务面浏览器 smoke、direct refresh 与正常场景 console gate
- [x] Python Provider root script 与 CI job
- [x] 195-package `pip check`/core imports、exact capability digest 与 callback wiring fail-closed gate
- [x] 本机非 GPU 全仓、真实 Postgres/MinIO、Gateway 与浏览器最终回归
- [x] `scripts/` 可移植 GS1 runner、固定 32 条 JSONL、结构化 evidence checker（22 cases）、runner/driver tests
- [x] candidate/final 两阶段 GPU proof；`S1-in-progress` candidate 不能关闭 GS1
- [x] native process exit/stop、host-PID-bound GPU context/显存释放、exact container cleanup 和
  runner/driver/checker provenance gate
- [ ] Linux/NVIDIA LoRA 2～5 steps + stop + Adapter Infer
- [x] S1 non-GPU 全仓、真实 Postgres/MinIO、Provider、Gateway 与浏览器 gate

当前证据见 [S1-GPU-STUDIO.md](evidence/S1-GPU-STUDIO.md)。GPU 项未完成，所以 GS1 不标绿；
owner 已明确允许以 code-complete/gpu-deferred 状态进入 S2。

## S2 交付与 Gate

- [x] Session create/get/list/close Schema、REST、OpenAPI 与 generated Web client
- [x] `swift-studio-session-create-v1` RFC 8785 + BLAKE3 identity fixed vector
- [x] `swift_studio_sessions_v2` additive migration、exact Dataset/namespace FK 与数据库级单 active Session
- [x] Catalog repository、五态 lifecycle、create replay 与 typed conflict
- [x] preparation owner token + 5h lease fencing；只有当前 owner/recovery 可 CAS 写入 `ready/failed`
- [x] 导出测量先于 admission；ambiguous create、caller abort、不同 digest admission 与终态 response loss
  均通过 read-back/retry 收敛
- [x] recovery 使用 PostgreSQL 时钟 claim；Provider exact export 会重新测量 digest/bytes/count，mismatch
  必须完成 exact cleanup 后才释放 singleton
- [x] Workspace exact Dataset resolution、`ms-swift@1.0.0` inspect/fidelity/output-count admission
- [x] 双遍 deterministic export measurement 与 Provider exact materialization
- [x] Provider BLAKE3/bytes/LF count/content-type 验证、partial/fsync/rename、restart recovery 与 exact cleanup
- [x] `/training` Dataset selector、exact version 锁定、fidelity review、Session poll/close 与 ready iframe gate
- [x] 原生 Train、RLHF、GRPO 页面通过动态 load callback 实时预填 Dataset/output/logging
- [x] runtime capability `integration.session-context` 已按实际 CPU smoke 标记为
  installed/validated/green；GPU runtime capability 保持 planned/unvalidated
- [x] 完整七业务面与全部原生字段/callback 保留；Gradio graph 为 1,006 components / 118 dependencies
- [x] S2 Linux/amd64 image、patch、capability manifest 与 Provider dependency 全部 digest/hash locked
- [x] Provider 45 tests、Catalog 43 tests、真实 Postgres/MinIO Workspace 174 tests、真实 API 114
  tests、真实 Store 85 tests、Web、OpenAPI 与 non-GPU 全仓 gate
- [ ] 真实 Databench Dataset 的 Linux/NVIDIA LoRA + Infer（owner 后置，deferred）

S2 CPU smoke 同时验证了无 Session 空态、exact Session 动态预填、close/cleanup 后恢复空态。该结果只关闭
GS2 non-GPU gate，不将任何 GPU 训练或推理能力标记为 green。

## S3 交付与 Gate

- [x] output candidate、Artifact import、immutable Model Artifact、lineage/base-model binding Schema 与
  `swift-model-artifact-import-v1` RFC 8785 + BLAKE3 fixed vector
- [x] additive migration `0012_model_artifacts_v2`；durable import 状态机、同 archive 多 provenance row、
  immutable Artifact 与 Session retention 分离
- [x] bounded output discovery，只返回绑定 Session/generation/snapshot 的 opaque handle，不返回原生路径
- [x] strict LoRA allowlist/denylist、realpath/type/size/symlink 检查，以及真实 PEFT 0.19.1
  `adapter_config.json`、`additional_config.json` 与完整 ms-swift v4.4.2 checkpoint fixture
- [x] safetensors header/range/dtype/shape/连续覆盖验证，以及 sharded index tensor-to-shard exact mapping
  与 `total_size` 校验
- [x] deterministic tar.zst、Linux golden
  `7509051c2def2efcfedfeb81b284c78fa22a6d0e63d25b9586b8618e6f9100a7`
- [x] exact signed staging PUT、Workspace digest/size/manifest read-back、conditional immutable finalize、
  concurrent finalizer/read-back 收敛与 terminal exact cleanup retry
- [x] exact Dataset export digest/bytes/count 重新测量；只有完全一致才登记 verified lineage
- [x] REST/OpenAPI/generated client；Web output discovery/import polling、Artifact library/detail 与
  authenticated streaming download（Blob fallback 上限 256 MiB）
- [x] Session close 后 Artifact 仍可列出、查看和下载；真实 MinIO lifecycle 已覆盖
  Dataset → Session → staging PUT → immutable publish → cleanup retry → download → Session close
- [x] 最终 Linux/amd64 image
  `sha256:57f2448c3e06985d1989465703f8e4883aee71da40b79be3bdfb70e6dda1f74d` 内 synthetic
  full-checkpoint importer smoke；归档只包含 adapter config/model/additional config
- [x] Provider 77 tests、Schema 225 tests、Catalog 46 tests、API 111 tests（4 skipped）、Web 153 tests、
  真实 Postgres/MinIO Workspace 175 tests（10 skipped），以及 build/test/lint/typecheck/OpenAPI/status/peer/
  offline/baseline gates
- [ ] 全新目录 explicit base + adapter GPU Infer（owner 后置，deferred）

S3 关闭的是“Dataset → Studio Session → immutable LoRA Model Artifact”的 non-GPU 数据与产物闭环。
它不证明 GPU 训练/推理，不创建 Databench Training Run，也不构成 Artifact → Deployment → EvalScope
评测闭环；后者从 S4 开始。

当前可信单操作者内网 MVP 的明确后置项：后台 import scanner/reconciler、Session input/output retention
scheduler、Artifact runtime 与 Swift Provider config 完全解耦，以及多用户 Gateway access gate。当前 import
会由 create/get REST 和 UI polling 持久化推进并在重试时收敛；这些后置项不得被描述为已完成。

## S4 non-GPU 交付与 Gate

- [x] `model_deployment_create_v1` RFC 8785/BLAKE3 identity、`model_deployments_v2` additive migration、
  namespace + Artifact composite FK 与 exact endpoint-change/new-ID 语义
- [x] 首个 profile 固定为 `openai_compatible + operator_attested + auth_mode=none`；只准入 verified-base
  LoRA Artifact
- [x] public projection 隐藏 endpoint/create digest；operator Bearer 保护 create/check/disable；service
  credential 独占 internal resolve，且 internal route 不进入 OpenAPI
- [x] operator/service token unset、wrong、cross-role、same-value fail-closed，以及 query smuggling、credential
  text、URL normalization 和 public non-leak tests
- [x] lifecycle `active|disabled` 与 health `unknown|healthy|unhealthy` 分离；有界 `/models` probe 不自动
  disable；endpoint/served model 变化创建新 Deployment ID
- [x] `evaluation-run-create-v2` 将 exact Dataset、Deployment、Artifact、Deployment digest 加入 canonical
  identity，并以跨 namespace composite FK 固定 lineage
- [x] disable 后新 Evaluation Run 返回稳定 422 `model_deployment_disabled`；已有 Run 与 terminal replay
  保留；replay 不依赖当前 disk capacity、endpoint 或 Deployment live state
- [x] EvalScope 只从固定 Databench internal resolver 取得 endpoint/model；integration manifest、公开
  response、report/log 不保存或泄漏 resolved endpoint
- [x] Evaluation 表单把 Dataset source 与 Model source 分开；浏览器 Deployment payload 只有 opaque ID，
  明确无 `model/api_url/api_key`
- [x] Artifact detail 支持 Deployment 注册/list/check/disable，并显示 Deployment-bound Run 的 exact Dataset、
  Artifact、EvalScope task/report lineage
- [x] 明确 `Databench Deployment + Benchmark` 是 source-less expert/untracked 模式；只有
  `Databench Dataset + Databench Deployment` 创建完整 Databench Evaluation Run
- [x] 真实 Postgres/MinIO lifecycle 覆盖 Artifact → Deployment → `/models` health → Deployment-bound
  Evaluation Run → list by Deployment；浏览器完成 exact Dataset + opaque Deployment → report request-body
  evidence，console 0 error/0 warning；分类证据与真实命令见
  [`evidence/S4-NON-GPU-CONTRACT.md`](evidence/S4-NON-GPU-CONTRACT.md)
- [ ] 真实 vLLM/transformers LoRA `/chat/completions` 与 NVIDIA serving（owner 后置，deferred）
- [ ] 真实 Dataset → GPU SFT/LoRA → Adapter Infer → Deployment → Evaluation（owner 后置，deferred）

S4 当前结论固定为：

```text
S4 non-GPU contract green / GPU deferred
```

它证明 Dataset/Session/Artifact/Deployment/Evaluation 的数据契约、服务端解析与 lineage 已接通；不证明
GPU 训练、GPU 推理部署、真实模型输出质量或完整 Training Run 控制面。

## 离线八镜像 non-GPU Gate

2026-07-29 在无 NVIDIA 的 Apple Silicon 构建机完成离线接线复验：

- bundle builder 构建并保存 API/Web/CPU Worker/EvalScope/Swift/PostgreSQL/MinIO/MinIO Client
  八张 `linux/amd64` 镜像，Swift 镜像执行 CPU import、Provider ready 和完整 Gradio ready smoke；
- 普通安装默认不启动 Swift；GPU 机显式启用时只做 `nvidia-smi` 与容器内 Torch CUDA 快检；
- 生命周期顺序为 Worker → optional Swift → API → EvalScope → Web；维护在原生
  train/infer/deploy 活跃时 fail closed；
- 备份包含 Swift Session workspace 与加密 `swift.env`，排除模型 cache/home 和 operator 预置模型；
- `pnpm lint/build/typecheck/test/openapi/status/peer/offline`、真实 Postgres/MinIO、
  Swift Provider/baseline/GPU gate 工具测试和 EvalScope parity/Python 全绿。

该 gate 证明离线发布代码与 non-GPU runtime 可启动，不替代内网机上的真实 NVIDIA LoRA、Infer、
serving 和 Evaluation 证据。实际 release archive 必须继续由干净 `main` 的
`deploy/offline/build-bundle.sh` 生成并使用其 `RELEASE.txt`、`images.lock` 与双层 SHA-256。

2026-07-29 对当前提交完成 S0–S4 非 GPU 完成性复验，并修复 GPU evidence fixture 与 S2 capability
manifest 两处真源漂移；最终 Linux/amd64 image、真实依赖与所有专项 gate 记录见
[`evidence/S0-S4-NON-GPU-COMPLETION-AUDIT.md`](evidence/S0-S4-NON-GPU-COMPLETION-AUDIT.md)。

## GS0 Gate 记录

- upstream：`v4.4.2` / commit `f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d` /
  tree `833d2e1e3ab871a3dc419e46afe79584d1caa45a`；
- archive：16,517,100 bytes，SHA-256
  `60eeb1a53a089306166899951950e195144dc025002ffeffa700067be2787d48`；
- base image：`pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime`，Linux/amd64 manifest SHA-256
  `417bd75df6365104c283ea4c1651fb3530d9eb5a4c2fafa51943cff2a94e6385`；
- dependency lock：Python 3.11 / 195 packages / hashes，SHA-256
  `4ed9ea77fc7228a758a2cd077b65e3ea0b5a6dfe7bb0cedb2ef78b85618655ba`；
- Gradio baseline：1,005 components / 115 callbacks / 76 routes / 七个完整顶级业务面；
- `pnpm swift:baseline:check:green` 与当前 11 个负向 fixture tests 通过；
- 全仓 gate 见 S0 提交。

## 已知基线证据

- 本地参考 checkout：`/Users/hanlu/Desktop/ms-swift-v4.4.2`，只读研究使用；
- tag：`v4.4.2`；
- commit：`f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d`；
- 上游 License：Apache-2.0；
- 上游 `swift/ui/app.py` 注册七个顶级业务面；
- 上游 README 推荐 Gradio 5.32.1，framework requirement 为 `gradio>=3.40.0,<6.0`；
- Databench 已有 `ms-swift` converter version `1.0.0`，输出 `messages` + deterministic JSON-string
  `tools`，minimum ms-swift `4.2.0`。

这些 upstream 证据已由 GS0 checker 固定；它们不等于 GS1 的镜像构建、Gradio 启动或真实 GPU gate。

## 首个真实 GPU Gate 目标

```text
Linux + NVIDIA
pinned Swift Studio image
Qwen/Qwen3-0.6B 或 Qwen/Qwen2.5-0.5B-Instruct
固定 32 条本地兼容 SFT JSONL（S2 才改用 exact Databench export）
LoRA rank 8
max steps 2～5
max length 128
```

S1 最终证据必须登记：

```text
GPU 型号/driver/CUDA
image digest
ms-swift/Gradio/Torch/Transformers versions
base model exact revision
fixture digest/bytes/count
LoRA 参数/steps/finite loss/adapter file digests
最终 step loss + native process exit_code=0
原生 Runtime log + stop callback 结果
原生 Adapter Infer 非空结果 digest
idle/峰值/Stop/Infer 后显存与 gate compute process 释放
exact container removal 与 runner/driver/checker digests
candidate/final proof stage
```

S2 再登记 Dataset version/export digest/count 与 Studio Session id；S3 登记 immutable Artifact archive
digest/size；S4 登记 Deployment id 与 Evaluation Run/report id。后续 Step 的字段不能反向成为 GS1 gate。

## 不得误报

- 完整 UI 已显示 ≠ 所有上游功能已安装或验证；
- Studio ready ≠ 训练 running/completed；
- Session 绑定 Dataset ≠ 每个原生任务都使用该 Dataset；
- output 目录存在 ≠ Model Artifact 已发布；
- 原生 Swift Deploy ≠ Databench Deployment；
- 原生 Swift Eval ≠ Databench Evaluation Run；
- S4 完成 ≠ V16/V17 或公共云 production readiness 完成。
