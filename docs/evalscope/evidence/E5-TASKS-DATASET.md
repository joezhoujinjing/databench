# E5 Tasks 与 Databench Dataset 闭环证据

- 日期：2026-07-28
- 分支：`feat/evalscope-integration-design`
- EvalScope 基线：`modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`
- 范围：桌面 Web Tasks、Databench Dataset、真实 evaluation/performance lifecycle 与安全报告入口

Owner 于 2026-07-28 明确：手机版竖屏不属于本 Step 的实现或验收 gate。此前生成的窄屏截图不作为
GE5 结论；本文件只把桌面 Web、真实服务和持久化结果作为验收依据。

## 实现范围

E5 将下列 capability 置为 green：

```text
shell.safe-report-new-tab
foundation.polling-query-abort
tasks.tabs-url-state
tasks.evaluation-form-fields
tasks.benchmark-autocomplete
tasks.dataset-args-editor
tasks.performance-form-fields
tasks.monitor-lifecycle
extension.databench-dataset-source
```

主要落点：

```text
apps/web/src/evaluations/features/tasks/
apps/web/src/evaluations/domain/form/
apps/web/src/evaluations/domain/tasks/
apps/web/src/evaluations/hooks/use-task-runner.ts
apps/web/src/evaluations/components/SafeReportLink.tsx
workers/evalscope/src/databench_evalscope/
```

Databench-owned EvalScope Python service 已从部署目录迁到 `workers/evalscope`，与内部 gRPC 的
`workers/python` 同级。两者仍是不同进程：前者由 Web 经 same-origin gateway 通过 HTTP 调用，后者由
Workspace 通过内部 gRPC 调用。`deploy/evalscope` 只保留 Docker、upstream patch/vendor、lock 和
gateway manifest。

## 真实任务

| 场景 | Task ID | 结果 |
|---|---|---|
| Databench exact Dataset evaluation | `eval_80f9f066-0933-41ff-9660-86014dbb6d84` | EvalScope completed；`evaluation_runs_v2` 为 `completed` |
| EvalScope native GSM8K，`limit=1` | `eval_9e1edaee-7567-4506-a33a-c0d233088904` | completed；生成报告 |
| Performance，parallel/number=`1` | `perf_d29ea2fd-2a8d-42df-82b2-e2ed57e9dc32` | completed；生成报告 |
| 用户停止 evaluation | `eval_96fdb3b5-6533-47a6-81d6-ddb40899d5a7` | `cancelled / user_cancelled` |
| Provider 运行中断并重启 | `perf_057b90c9-ae0e-40b2-8f2f-4bf5db66fe84` | `failed / provider_interrupted` |
| 固定 ID 幂等与冲突 | `perf_11111111-1111-4111-8111-111111111111` | 同配置 terminal replay 200；不同配置 `task_id_conflict` 409 |

Databench Dataset exact version：

```text
d39d391260a15c4386968c19a509c0379c6022c78528bd7be2db7ca94f497caa
```

表单以 generated Databench client 完成 Ref/version/inspect；提交前显示 eligibility/fidelity，并要求用户
明确选择 selected candidate、verification ground truth 或无参考答案。EvalScope provider 在执行前通过
Databench REST 重新 inspect/export exact version，并以回调更新 run。native Benchmark 与 Performance
不会伪造 `evaluation_runs_v2` 记录。

## Task monitor 与恢复

- task ID 使用 UUID；同一页面阻止重复提交；切换任务或卸载时 AbortController 清理 invoke/polling；
- invoke 等待期间并行轮询 progress 与增量 log；暂时失败保留最后成功状态并显示 degraded；
- stop intent 先持久化，停止与 invoke failure 竞态只显示一个 terminal；
- 页面刷新可从 URL task ID 恢复 polling；服务重启后 persisted terminal 可重放，失联非终态确定性收敛为
  `provider_interrupted`，不会永久停在 running；
- `dataset_args` 保留原始 JSON，对 locator 拒绝返回字段指针并重新聚焦编辑器。

## 安全报告入口

- 所有“新标签页打开”都指向 Databench `/evaluations/viewer?document=<opaque-id>`；
- link 固定 `target="_blank" rel="noopener noreferrer"`；
- generated document 只进入 `sandbox="allow-scripts"` iframe，不包含 `allow-same-origin`；
- Plotly 使用镜像内固定资产和 nonce CSP，动态 style 自动携带响应 nonce；
- `displaylogo=false`，页面不生成 Plotly 外链；浏览器加载时无 console error。

## 浏览器证据

- [桌面 Tasks 页面](assets/e5/tasks-desktop.jpg)
- [原生 Benchmark 完成](assets/e5/native-benchmark-completed.jpg)
- [Performance 完成](assets/e5/performance-completed.jpg)
- [任务停止终态](assets/e5/task-cancelled.jpg)
- [Provider 中断收敛](assets/e5/task-interrupted.jpg)
- [安全 Plotly viewer](assets/e5/safe-viewer-fixed.jpg)

`databench-running.jpg` 和 `databench-completed.jpg` 只保留为真实 Dataset lifecycle 的过程记录，不作为
窄屏或手机版验收证据。

## 自动化验证

- `uv lock --project workers/evalscope --check`；
- `uv run --project workers/evalscope --frozen pytest -q workers/evalscope/tests`：54 passed；
- `docker build -f deploy/evalscope/Dockerfile -t databench-evalscope:e5 .`：成功，image ID
  `sha256:2081e7e002a833f23d6b72f2f1d892d21702e36be5c1ddf1559648fd4afba5bf`；
- Web form domain 覆盖 native/Databench payload 隔离、默认值、完整 Performance 序列化、raw
  `dataset_args` 和 text+multimodal autocomplete；
- task reducer 覆盖 degraded 保留、stop/failure first-terminal-wins 和 superseded task ignore；
- exact client 覆盖 task header、field pointer、safe generated-document URL 和非有限 JSON number 清洗；
- Python runtime 覆盖 route/config、task claim/replay/conflict、stop/reconcile、Databench
  inspect/export/callback、endpoint/locator policy 和 generated-document security。

完整仓库 gate 和最终镜像结果记录在 `docs/evalscope/STATUS.md`；E6/E7 仍为 planned，GE5 通过不代表
完整 EvalScope UI 已复刻。
