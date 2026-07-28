# ms-swift 原生 Gradio Studio 集成状态

> 每个 S Step 完成后更新真实状态、提交与 gate。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- swift-status
current_step: S0
last_completed_step: none
runtime_enabled: false
ui_route_enabled: false
upstream_tag: v4.4.2
upstream_commit: f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d
integration_mode: native-full-gradio
-->

## 当前检查点

- **当前分支:** `feat/swift-studio-integration`
- **基线:** EvalScope E7 complete commit `25931d6`，不包含原工作树未提交的 E8 修改
- **当前 Step:** S0 上游、能力与部署基线
- **已完成:** ADR 0018、技术方案和实施计划已由 owner 接受
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
| S0 | 上游、能力与部署基线 | ⬜ 当前 | GS0 | lock/manifest/fixtures/license/patch baseline |
| S1 | 完整原生 GPU Studio + iframe | ⬜ | GS1 | 全七业务面；真实 LoRA + Infer |
| S2 | exact Dataset + 单 Session bridge | ⬜ | GS2 | Session API、预填、真实 Dataset |
| S3 | LoRA Model Artifact import | ⬜ | GS3 | deterministic archive、immutable finalize |
| S4 | Deployment + EvalScope 闭环 | ⬜ | GS4 | opaque Deployment ID、真实 lineage |
| S5 | 多 Session/GPU allocator | ⬜ 后续 | 待 ADR | 不属于首期 |
| S6 | Training control plane | ⬜ 后续 | 待 ADR | Run/Attempt/Worker/callback 接管 |

## S0 待交付

- [ ] `deploy/swift-studio/upstream.lock`
- [ ] `runtime-capabilities.json`
- [ ] `gradio-routes.json`
- [ ] Gradio config/component/dependency/callback baseline fixture
- [ ] downstream patch baseline
- [ ] license/notice
- [ ] baseline checker 与负向 tests
- [ ] Python/CUDA/Torch/Transformers/Gradio/image 组合锁定
- [ ] GS0 gate 记录

## 已知基线证据

- 本地参考 checkout：`/Users/hanlu/Desktop/ms-swift-v4.4.2`，只读研究使用；
- tag：`v4.4.2`；
- commit：`f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d`；
- 上游 License：Apache-2.0；
- 上游 `swift/ui/app.py` 注册七个顶级业务面；
- 上游 README 推荐 Gradio 5.32.1，framework requirement 为 `gradio>=3.40.0,<6.0`；
- Databench 已有 `ms-swift` converter version `1.0.0`，输出 `messages` + deterministic JSON-string
  `tools`，minimum ms-swift `4.2.0`。

这些证据只用于进入 S0，不等于 GS0 或任何 GPU gate 已完成。

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
