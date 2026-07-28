# ms-swift 原生 Gradio Studio 集成状态

> 每个 S Step 完成后更新真实状态、提交与 gate。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- swift-status
current_step: S2
last_completed_step: S1-code-complete-gpu-deferred
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
- **当前 Step:** S2 exact Dataset 与单 Studio Session bridge
- **已完成:** ADR/技术方案/实施计划、S0，以及 S1 的
  image/Provider/Gateway/`/training`/浏览器代码与 non-GPU gate
- **产品状态:** `/training`、Swift Gateway 与 GPU image 已实现；Session、Dataset bridge、Artifact 开始按顺序实施
- **运行状态:** runtime 默认 disabled；生产镜像
  `sha256:09207c761906d5a2dae7e9a6dfd58fe963a6c3047cd9a2eb6f102632fc4d8108` 已通过完整本机 CPU
  compatibility、Gateway、浏览器和全仓 gate；真实 NVIDIA gate 按 owner 决策后置，
  capability 仍保持 unvalidated
- **首期模式:** 完整原生 Gradio；Databench 只桥接 Session、Dataset、workspace、Artifact
- **控制面状态:** 没有 Training Run/Attempt；原生任务仍由 ms-swift Gradio 管理
- **发布声明:** 不改变 V16/V17、公共云 D3、ADR 0012 或 EvalScope E8/E9

## Owner 决策

2026-07-28 owner 确认：

1. 首期不复刻 ms-swift React UI；
2. 直接嵌入完整原版 Gradio，保留全部上游页面和 callback；
3. 最小实施为原生 Studio + Databench Dataset Export + Session workspace + Model Artifact Import；
4. Training Run/Worker 接管放到真实使用后的后续阶段；
5. 从 EvalScope E7 已提交基线创建独立 Swift 分支，不基于缺少 Evaluation 产品面的原始 main，也不带入
   EvalScope E8 未提交文件；
6. 真实 NVIDIA gate 后置，S1 以 `code-complete / gpu-deferred` 收口并继续 S2-S4；
   deferred 不等于 green，最终闭环声明前必须补齐。

## Step 状态

| Step | 目标 | 状态 | Gate | 备注 |
|---|---|---|---|---|
| S0 | 上游、能力与兼容性基线 | ✅ | GS0 | digest-pinned image + 195-package hash lock |
| S1 | 完整原生 GPU Studio + iframe | 🟨 code complete | GS1 GPU deferred | 全七业务面；真实 LoRA + Infer 待补 |
| S2 | exact Dataset + 单 Session bridge | 🔄 当前 | GS2 non-GPU | Session API、预填、真实 Dataset |
| S3 | LoRA Model Artifact import | ⬜ | GS3 | deterministic archive、immutable finalize |
| S4 | Deployment + EvalScope 闭环 | ⬜ | GS4 | opaque Deployment ID、真实 lineage |
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
