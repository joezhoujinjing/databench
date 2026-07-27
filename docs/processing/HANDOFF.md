# Worker / Data-Juicer 接入交接

- **交接日期：** 2026-07-25
- **当前阶段：** P0-P7 已完成；固定 `basic-clean-v1` 已通过最终 Gate
- **后续：** 按本文交接；V16/V17 状态仍保持未完成
- **详细方案：** [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md)
- **决策：**
  [ADR 0010](../decisions/0010-python-processing-service-grpc.md)

## 1. 一句话交接

在当前 TypeScript monorepo 中增加一个可选的长期 Python **Worker**。Workspace 通过内部 gRPC
调用它；Worker 是通用 Python capability host，Data-Juicer 是首个 adapter。第一条产品路线是
固定 `basic-clean@1` 异步 transform：TS 投影输入、Worker 执行、TS 验证 retained
identities，并通过现有 v2 Store/Catalog 发布正式 Dataset、Run、cache 和 lineage。

这不是恢复旧 Processing 产品，也不是 artifact-only 工具。

## 2. 当前真实状态

| 项目 | 状态 |
|---|---|
| v2 Dataset/Store/Run/cache/lineage/Ref | 已实现，必须复用 |
| 当前同步 `V2TransformDefinition.run()` | 已实现，保持不变 |
| Worker ADR/技术方案 | 已按 v2-only 修订 |
| `proto/databench/worker/v1` | 已实现；Buf lint 与 TS/Python deterministic codegen |
| `workers/python` | 已实现通用 runtime；health、registry、受控子进程、artifact I/O、adapters |
| Workspace Worker client | 已实现 internal transport-neutral contract + gRPC adapter |
| `transform_jobs_v2` | 已实现；真实 Postgres lease/CAS/cleanup fence |
| Workspace dispatcher | 已实现；单槽 claim、capability gate、事件映射、异常 EOF、durable cancel |
| API runtime owner | 已实现；Worker disabled 无副作用，enabled 显式 start/stop |
| Worker staging Store | 已实现；exact keys、signed URL、bounded read/delete |
| Workspace projection/result reader | 已实现；`record-text-v1` + strict retained subset |
| Dispatcher staging cleanup | 已实现；object → row keys → lease fence 顺序 |
| Data-Juicer monorepo adapter | 已实现；1.5.3、固定 allowlist、无运行时安装/网络 |
| Catalog canonical completion | 已实现；layout + Run + completed job 单事务、DB-clock lease fence |
| Workspace canonical finalizer | 已实现；exact retained → original revisions → Dataset/Run/lineage |
| batch transform REST/Web | 已实现；提交、分页读取、轮询、取消、显式重试、结果/血缘入口 |
| 结果命名与流程可见性 | 已实现；Web 提交必填结果名称，完成时 create-only Ref，并集中展示固定算子顺序/参数 |
| production Worker 装配 | 已实现；Store config 自动接 staging/projector/finalizer/cleaner |
| 最终验收 | P7 已完成；repo + Postgres/MinIO/Worker/browser 全通过 |

P1 Gate（2026-07-25）：Python 2/2 tests 与 source/wheel import smoke、TS↔Python 5/5
integration tests、确定性 codegen、原生 ARM64 preflight 全部通过；全仓 lint 351 files、build
13/13、typecheck 22/22、test 22/22、OpenAPI 11/11、v2 status 与 `git diff --check` 通过。

P2 Gate（2026-07-25）：Prisma migration、真实 Postgres 27/27 Catalog tests、fake Worker
dispatcher 4/4 tests、API lifecycle/DTO tests 通过；全仓 lint 355 files、build 13/13、typecheck
22/22、test 22/22、OpenAPI 11/11、v2 status、peer 与 `git diff --check` 通过。

