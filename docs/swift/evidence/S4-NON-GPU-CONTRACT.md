# S4 Model Deployment + EvalScope 非 GPU 契约验证记录

> 日期：2026-07-28。本文只关闭 S4 的 non-GPU registry、resolve、request 与 lineage 契约。
> 真实 NVIDIA 训练、LoRA serving、`/chat/completions` 和真实模型评测均未执行，继续 deferred。

## 结论与证据边界

当前结论固定为：

```text
S4 non-GPU contract green / GPU deferred
```

本次验证覆盖：

```text
immutable LoRA Model Artifact
→ operator-attested OpenAI-compatible Deployment
→ opaque Deployment ID
→ EvalScope server-side resolve
→ Deployment-bound Evaluation Run
→ Dataset / Artifact / Deployment / Report lineage contract
```

证据分为三类，不能互相替代：

1. 真实 Postgres 17 与 MinIO 生命周期测试验证 Catalog、Workspace、对象存储和外键/identity；
2. Python/API/Web 自动化验证 resolve、权限、replay、projection 和参数契约；
3. route-mocked 浏览器流程验证用户操作、invoke body 和 completed report 页面状态，但不证明真实模型
   endpoint、真实 Evaluation Run 持久化或真实模型输出。

## 环境与固定输入

- 开发主机：macOS / Apple Silicon，无 NVIDIA GPU；
- Node：22 LTS；包管理：pnpm workspace + Turborepo；
- Python：3.11.15；uv：0.11.1 frozen environment；
- 真实依赖：Docker `postgres:17-alpine` 与 MinIO；测试使用独立 schema/bucket，不修改 public catalog；
- Swift upstream：`modelscope/ms-swift@v4.4.2`，commit
  `f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d`；
- S3/S4 current Swift image：
  `sha256:57f2448c3e06985d1989465703f8e4883aee71da40b79be3bdfb70e6dda1f74d`；S4 没有用该镜像执行
  NVIDIA 训练或 serving；
- S4 Deployment profile：`provider=openai_compatible`、
  `registration_mode=operator_attested`、`auth_mode=none`。

## 真实 Postgres / MinIO 生命周期

真实依赖 gate 使用仓库 Compose 的 Postgres 17 与 MinIO，并由各 package 的 test script 为 API、Workspace
和 CLI 重建独立 test schema。执行命令：

```bash
docker compose up -d --wait postgres minio
RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/workspace test
RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/api test
RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/cli test
```

结果：

- Workspace：176 passed、10 skipped；其中真实 MinIO/Postgres integration 文件 21/21；
- API：120/120；
- CLI：14/14。

Workspace 的真实生命周期测试从 exact Dataset 和已发布 LoRA Artifact 开始，依次验证：

1. Session output 经 signed staging 与 conditional create 发布 immutable Artifact；
2. Session close 后 Artifact 仍可 list/get/download；
3. Deployment 绑定该 Artifact 和 verified exact base model revision；
4. CPU/fake OpenAI-compatible `/models` 返回 served model，health 从 `unknown` 变为 `healthy`；
5. `evaluation-run-create-v2` 固定 Dataset version、Artifact ID、Deployment ID 和 Deployment digest；
6. 按 Deployment 查询可找回同一 Run，跨 namespace composite FK 和 delete `RESTRICT` 保留 lineage。

该 suite 使用运行时生成的隔离 UUID，并在 `afterAll` 精确清理 test rows/bucket，因此不会把临时数据库
ID 冒充为长期产品 ID。它验证的是真实数据库/对象存储生命周期；`/models` 对端仍是 CPU/fake response，
没有调用 `/chat/completions`。

## Python、API 与静态契约

执行命令与结果：

```text
pnpm test:evalscope:python          60/60
pnpm test:swift:python              77/77
pnpm --filter @databench/api test  120/120
pnpm --filter @databench/web test  155/155
```

专项断言覆盖：

