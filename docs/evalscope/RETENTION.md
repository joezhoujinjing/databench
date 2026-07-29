# EvalScope 结果保留、备份与恢复责任

> 本文是 E8 的运行真源。归档对象是备份/审计副本，不用于首期在线报告重建。

## 两个独立数据面

| 数据面 | 保存位置 | 用户能力 | 删除责任 | 备份责任 |
|---|---|---|---|---|
| 在线结果 | EvalScope persistent output volume | 报告、逐样本、比较、性能页面 | EvalScope operator | EvalScope operator |
| 完整归档 | Databench object store | 显示归档可用性；备份与审计 | Databench operator | Databench operator |
| 关联与摘要 | PostgreSQL `evaluation_runs_v2` | Dataset/run 关系、状态、指标与 archive locator | Databench operator | Databench operator |

测评执行完成不等待归档成功。在线结果被清理后，UI 可以显示“在线报告不可用、归档可用”；首期不会从
`tar.zst` 自动恢复 EvalScope 工作目录。归档失败也不会回滚已经完成的测评。

## 保留策略

- E8 不在普通请求或启动流程中自动删除在线结果、最终归档或 PG locator。
- operator 只有在 `archive_status=available` 且备份满足本环境 RPO 后，才可按业务策略清理在线结果。
- 最终对象使用
  `objects/v2/evaluation-result-v1/<digest-prefix>/<blake3>.tar.zst`，immutable、content-addressed；不能原地覆盖。
- staging 使用
  `staging/evaluations/v1/<run_uuid>/<attempt>/result.tar.zst`。PUT 能力 15 分钟过期，但 object 本身不会因 URL
  过期自动消失。
- finalize 先保存 PG locator，再 best-effort 删除 exact staging key。PG 失败时保留 staging 和可能已创建的
  immutable orphan，下一次 finalize 可安全重放。
- orphan 巡检必须从完整 `(run_id, attempt, exact key)` 证据出发并设置年龄门；禁止 prefix delete、bucket
  模糊匹配或根据 digest 前缀批量删除。

默认单个归档上限为 1 GiB。API 可用 `DATABENCH_EVALUATION_ARCHIVE_MAX_BYTES` 下调；EvalScope provider
可用 `EVALSCOPE_ARCHIVE_MAX_BYTES` 设置相同或更小的本地上限。两侧都不得高于 1 GiB。

## 一致性备份

正式备份 generation 必须包含：

1. 暂停 Databench 写入后的 PostgreSQL dump；
2. 同一 generation 的 Databench object-store mirror/snapshot，覆盖 evaluation result objects；
3. EvalScope output volume snapshot，用于保持在线报告能力；
4. 应用版本、migration、EvalScope upstream commit、对象清单和校验值；
5. 加密保存或可演练重建的部署 secret。

PostgreSQL 和 object store 缺一不可：只恢复 PG 会得到悬空 locator，只恢复 object store 会失去 Dataset/run
关系。只恢复归档仍不能替代 EvalScope output volume。异机/NAS 才算最终备份，本机 backup 目录只作中转。

## 恢复顺序与验收

1. 停止 API、EvalScope 写入和清理任务；
2. 恢复同一 generation 的 PostgreSQL 与 object store；
3. 恢复 EvalScope output volume；
4. 启动依赖与服务，执行 reconciliation；
5. 抽查 `available` locator 的 size/BLAKE3，并验证在线 available、仅 archive available、archive failed 三类
   页面状态；
6. 完成一次新测评的 callback → archive → restart smoke 后再开放写入。

业务 owner 负责确定在线结果保留天数、归档保留年限、RPO/RTO 和法务删除要求；平台 operator 负责执行、
审计和恢复演练。策略未明确前按“不自动删除”处理。