P3 Gate（2026-07-25）：真实 Postgres 28/28 Catalog tests、Store staging/OSS/S3 tests、
projection/retained/dispatcher tests，以及真实 MinIO + native ARM64 Python Worker 6/6 integration
tests 通过；错误 method、Content-Type、过期 URL 和 cleanup failure 均 fail closed。全仓 lint 361
files、build 13/13、typecheck 22/22、test 22/22、OpenAPI 11/11、v2 status、peer 与
`git diff --check` 通过。

P4 Gate（2026-07-25）：Python 16/16 tests（另有 1 个显式 benchmark gate）、真实 100-row
semantic fixture、10k cancel、deadline/process-group/network/runtime-install 边界，以及真实 MinIO +
gRPC 7/7 integration tests 通过。精确 `basic-clean-v1` benchmark：10k 9.081 秒；100k
31.130 秒；100k repeat 31.394 秒，两次 100k retained output SHA-256 完全一致。全仓 lint 363
files、build 13/13、typecheck 22/22、test 22/22、OpenAPI 11/11、v2 status、Worker
source/wheel/codegen 与 `git diff --check` 通过。

P5 Gate（2026-07-25）：真实 Postgres Catalog 31/31 tests 覆盖 atomic completion、stale/expired
lease、非 finalizing 状态、count mismatch、幂等 replay、cache convergence、determinism conflict 与
transaction rollback；Workspace tests 覆盖 strict subset、empty output、原 revision 保真、cleanup
failure secondary 和 completion/heartbeat race。真实 Postgres + MinIO 124/124 tests 通过，原生
ARM64 Python Worker + Data-Juicer + canonical Dataset/Run/lineage 完整 E2E 7/7 通过。全仓 lint
364 files、build 13/13、typecheck 22/22、test 22/22、OpenAPI 11/11、v2 status、peer 与
`git diff --check` 通过。

P6 Gate（2026-07-25）：Schema 201/201、真实 Postgres Catalog 32/32、Workspace 122/122
（另有 12 个显式 integration skip）、API 63/63（另有 1 个显式 integration skip）、Web 57/57
tests 通过；原生 ARM64 Python Worker + Data-Juicer + MinIO 7/7 integration tests 继续通过，并覆盖
production runtime 默认装配和 Workspace 公共 job facade。并发 ref move/delete 的既有
`SELECT ... JOIN ... FOR UPDATE` 可见性竞态已改为先锁 ref 主行、再读取完整行，真实 Postgres
连续 10 轮、每轮 32/32 通过。全仓 lint 367 files、build 13/13、typecheck 22/22、test
22/22、OpenAPI 11/11、v2 status 与 `git diff --check` 通过。

P7 Gate（2026-07-25）：原生 ARM64 Python 3.11.15、uv 0.11.1；Worker 16/16 tests
通过（另有 1 个显式 benchmark skip），source/wheel import 正常。真实 Postgres + MinIO + gRPC
7/7 通过。固定 Data-Juicer benchmark：10k 6.583 秒，保留 8,000；100k 34.674 秒，保留
80,000；100k repeat 32.807 秒且 retained output SHA-256 完全一致。产品 API 100k canonical
E2E 输入 100,000、输出 80,000、过滤 20,000，Worker `started → finished` 约 41.95 秒；输出
Dataset、Run 和 exact lineage 均可读，重复提交复用同一 job 且 attempt 不增加。

浏览器验收覆盖 Worker disabled 稳定 503 且不产生脏任务、任务完成和结果/血缘入口、API/Web
重启后的任务持久化、100k cancel、Worker 中断安全 failed、Worker 重启后显式 retry 完成，以及
completed 进度固定显示 100%。cleanup fence 未清除时的 retry 现在返回稳定
`409 transform_job_state_conflict`，区分 `not_retryable` 与 `cleanup_pending`，不再退化成 500。
最终全仓 lint 368 files、build 13/13、typecheck 22/22、test 22/22（真实 MinIO 启用）、
OpenAPI 11/11、v2 status、peer、Worker codegen 和 `git diff --check` 全部通过。100k 产品 Gate
可用以下命令复现：