- operator create/check/disable 与 service internal resolve 使用不同 Bearer role；unset、wrong、cross-role、
  same-value 配置均 fail closed；
- public projection 不含 `endpoint_base_url` 或 `create_digest`；internal resolve route 不进入 OpenAPI；
- endpoint normalization 拒绝 credentials、query、fragment、credential-like text 和 query smuggling；
- EvalScope 浏览器 payload 只接受 `databench_deployment_id`，endpoint/model 只在服务端 resolve 后注入
  upstream execution payload；
- Deployment disable 后新 Run 稳定返回 422 `model_deployment_disabled`，已有 terminal replay 不重新依赖
  endpoint、磁盘或 Deployment live state；
- `Databench Dataset + Deployment` 创建 tracked Run；`Benchmark + Deployment` 明确显示为
  expert/untracked，不创建 Databench Evaluation Run/lineage。

## Route-mocked 浏览器流程

浏览器从 `/evaluations/tasks` 选择 exact Databench Dataset 与 Databench Deployment，提交后进入 completed
状态并提供 report 入口。该流程捕获到：

- Dataset ref：`support-qa`；
- Dataset version：`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`；
- accepted fidelity digest：`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`；
- Deployment ID：`123e4567-e89b-42d3-a456-426614174099`；
- EvalScope task ID：`eval_446c2352-57f5-44ce-95ad-b9fb0e62c49e`；
- 浏览器 console：0 errors / 0 warnings；
- ignored 本地截图：`output/playwright/s4-deployment-evaluation.png`。

捕获的 invoke body：

```json
{
  "limit": 5,
  "eval_batch_size": 16,
  "databench_deployment_id": "123e4567-e89b-42d3-a456-426614174099",
  "databench_source": {
    "source_ref": "support-qa",
    "dataset_version": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "converter": "evalscope-general-qa",
    "options": { "target_source": "none" },
    "accepted_fidelity_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "timeout": 60
}
```

捕获断言：

```json
{"hasModel":false,"hasApiUrl":false,"hasApiKey":false}
```

这个 Deployment ID、Dataset version 和 task ID 是 route fixture 的可审计浏览器证据。因为该浏览器流程
使用 route mocks，它没有生成可声明为真实持久化数据的 Evaluation Run ID、Artifact digest 或 report ID；
真实 Postgres/MinIO 的关系约束由上一节 integration suite 独立验证。不得把页面的 completed 状态描述为
真实 OpenAI-compatible model serving 或真实模型报告。

## 全仓与边界 Gate

本次已通过：

```text
pnpm lint                                      passed
pnpm build                                     13/13 tasks
pnpm typecheck                                 22/22 tasks
pnpm test                                      22/22 tasks
pnpm openapi:check                             passed
pnpm v2:status:check                           passed
pnpm peers check                               passed
pnpm evalscope:parity:check:green              60 capabilities
pnpm evalscope:parity:test                     7/7
pnpm offline:check                             passed
pnpm swift:baseline:check:green                passed
pnpm swift:baseline:test                       11/11
git diff --check                               passed
```

`build`、`typecheck` 与 `openapi:check` 最终采用串行执行；并行执行时 tsup 的 `--clean` 会竞争删除共享
`dist`，该并发失败不属于代码 gate 结果。

## Deferred GPU Gate

以下项目没有执行，状态保持 deferred/unvalidated：

- Linux/NVIDIA 上的真实 SFT/LoRA 训练、stop、显存和 process cleanup；
- 全新目录 explicit base + imported Adapter inference；
- 真实 vLLM 或 transformers LoRA serving；
- OpenAI-compatible `/chat/completions` smoke 与模型输出可用性；
- 真实 Dataset → GPU Training → Artifact → Deployment → Evaluation → Report；
- GPU 型号、driver、CUDA、显存峰值和最终模型 revision 运行证据。

补齐这些证据前，不得声明 GPU 训练/部署已验证、完整数据→训练→评测 GPU 闭环 green、多用户训练平台
production ready，或 V16/V17 已完成。
