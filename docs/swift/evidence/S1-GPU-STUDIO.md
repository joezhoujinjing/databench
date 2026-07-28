# S1 原生 Swift Studio 验证记录

> 日期：2026-07-28。S1 已 code-complete：生产镜像、Gateway、完整 Gradio 与浏览器 gate
> 已验证。当前主机是 macOS/Apple Silicon，没有 NVIDIA GPU，真实 Linux/NVIDIA LoRA +
> Infer 证据仍缺失；owner 已明确将该 gate 后置并允许继续 S2。本记录不把 deferred 写成 green。

## 锁定镜像

- image：`databench/swift-studio:4.4.2`
- local digest：`sha256:09207c761906d5a2dae7e9a6dfd58fe963a6c3047cd9a2eb6f102632fc4d8108`
- lock status：`runtime_target.image_validation_status=cpu-gateway-browser-green-gpu-pending`
- platform：`linux/amd64`
- process user：`10002:10002`
- pinned base：
  `pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime@sha256:417bd75df6365104c283ea4c1651fb3530d9eb5a4c2fafa51943cff2a94e6385`
- upstream：ms-swift `4.4.2` / `f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d`
- runtime：Python 3.11、Torch `2.8.0+cu128`、CUDA runtime `12.8`、Transformers `4.57.6`、
  Gradio `5.50.0`
- Provider closure：FastAPI `0.140.7`、Starlette `0.52.1`、Pydantic `2.12.3`

镜像由 digest-pinned base、vendored upstream archive、两个独立 patch 和 195-package hash lock 构建。
镜像内 `pip check` 为 `No broken requirements found`，并实际 import `attrdict`、`cpm_kernels`、
`evalscope`、`gradio`、`peft`、`swift`、`torch` 与 `transformers`。最新 Provider 源码重新构建后，容器
health 为 `healthy`。容器不带宿主 GPU 时 `gpu_available=false`，没有伪报 GPU。

## 原生配置证据

生产镜像中的真实 `/config`：

```text
bytes:         3,319,393
version:       5.50.0
mode:          blocks
api_prefix:    /gradio_api
components:    1006（1005 upstream + 1 Databench Session banner）
callbacks:     115
root path:     /swift-studio
```

Provider readiness 实际验证 1006 个 normalized component graph 与 115 个 dependency graph 的 exact
digest，其中 dependency digest 包含 `targets/inputs/outputs/queue/connection` wiring；同时验证七个顶级
surface、Gradio 版本、mode、api prefix 和 root path。残缺或 callback wiring 漂移的配置不会被声明为
`native-full-gradio`。

版本化 capability manifest 为 `swift-runtime-capabilities@1` / `S1-in-progress`，镜像锁定 SHA-256
`d5d103922d96cf861bb1f4eddd8d2d2681b2c0670946aff3bee1dad6d97037ca`。Provider 与 Web 都要求该 exact
digest；以其他 JSON 覆盖 manifest 的真实负向容器以 exit code `1` fail closed。

七个原生 surface 均存在：

```text
llm_train  llm_rlhf  llm_grpo  llm_infer  llm_export  llm_eval  llm_sample
```

## Gateway 与浏览器

真实链路为：

```text
Browser :5176 → Vite same-origin proxy → Databench API :18082
              → Swift Gateway → pinned image :28860/:28861
```

已通过：

- root HTML、3.3 MiB config 和 Gradio static assets；root HTML 的无效 PWA manifest link 被兼容性移除；
- Queue/SSE：`gradio_client` 经 Gateway 调用原生 `/update_ddp_num` callback，返回 `1`；
- WebSocket：经 `/swift-studio/gradio_api/stream/{event_id}` 完成 `101`，上游 `Set-Cookie` 未到达浏览器；
- upload/download：上传 `deploy/swift-studio/README.md`，再经 file route 下载并逐字节 `cmp`；
- `/training` 直接刷新；完整七 Tab 逐个切换并确认各自原生 panel；
- iframe 真实 boot handshake、重新加载、进入/退出全屏；全屏容器实测高度 `860px`，与 viewport
  `860px` 一致，iframe 区域使用剩余 `717px`；
- 正常 ready 场景浏览器 console：`0 errors / 0 warnings`；
- 停止专用 Studio 容器后页面显示稳定 unavailable 状态，容器恢复后重新加载回到完整 Studio；
- Web bundle 不包含 ms-swift/Gradio source，原生 UI 仍由锁定的 Gradio runtime 提供。

本机浏览器截图保存在 ignored gate artifact：
`output/playwright/swift-studio-s1-reviewed/training-final.png`。

## 自动化验证

已通过的 S1 专项 gate：

```text
Provider Python: 17 passed
API: 111 passed（Swift Gateway 10）
Web: 148 passed（Swift runtime/frame 10）
API typecheck: passed
Web typecheck: passed
Biome scoped check: passed
```

根脚本 `pnpm test:swift:python` 已建立；CI 使用 Ubuntu、Python `3.11.15` 与 uv `0.11.1` frozen
环境独立执行 Provider tests。