```bash
pnpm test:worker:product-e2e
```

桌面实验目录：

```text
/Users/hanlu/Desktop/llm-data-top5-lab/data-juicer
```

只能作为验证证据，不能成为 monorepo runtime dependency。已确认：

- `py-data-juicer==1.5.3`；
- native ARM64 Python 3.11.15；
- native `uv 0.11.1`；
- monorepo 精确 `basic-clean-v1`、完整 adapter 路径下 100k 约 31.1 秒；
- 100k repeat deterministic；
- 500k 约 311.738 秒，但超过当前 canonical 100k limit，只是 Worker benchmark。

## 3. 阅读顺序

1. `AGENTS.md`
2. `docs/HANDOFF.md`
3. `docs/v2/STATUS.md`
4. `docs/decisions/0010-python-processing-service-grpc.md`
5. `docs/processing/TECHNICAL_DESIGN.md`
6. `docs/decisions/0011-identity-hashing-versioning-v2.md`
7. `docs/decisions/0013-v2-product-cutover-and-v1-retirement.md`
8. `docs/project-structure.md`
9. `docs/directory-layout.md`
10. `docs/conventions.md`

旧 Processing 文案、历史 v1 migration 或 artifact-only 设计不能覆盖上述当前文件。

## 4. 锁定边界

### Worker 是什么

- 名称只有 **Worker**；
- monorepo path 为 `workers/python/`；
- 长期 Python gRPC server；
- capability registry + 通用执行 runtime；
- 首个 capability 为 `data_juicer.batch@1`；
- 以后可加其他受控 Python adapters。

### Worker 不是什么

- 不是 Data-Juicer 专属服务；
- 不是 Databench 业务服务；
- 不是任意 Python/shell runner；
- 不访问 Postgres；
- 不持有长期 OSS/MinIO 密钥；
- 不理解 canonical record/Dataset/Ref/Run/lineage；
- 不计算 Databench identity；
- 不写 `objects/v2/`。

### TypeScript 始终负责

- exact input resolution；
- `record-text-v1` 投影；
- 固定 product operation/preset；
- job/lease/dispatcher；
- staging key 和 signed URL；
- retained subset validation；
- output `V2Dataset`；
- canonical publication、Run/cache/lineage；
- REST/CLI/Web。

## 5. 第一版唯一产品功能

```text
basic-clean@1
```

固定语义：

```text
one exact input Dataset
params = {}
identity mode = preserve
projection = record-text-v1
capability = data_juicer.batch@1
Data-Juicer = 1.5.3, np=1
```

固定 plan：

```yaml
process:
  - whitespace_normalization_mapper: {}
  - text_length_filter:
      min_len: 40
  - document_deduplicator:
      lowercase: false
```

不要迁入实验中的 `quality` numeric filter；当前 canonical record 没有该稳定字段。

输入：

```json
{"record_id":"rec_...","record_digest":"...","text":"..."}
```

输出：

```json
{"record_id":"rec_...","record_digest":"..."}
```

Data-Juicer 对临时 `text` 的变化不写回；TS 从原 input revisions 重建 output Dataset。

Transform 页面只读展示上述三个固定步骤、技术算子名和固定参数，让用户在提交前和查看任务时都能
知道“经过了什么”。这不是算子编排器：页面不能增删、排序或修改参数，公共 operation 仍然只有
`basic-clean@1`。

## 6. Job 与 Run

必须保持两层：

| 对象 | 语义 |
|---|---|
| transform job | 可变执行状态：queued/leased/running/finalizing/failed/cancelled |
| `V2Run` | 成功后的不可变 cache/lineage 记录 |

Worker `completed` 只表示上传完成。产品 job 只有在 TS 已提交 canonical Dataset、登记 Run 后才是
`completed`。

Job ID 和 Run ID：

