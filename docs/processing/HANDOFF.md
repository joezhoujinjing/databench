# Worker / Data-Juicer 接入交接

- **交接日期：** 2026-07-25
- **当前阶段：** P0 技术方案已按最新 v2-only 代码重写；运行时代码尚未开始
- **下一步：** P1 — Worker Proto、双语言生成、原生 Python package 和最小 gRPC skeleton
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
| `proto/databench/worker/v1` | 尚未创建 |
| `workers/python` | 尚未创建 |
| `transform_jobs_v2` | 尚未创建 |
| Worker staging Store | 尚未创建 |
| Data-Juicer monorepo adapter | 尚未创建 |
| batch transform REST/Web | 尚未创建 |
| 下一切片 | P1 Worker foundation |

桌面实验目录：

```text
/Users/hanlu/Desktop/llm-data-top5-lab/data-juicer
```

只能作为验证证据，不能成为 monorepo runtime dependency。已确认：

- `py-data-juicer==1.5.3`；
- native ARM64 Python 3.11.15；
- native `uv 0.11.1`；
- `np=1` 100k 约 61.512 秒；
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

## 9. P1 文件范围

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
├─ src/databench/worker/v1/
└─ tests/

packages/workspace/src/internal/worker/
├─ client.ts
├─ grpc-client.ts
└─ generated/
```

根 `package.json`、`pnpm-workspace.yaml`、`turbo.json`、CI 和 ignore 可为 codegen/gates 调整。

P1 不能顺手做：

- Prisma job migration；
- Dispatcher；
- Store staging；
- Data-Juicer dependency；
- canonical finalizer；
- REST/Web。

## 10. P1 验收

- [ ] Proto package/path 为 `databench.worker.v1` / `databench/worker/v1`；
- [ ] WorkerService 有 capabilities/RunJob/CancelJob；
- [ ] event oneof 有 accepted/started/progress/heartbeat/terminal；
- [ ] terminal 后 `OK` EOF 规则写入注释和测试；
- [ ] TS/Python deterministic codegen；
- [ ] source-tree + wheel Python import smoke；
- [ ] standard gRPC health service；
- [ ] transport-neutral TS interface，generated 不出 Workspace；
- [ ] test-only `fixture.copy@1` 正常/取消/异常 EOF；
- [ ] native ARM64 uv/Python preflight；
- [ ] `/usr/local` Rosetta 工具 fail closed；
- [ ] 不新增 product job、Data-Juicer 或 staging 代码；
- [ ] 当前全仓 gates 不回归。

## 11. 后续切片

| Step | 内容 | 完成标志 |
|---|---|---|
| P1 | Proto + Worker skeleton + client | fake capability 跨语言通过 |
| P2 | transform job/Catalog/dispatcher lifecycle | fake client 下 durable state machine 通过 |
| P3 | staging signed URL | real MinIO round-trip 通过 |
| P4 | Data-Juicer adapter | 100/10k/100k determinism/cancel 通过 |
| P5 | canonical finalizer | output Dataset/Run/cache/lineage 通过 |
| P6 | REST/Web/可选 CLI | 用户可提交、刷新、取消、进入结果 |
| P7 | final gate | repo + Postgres/MinIO/Worker/browser 全通过 |

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
- 不隐式加入 ADR 0012 offline bundle；
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

## 14. 开始 P1 前的确认

以下事项已由 owner 锁定，不再讨论：

- 服务名称是 Worker；
- Worker 通用，Data-Juicer 是首个 adapter；
- TS client → Python gRPC server；
- Proto 只做 transport，Zod 仍是领域/public source；
- 当前只做固定 basic-clean vertical slice；
- 无算子编排、字段选择、LLM、多租户；
- 本机/可信私网；
- Data-Juicer 输出最终必须成为 canonical v2 Dataset，而不是 artifact-only。