本地非 GPU 全仓 gate 已强制禁用 Turbo cache 复跑：

```text
pnpm turbo run build --force                           13/13 tasks
RUN_MINIO_STORE_TESTS=true pnpm turbo run test --force 22/22 tasks
pnpm lint                                               586 files
pnpm typecheck                                          22/22 tasks
pnpm openapi:check                                      11/11 tasks
pnpm v2:status:check                                    passed
pnpm swift:baseline:check:green                         passed
pnpm swift:baseline:test                               11/11 tests
pnpm swift:s1:gpu:driver:test                           6/6 tests
pnpm swift:s1:gpu:runner:test                           9/9 tests
pnpm swift:s1:gpu:evidence:test                        22/22 tests
pnpm test:swift:python                                  17/17 tests
pnpm peers check                                       passed
pnpm offline:check                                     passed
pnpm evalscope:parity:check                            60 capabilities
pnpm evalscope:parity:test                             7/7 tests
git diff --check                                       passed
```

强制测试实际执行了独立 Postgres schema migration 和真实 MinIO suite；其中 Store `85/85`、API
`111/111`、Web `148/148`。这些结果只关闭本地非 GPU 回归，不替代下节的 Linux/NVIDIA gate；GPU gate
完成后仍需重跑最终 GS1 全仓 gate。

镜像 import smoke 会显示 `cpm_kernels` 使用 `pkg_resources` 以及 Torch 间接 import `pynvml` 的上游
deprecation warning；当前依赖锁固定 `setuptools==80.9.0` 且 import/pip check 均通过。这两项是已记录的
上游运行时债务，不是浏览器 console warning。

## 尚缺的 GS1 证据

当前主机没有 NVIDIA GPU，所以下列项目未执行，S1 不得标绿：

- Linux/NVIDIA Container Toolkit 下 `gpu_available=true`；
- 32～100 条本地兼容 JSONL；
- Qwen 0.5B/0.6B、LoRA rank 8、2～5 steps 的真实完成日志；
- 原生 stop 长任务；
- 原生 Infer 加载该 Adapter 并返回有效输出；
- GPU 型号、driver、显存峰值与运行时日志。

仓库已增加固定 fixture `scripts/fixtures/swift-s1-gpu-sft.jsonl`：32 records、5,365 bytes、SHA-256
`be421073328d9bdfe77f120b92b631f202e8863fcee9aac9ef634bf08b085e52`。GPU 证明必须执行两遍：

1. 当前 `S1-in-progress` 镜像在 Linux/amd64 NVIDIA 主机上生成 candidate：

```bash
pnpm swift:s1:gpu:run
```

2. candidate 通过后，将两个 runtime capability 更新为 validated/green，将 phase 更新为
   `S1-complete`，更新 manifest digest，重建镜像并把新 image ID 写入 lock；随后在该最终镜像上重跑：

```bash
pnpm swift:s1:gpu:run -- --proof-stage final
```

runner 会先核验 NVIDIA Container Toolkit、宿主/容器 GPU、exact image ID 和 non-root UID，再通过原生
Gradio `train_local`、Runtime `wait/kill_task`、Infer `deploy_model/send_message` callback 执行 LoRA、stop
与 Adapter Infer。训练必须从 native Runtime task 绑定 PID/starttime，在下一个 native Popen 前读取 zombie
exit status 并确认 `0`；gate-only 容器用 host PID namespace 对齐 NVML PID 与 exact process tree，
但产品 Studio 不使用该设置。Stop 会等待原生 Runtime 日志和 GPU context 都已观察后才调用
`kill_task`；Stop/Infer 必须确认 process tree、GPU compute context 与显存释放。runner 也会
记录 runner/driver/checker digest，并仅在 `docker rm` 成功且后续 inspect 确认 not-found 后记录容器已删除。
证据输出根不允许 symlink component，创建 run 目录后会再校验 realpath 仍位于 ignored
`output/swift-gpu-gate/` 内。

输出只写 ignored `output/swift-gpu-gate/<run-id>/`，包含 `evidence.json`、三个脱敏运行日志、容器日志与
摘要；不保存 Dataset payload、prompt、生成文本、绝对路径、token 或完整 argv。candidate 只能显式校验：

```bash
pnpm swift:s1:gpu:evidence:check -- --allow-candidate <evidence.json>
```

final 证据不带 allowance；checker 要求 tracked manifest/Provider 为 `S1-complete`、两个 runtime capability
validated/green、lock 为 `s1-gpu-green`，且证据来自 lock 中最终 image ID：

```bash
pnpm swift:s1:gpu:evidence:check -- <evidence.json>
```

当前 macOS 主机执行 `pnpm swift:s1:gpu:run -- --preflight-only` 会按预期以
`S1 GPU gate requires Linux; current platform is darwin` 非零退出，不能生成 green evidence。真实 GPU
证据完成后才能关闭 GS1；owner 修订允许在 GS1 保持 deferred/unvalidated 时先实施 S2-S4。