```text
job_<transform-cache-key>
run_<transform-cache-key>
```

同 cache key 只允许一个 job。第一版不自动 retry；cleanup fence 清除后允许用户显式 retry
同一 job。

提交可携带一个 `result_ref`，Web 将它作为“结果名称”必填。它不进入 cache key，也不改变内容
寻址的 Dataset 版本；同一个 deterministic job 最多绑定一个结果名称。job 完成或命中已有 Run
时，Catalog 在同一事务中 create-only 地采用这个名称：名称不存在则创建，已经指向同一输出则
幂等成功，已指向其他版本或处于删除状态则报告 `conflict` 且不覆盖。即使清洗没有删掉任何记录，
结果名称仍会创建并指向复用的输入版本。

## 7. Staging 的准确含义

Staging 只是 Worker 临时文件交换：

```text
staging/worker/v1/<job-id>/<attempt>/input.jsonl
staging/worker/v1/<job-id>/<attempt>/output.jsonl
```

流程：

1. TS 写 input；
2. TS 为 exact input/output key 签发短期 URL；
3. Worker GET/PUT；
4. terminal + OK EOF 后 TS 读取、校验；
5. TS 发布 canonical Dataset；
6. TS exact-key 删除 staging。

Staging 不出现在成功 job 的公共结果中，因此第一版不做 staging seal/copy。禁止 prefix delete。

## 8. Proto

唯一源：

```text
proto/databench/worker/v1/worker.proto
package databench.worker.v1;
```

RPC：

```text
DescribeCapabilities
RunJob(server stream JobEvent)
CancelJob
```

Proto 只定义 capability、JSON parameters、artifact descriptors、attempt/token、progress/heartbeat/
terminal/cancel。不能放 canonical record、Data-Juicer public preset 或 public REST job DTO。

Generated：

```text
packages/workspace/src/internal/worker/generated/
workers/python/src/databench/worker/v1/worker_pb2.py
workers/python/src/databench/worker/v1/worker_pb2_grpc.py
```

source tree 和 wheel 都必须 import 成功；generated 不手改。

## 9. 已落地文件范围（P1-P5）

P1 只做 Worker foundation：

```text
proto/
├─ buf.yaml
├─ buf.gen.yaml
└─ databench/worker/v1/worker.proto

workers/python/
├─ .python-version
├─ pyproject.toml
├─ uv.lock
├─ Dockerfile
├─ src/databench_worker/
│  ├─ adapters/data_juicer.py
│  ├─ runtime/artifacts.py · subprocess.py
│  └─ data_juicer_child.py
├─ src/databench/worker/v1/
└─ tests/

packages/workspace/src/internal/worker/
├─ client.ts
├─ grpc-client.ts
├─ dispatcher.ts
├─ runtime.ts
├─ workspace-access.ts
└─ generated/

prisma/migrations/0007_transform_jobs_v2/
prisma/migrations/0008_worker_staging_v1/
apps/api/src/config.ts
apps/api/src/index.ts

packages/store/src/v2/
├─ worker-staging-keys.ts
└─ worker-staging.ts

packages/workspace/src/
├─ internal/worker/staging.ts · data-juicer.ts · canonical-finalizer.ts
├─ internal/worker/workspace-access.ts
└─ v2/batch-transform.ts · workspace.ts
```

根 `package.json`、`pnpm-workspace.yaml`、`turbo.json`、CI 和 ignore 可为 codegen/gates 调整。

P6 已完成 REST/Web 产品入口和生产 runtime 的 staging/finalizer 默认接线；Workspace 的
canonical 算法保持单一实现。Worker 未配置或缺少 `data_juicer.batch@1` 时，提交/重试返回稳定
503，任务读取和取消仍可用。

## 10. P1 验收

