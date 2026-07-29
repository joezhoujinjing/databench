# S0–S4 非 GPU 完成性审计

> 日期：2026-07-29。审计对象为 `feat/swift-studio-integration` 的 accepted S0–S4 首期范围。
> GPU 训练、Adapter Infer、LoRA serving 和真实模型评测按 owner 决策继续 deferred；S5/S6 不属于首期。

## 审计结论

```text
S4 non-GPU contract green / GPU deferred
```

S0–S4 的非 GPU 实现、锁、真实 Postgres/MinIO 生命周期、Provider、OpenAPI、Web 与 EvalScope 契约已
逐项复验。审计发现并修复了两个此前被普通全仓 gate 遗漏的真源漂移：

1. GPU evidence checker 的正向测试 fixture 固定引用 S1 旧 image ID、capability digest 和 115 个
   dependency；S2/S3 已把锁升级为新镜像、manifest 和 118 个 patched dependency。fixture 现从
   `upstream.lock` 与 `runtime-capabilities.json` 读取当前真源，22/22 正负向 tests 通过；
2. S2 动态 Session context 与 Dataset/output/logging prefill 已实现并通过 CPU smoke，但 capability manifest
   仍标记为 `planned/uninstalled`。`integration.session-context` 现为 installed/validated/green，GPU 两个
   runtime capability 仍保持 planned/unvalidated。

## 最终锁与镜像

- upstream：ms-swift `v4.4.2` / `f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d`；
- capability manifest SHA-256：
  `441a53584131400a9ba462bd262e931ca584f411d721b009ee122f165da3828f`；
- current Linux/amd64 image ID：
  `sha256:57f2448c3e06985d1989465703f8e4883aee71da40b79be3bdfb70e6dda1f74d`；
- process user：`10002:10002`；
- validation status：`cpu-gateway-browser-green-gpu-pending`。

镜像使用 digest-pinned CUDA base 和现有 hash locks 重新构建。无 GPU 容器验证结果：

```text
Provider ready: true
GPU available: false
capability manifest phase: S1-in-progress
capability manifest digest: 441a53584131400a9ba462bd262e931ca584f411d721b009ee122f165da3828f
Gradio: 5.50.0 / blocks / 1006 components / 118 dependencies
root path: /swift-studio
integration.session-context: installed=true / validated=true / green
```

同一最终镜像内执行 synthetic LoRA full-checkpoint importer smoke，归档结果：

```json
{
  "archive_digest": "9cf2a4875919d6bbeb5a3278e6d833355e21ad75485e73c099ede07dea409b0c",
  "archive_size_bytes": 389,
  "members": [
    "adapter_config.json",
    "adapter_model.safetensors",
    "additional_config.json"
  ]
}
```

验收容器使用 exact name 创建，完成后 `docker rm -f` 并以 `docker inspect` not-found 确认清理。

## 当前提交复验

```text
pnpm lint                                      618 files
pnpm turbo run build --force                  13/13, 0 cached
pnpm typecheck                                 22/22
RUN_MINIO_STORE_TESTS=true pnpm test           22/22
  Workspace                                    176 passed, 10 skipped; integration 21/21
  API                                          120/120
  CLI                                          14/14
pnpm test:evalscope:python                     60/60
pnpm test:swift:python                         77/77
pnpm --filter @databench/web test              155/155
pnpm openapi:check                             11/11
pnpm v2:status:check                           passed
pnpm peers check                               passed
pnpm offline:check                             passed
pnpm evalscope:parity:check:green              60 capabilities
pnpm evalscope:parity:test                     7/7
pnpm swift:baseline:check:green                passed
pnpm swift:baseline:test                       11/11
pnpm swift:s1:gpu:driver:test                  6/6
pnpm swift:s1:gpu:runner:test                  9/9
pnpm swift:s1:gpu:evidence:test                22/22
git diff --check                               passed
```

真实依赖 suite 从空 test schema 应用 13 个 migration，并使用独立 MinIO bucket；没有修改 public catalog。
S4 的浏览器 opaque Deployment payload、Deployment ID、Dataset version 和 task ID 证据继续见
[`S4-NON-GPU-CONTRACT.md`](S4-NON-GPU-CONTRACT.md)。

## 明确未关闭的范围

- Linux/NVIDIA LoRA 2–5 steps、stop、显存与 process cleanup；
- 全新目录 explicit base + imported Adapter Infer；
- vLLM/transformers LoRA serving 与 `/chat/completions`；
- 真实 Dataset → GPU Training → Artifact → Deployment → Evaluation → Report；
- S5 per-session runtime/GPU allocator；
- S6 Databench Training Run/Attempt/Profile 控制面；
- V16/V17、公共云 D3 与 production readiness。

因此本审计不改变 GPU capability、runtime enabled 状态或更大发布声明。
