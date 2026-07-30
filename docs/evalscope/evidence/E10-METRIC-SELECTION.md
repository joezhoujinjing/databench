# E10 原生 Metric 选择与显式主指标证据

- **日期：** 2026-07-30
- **Databench 基线：** `main@0c0d014`
- **EvalScope 基线：** `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`
- **范围：** 单 Benchmark Evaluation 的原生 Metric 目录、显式选择、执行身份与报告主指标

## 1. 产品行为

- Evaluation 表单选定一个 Benchmark 后请求 `GET /api/v1/eval/metrics?benchmark=...`。
- Catalog 返回锁定 commit 的 27 个原生 Metric Descriptor；不兼容、缺依赖或缺离线资产的项仍展示，
  但不可选择并返回稳定原因。
- 用户可保留 Benchmark 默认指标，或显式选择 1–16 个当前可用 Metric。单选自动成为主指标；多选必须
  明确选择主指标。ANLS 的 `threshold` 通过 Descriptor 生成有界 number 参数控件。
- Browser 只提交 Provider-owned `metric_selection`；Provider 校验后移除该 envelope，并编译到
  `dataset_args.<benchmark>.metric_list`。Browser 不能直接提交 callable、路径、URL 或任意 Python 参数。
- 当前仍不开放自定义 Metric 代码上传或在线安装；Descriptor 的 source/version/digest 结构保留后续扩展点。

## 2. 执行与失败语义

- 显式选择把 canonical Metric ID、typed parameters、output keys、主指标、EvalScope commit 和实现 digest
  固定到 `scoring_config`。
- EvalScope patch 让 `general_qa` 使用 registry Metric，Metric 异常在显式模式下整体失败，不再吞掉异常
  或写入 0 分。
- Provider 只保留本次请求声明的 output，为每项绑定 canonical `metric_id/output_key`；任何必需 output
  缺失、null、NaN 或 infinity 都以 `phase=metric, code=metric_execution_failed` 结束任务。
- EvalScope 聚合报告实际输出 `mean_<output_key>`。Provider 通过 Descriptor binding 把
  `mean_exact_match` 映射回 canonical `exact_match`；scoring identity、callback 和 Postgres 不暴露
  Provider 前缀。
- Benchmark 默认模式不伪造 scoring identity，Databench run 继续使用 v1/v2 create profile。只有显式
  Metric 的 manual/deployment run 分别使用 v3/v4。

## 3. 持久化与报告

- migration `0014_evaluation_metric_selection_v2` 为 `evaluation_runs_v2` 增加 scoring config 与显式主指标，
  并允许旧六字段 Metric summary 与新八字段 canonical Metric summary 共存。
- v3/v4 create digest 使用 RFC 8785 + BLAKE3；Metric 按 canonical ID 排序，UI 点选顺序不改变 identity。
- Complete callback 必须与 run 的 scoring config、主指标和全部声明 output 对应；错误或未知 output 被拒绝。
- EvalScope `Report.score`、报告表格、Dashboard/Compare 和 Databench Web 均通过
  `primary_output_key` 解析主指标；没有显式字段的旧报告才回退到第一项。

## 4. 真实 Ollama 闭环

2026-07-30 在 Apple Silicon 主机用当前分支 ARM64 EvalScope 镜像和本地
`qwen2.5:0.5b` 完成真实 Web 闭环：

- Dataset `222`，Databench version
  `a26e1d38e8221ab1dc5932d0663917a40610c8f35bf86ca49c09af211a15fd2c`，1 个样本；
- Web 显式选择 `Exact Match`，Task
  `eval_52ed0587-4b29-4951-b39f-f48ab1d68ae5`，Run
  `7f772d0e-4a82-4935-abf1-98843f354004`；
- Web → API → EvalScope → Ollama → callback → PostgreSQL → archive 全链路完成，模型请求约
  1.78 秒，结果分数为 0，归档状态 `available`；
- PostgreSQL 保存
  `metric_id=exact_match / output_key=exact_match / primary_metric_id=exact_match /
  primary_output_key=exact_match`；EvalScope 内部报告使用 `mean_exact_match`；
- Reports 列表和详情页均可解析，详情显示 Dataset `222`、1 个样本和 0.0%，未出现 public config
  contract rejection 或 `metric_execution_failed`。

该 smoke 暴露并关闭了两个自动化 fixture 未覆盖的问题：public config feature enum 漏掉
`metric-selection`，以及 EvalScope aggregate key 的 `mean_*` Provider 命名。两处均已增加回归测试。

## 5. Gate 结果

- Metric Descriptor/selection Worker tests、Worker 全量 tests；
- Schema、Hashing、Catalog、Workspace、API 与 Web tests；
- fresh PostgreSQL 14 migrations；
- 真实 PostgreSQL + MinIO v4 create/complete/read lifecycle；
- OpenAPI/generated client、EvalScope parity、upstream patch dry-run；
- 当前分支 ARM64 EvalScope image build 与真实本地 Ollama Evaluation/report/archive smoke；
- repo lint、build、typecheck、test、status/peer/diff gates。

手机版竖屏不属于本轮实现或验收范围。E9 的真实 Ubuntu 22.04 amd64 断网目标机 gate 仍按 owner 决策
后验，不因 E10 完成而标记为 passed。
