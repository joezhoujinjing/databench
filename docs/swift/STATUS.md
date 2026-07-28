# ms-swift 原生 Gradio Studio 集成状态

> 每个 S Step 完成后更新真实状态、提交与 gate。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- swift-status
current_step: S1
last_completed_step: S0
runtime_enabled: false
ui_route_enabled: false
upstream_tag: v4.4.2
upstream_commit: f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d
integration_mode: native-full-gradio
-->

## 当前检查点

- **当前分支:** `feat/swift-studio-integration`
- **基线:** EvalScope E7 complete commit `25931d6`，不包含原工作树未提交的 E8 修改
- **当前 Step:** S1 完整原生 GPU Studio 与 iframe
- **已完成:** ADR/技术方案/实施计划，以及 S0 上游、能力与兼容性基线
- **产品状态:** `/training`、Swift Gateway、GPU image、Session、Artifact 均未实现
- **运行状态:** disabled；尚未在本分支启动 ms-swift
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
   EvalScope E8 未提交文件。

## Step 状态

| Step | 目标 | 状态 | Gate | 备注 |
|---|---|---|---|---|
| S0 | 上游、能力与兼容性基线 | ✅ | GS0 | digest-pinned image + 227-package hash lock |
| S1 | 完整原生 GPU Studio + iframe | 🔄 当前 | GS1 | 全七业务面；真实 LoRA + Infer |
| S2 | exact Dataset + 单 Session bridge | ⬜ | GS2 | Session API、预填、真实 Dataset |
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
- [x] vendored archive、source manifest 与 license/notice
- [x] baseline checker 与 6 个负向 tests
- [x] Python/CUDA/Torch/Transformers/Gradio/image 组合锁定
- [x] GS0 gate 记录

目录所有权已固定：第三方输入在 `third_party/ms-swift/`；后续 Python Provider 在
`workers/swift-studio/`；后续 Dockerfile、Compose 与 gateway deployment 配置在
`deploy/swift-studio/`。S0 没有把 Provider 源码放入 `deploy/`。

## GS0 Gate 记录

- upstream：`v4.4.2` / commit `f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d` /
  tree `833d2e1e3ab871a3dc419e46afe79584d1caa45a`；
- archive：16,517,100 bytes，SHA-256
  `60eeb1a53a089306166899951950e195144dc025002ffeffa700067be2787d48`；
- base image：`pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime`，Linux/amd64 manifest SHA-256
  `417bd75df6365104c283ea4c1651fb3530d9eb5a4c2fafa51943cff2a94e6385`；
- dependency lock：Python 3.11 / 227 packages / hashes，SHA-256
  `9da563f95463de1855934914bc79c199b7e16c3bbdf54e2ab47deb02b7c97713`；
- Gradio baseline：1,005 components / 115 callbacks / 76 routes / 七个完整顶级业务面；
- `pnpm swift:baseline:check:green` 与 8 个负向 fixture tests 通过；
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
32～100 条 exact Databench SFT records
LoRA rank 8
max steps 2～5
max length 128
```

最终证据必须登记：

```text
GPU 型号/driver/CUDA
image digest
ms-swift/Gradio/Torch/Transformers versions
base model exact revision
Dataset version/export digest/count
Studio Session id
Artifact archive digest/size
Infer smoke result
Deployment id
Evaluation Run/report id
```

## 不得误报

- 完整 UI 已显示 ≠ 所有上游功能已安装或验证；
- Studio ready ≠ 训练 running/completed；
- Session 绑定 Dataset ≠ 每个原生任务都使用该 Dataset；
- output 目录存在 ≠ Model Artifact 已发布；
- 原生 Swift Deploy ≠ Databench Deployment；
- 原生 Swift Eval ≠ Databench Evaluation Run；
- S4 完成 ≠ V16/V17 或公共云 production readiness 完成。