- [x] Proto package/path 为 `databench.worker.v1` / `databench/worker/v1`；
- [x] WorkerService 有 capabilities/RunJob/CancelJob；
- [x] event oneof 有 accepted/started/progress/heartbeat/terminal；
- [x] terminal 后 `OK` EOF 规则写入注释和测试；
- [x] TS/Python deterministic codegen；
- [x] source-tree + wheel Python import smoke；
- [x] standard gRPC health service；
- [x] transport-neutral TS interface，generated 不出 Workspace；
- [x] test-only `fixture.copy@1` 正常/取消/异常 EOF；
- [x] native ARM64 uv/Python preflight；
- [x] `/usr/local` Rosetta 工具 fail closed；
- [x] P1 未新增 product job、Data-Juicer 或 staging 代码；
- [x] 当前全仓 gates 不回归。

## 11. 后续切片

| Step | 内容 | 完成标志 |
|---|---|---|
| P1 ✅ | Proto + Worker skeleton + client | fake capability 跨语言通过 |
| P2 ✅ | transform job/Catalog/dispatcher lifecycle | fake client 下 durable state machine 通过 |
| P3 ✅ | staging signed URL + projection/result reader | real MinIO round-trip 通过 |
| P4 ✅ | Data-Juicer adapter | 100/10k/100k determinism/cancel 通过 |
| P5 ✅ | canonical finalizer | output Dataset/Run/cache/lineage 通过 |
| P6 ✅ | REST/Web；CLI 延后 | 用户可提交、刷新、取消、重试、进入结果/血缘 |
| P7 ✅ | final gate | repo + Postgres/MinIO/Worker/browser 全通过 |

一个 accepted Step 一个 commit/PR；当前 gate 失败时不进入下一步。

## 12. 不要做

- 不恢复 `/v1/processing/*`；
- 不新增 Processing 一级产品；
- 不把 artifact-only 当成功；
- 不把 Worker 命名或 Proto 绑定 Data-Juicer；
- 不让 Python读取 canonical Parquet 或发布 Dataset；
- 不把 Data-Juicer output text 写回；
- 不开放 YAML/operator composer/字段选择；
- 不加 LLM、多租户、Redis、自动 retry；
- 不把 500k benchmark 当当前 Dataset E2E；
- 不隐式加入 ADR 0012 之外的发布环境；Ubuntu 离线 bundle 已由 ADR 0012 后续窄修订显式纳入；
- 不修改旧只读仓库 `~/Desktop/databench/`；
- 不把桌面实验目录当依赖。

## 13. 实现时最容易犯的错误

1. 把 Worker adapter 的 terminal 直接写成 completed；正确做法是先 TS finalizing。
2. 在 Python 中计算 Dataset version；正确做法是只返回 retained identities。
3. 持有 `V2Dataset` cache lease 等待 60 秒 Worker；正确做法是 preparation 后释放，finalize 重读。
4. 为省事复用 `/v2/transforms/{name}/run`；正确做法是 batch job route。
5. 把实验 `quality` 字段塞进 canonical；正确做法是第一版删除该 filter。
6. 将 staging output 长期公开；正确做法是 canonical publish 后 exact cleanup。
7. 在 `createApp()` 启动 dispatcher；正确做法是只有真实 API entrypoint 有生命周期副作用。
8. 用 Node/Python本地时钟裁决 lease；正确做法是 Postgres clock。
9. cancel 时先杀 Worker 再写 DB；正确做法是 durable cancel-first。
10. 用 prefix delete 清理 job；正确做法是删除 job row 中记录的 exact keys。

## 14. Owner 已锁确认

以下事项已由 owner 锁定，不再讨论：

- 服务名称是 Worker；
- Worker 通用，Data-Juicer 是首个 adapter；
- TS client → Python gRPC server；
- Proto 只做 transport，Zod 仍是领域/public source；
- 当前只做固定 basic-clean vertical slice；
- 无算子编排、字段选择、LLM、多租户；
- 本机/可信私网；
- Data-Juicer 输出最终必须成为 canonical v2 Dataset，而不是 artifact-only。
