# E6 Reports、Details 与 Predictions 证据

- 日期：2026-07-28
- 分支：`feat/evalscope-integration-design`
- EvalScope 基线：`modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`
- 范围：桌面 Web Reports、Report Detail、Predictions 与完整单样本展示

Owner 已明确手机版竖屏不属于当前实现或验收范围。本 Step 只验收桌面 Web；Dashboard、Compare、
Performance、Benchmarks 和最终 Viewer parity 仍属于 E7，因此 E6 不代表 EvalScope UI 已完整复刻。

## 实现范围

E6 将 16 个 capability 置为 green；累计状态为 30 green / 30 planned：

```text
shell.configured-source-refresh
foundation.metric-native-format
reports.catalogue-filters-sort
reports.catalogue-responsive-list
reports.selection-actions
reports.catalogue-states-actions
report.header-summary-navigation
report.overview-table-radar
report.details-analysis-subsets
predictions.threshold-status-counts
predictions.index-navigation
predictions.message-id-search-highlight
sample.chat-presentations-results
sample.messages-reasoning-tools
sample.agent-trace-linkage
sample.rich-content-virtualization
```

主要落点：

```text
apps/web/src/evaluations/components/ConfiguredSourceRefresh.tsx
apps/web/src/evaluations/components/SafeGeneratedDocumentFrame.tsx
apps/web/src/evaluations/domain/metric.ts
apps/web/src/evaluations/domain/reports.ts
apps/web/src/evaluations/domain/agent-trace.ts
apps/web/src/evaluations/features/reports/
apps/web/src/evaluations/features/predictions/
apps/web/src/evaluations/features/sample/
apps/web/src/evaluations/features/content/
apps/web/src/evaluations/routes/report-detail.tsx
```

## 产品行为

- Reports 保留 300ms 搜索、模型/数据集多选、分数范围、四种排序、方向、filter chips、每页 20 条、
  桌面表格与窄 Web 卡片；当前页全选和跨筛选 selection 最多五项；一个 selection 可查看 HTML，两个
  以上进入 Compare，前三项形成 compare URL。
- Configured report source 不暴露服务器路径；扫描会取消旧查询语义、清空筛选/页码/selection 并请求
  新 generation。有效旧数据在刷新错误时仍保持可见。
- Report Detail 显示报告身份、平均/最好/最差/样本数、Overview/Details/Predictions。tab、dataset 和
  subset 使用 typed URL state，direct refresh 可恢复。
- Overview 支持排序、dataset 导航、Task Config JSON；只有至少三个同类 bounded metric 才允许 radar，
  heterogeneous 或 unbounded metric 只显示表格。
- Details 显示 overall score、analysis Markdown、可排序 subset 表和 PerfMetrics；点击 subset 直接进入并
  预选 Predictions。
- Predictions 支持 subset、threshold、All/Above/Below count、前后导航、原始 Index、Index 跳转、message
  ID 前缀定位与高亮，并为无效/歧义输入保留当前样本和可访问错误状态。
- 单样本支持 legacy、structured messages 和 AgentTrace；保留 Generated/Pred 差异、Gold、normalized/raw
  score、Score/Metadata/未知字段，以及 reasoning、tool arguments/result/error/latency、跨 step result、
  env execution、nudge、loop error、stop reason 和 residual tool message。
- Markdown/GFM、非单美元符号 KaTeX、lazy syntax highlight/copy、图片 lightbox、audio/video、JSON fallback
  与长 message/trace virtualization 已落地。普通 `$12 ... $10` 货币文本不会被误判为公式。

## 安全边界

- report/chart active HTML 仍只通过 E3 generated-document pipeline；同页和新标签 viewer 均使用 opaque
  document ID；浏览器不接收原始文件路径或 raw active HTML。
- report 和 chart iframe 固定 `sandbox="allow-scripts"`，不含 `allow-same-origin`；新标签入口固定进入
  Databench `/evaluations/viewer?document=<opaque-id>`。
- 媒体只接受安全的 image/audio/video base64 data URI、raw base64 或受检 relative locator；外部 URL、
  protocol-relative URL、SVG data URI、URI scheme、绝对路径和 traversal 均被阻断。
- 未知 content block 和 prediction 字段只作为本地 JSON fallback；schema identity/normalized score mismatch
  在进入页面 domain model 前失败。

## 真实服务与浏览器证据

本 Step 复用 E5 已生成的真实 provider 报告，没有重新发起测评：

```text
report: eval_9e1edaee-7567-4506-a33a-c0d233088904@@Qwen3::gsm8k
dataset/subset: gsm8k / main
sample Index: 0
message ID: 327b0e9c
```

桌面浏览器验证结果：

- `/evaluations/reports` 在 1075 CSS px 宽度显示 desktop table；既有较窄 Web 宽度显示等价 cards；
- 搜索 `Qwen` 在 300ms 后写入 URL 并保留结果；selection tray 正确显示 `1 / 5`，Compare 是真正的 disabled
  button，不含嵌套 link；
- 扫描后 search、selection 和 page 重置，`report_root_generation` 从 `2` 前进到 `3`；
- Qwen3 报告显示 Overview、Details 和 Predictions；点击 `main` 后 URL 为
  `?tab=predictions&dataset=gsm8k&subset=main`，刷新后保持；
- Index `0` 定位成功，Index `9` 显示可访问错误；message ID `327b0e9c` 定位到一个
  `aria-current="true"` message，并显示定位状态；
- threshold 计数为 All 1 / Above 0 / Below 1；Above 显示本地 no-match 状态；复制 ID 后按钮通过
  `aria-live` 显示“已复制”；
- HTML report iframe 的 sandbox 精确为 `allow-scripts`，src 为 same-origin opaque generated document；
  新标签 href 只进入 `/evaluations/viewer?document=...`；
- 真实 GSM8K 货币文本保持原文；浏览器 console 最终为 0 error / 0 warning。

## 自动化覆盖

- metric registry 覆盖 bounded/native-scale/unknown、alias、rounding、heterogeneous/unbounded radar gate；
- report domain 覆盖 selection cap、current-page/cross-filter selection、summary、subset、threshold、Index 与
  message ID exact/not-found/ambiguous；
- report schemas 覆盖 partial defaults、unknown-field fallback 和 identity/score mismatch；
- trace domain 覆盖 ordered step、cross-step result、latency、stop reason 和无 event residual message；
- rich content 覆盖安全 media URL、raw base64、外部/active URL 阻断和货币 Markdown 回归；
- static boundaries 覆盖 path-free refresh、lazy routes、generated-document sandbox 和无
  `allow-same-origin`。

完整仓库 gate 结果记录在 `docs/evalscope/STATUS.md`。E7 的 30 项 capability 仍为 planned，
`pnpm evalscope:parity:check:green` 继续应失败，直到完整 UI gate 完成。
