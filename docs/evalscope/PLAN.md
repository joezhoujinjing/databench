# EvalScope 功能等价 UI 迁移实施计划

- **状态:** Accepted——owner 于 2026-07-27 确认方案 review 问题修复并要求开始实施
- **日期:** 2026-07-27
- **Databench 基线:** `main@25130a2ecba8075435b4c1aa20f3f6438193ef23`
- **EvalScope 基线:** `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`
- **规范依赖:** [ADR 0017](../decisions/0017-evalscope-native-ui-integration.md)、
  [技术方案](TECHNICAL-DESIGN.md)
- **实施纪律:** 一个 accepted Step 一个 commit/PR；当前 gate 通过后再进入下一步

## 1. 交付目标

最终交付一套 Databench 原生 Evaluation 产品面：

```text
Databench Web（Databench Shell / Router / Visual / i18n）
  ├── Dashboard
  ├── Evaluation + Performance Tasks
  ├── Reports + Details + Predictions
  ├── Chat / Tool Calls / Agent Trace / Media
  ├── Evaluation Compare
  ├── Performance Reports / Requests / Compare
  ├── Benchmark Catalogue
  └── HTML Report Viewer
        ↓ same-origin /evalscope-api/*
EvalScope backend-only service
        ↓
model / metrics / Judge / reports / persistent outputs
```

Databench Dataset 闭环：

```text
选择 Ref / exact Dataset version
  → evalscope-general-qa inspect + fidelity
  → EvalScope execution / progress / log / stop
  → Databench 原生报告页面
  → evaluation_runs_v2 summary
  → immutable result archive
```

“完成 UI 迁移”必须通过技术方案 §3 的全部 parity 项，不能用页面数量、复制文件数量或截图相似度替代。

## 2. 全程硬约束

1. 不迁移 v1.6.1 Gradio UI，只使用锁定 React commit。
2. 不使用 iframe 嵌入 EvalScope SPA，不创建第二个 Vite app，不引入 React Router、git submodule 或
   用户可见 EvalScope SPA；generated report/chart 只允许进入无 `allow-same-origin` 的受限 sandbox frame。
3. UI 是 Databench 风格，但 capability manifest 中的上游业务能力不得删除。
4. EvalScope Logo、顶栏、独立 theme/locale shell 不迁；对应能力由 Databench Shell 替代。
5. Web 对 Databench `/v2/*` 只用 generated client；EvalScope external API 使用隔离的 pinned Zod adapter。
6. API/CLI 只经 Workspace + Schema；EvalScope 只经 Databench REST 使用 Dataset/run/archive。
7. canonical Dataset、identity、record schema、layout 和 version 公式不变。
8. input、prediction 和完整报告不进 Postgres；完整结果只进 object store。
9. Converter 必须 inspect、fidelity approval、stable count 和 fixed-byte tests。
10. Dataset binding 只认 exact version；Ref 只作入口和显示。
11. EvalScope 不持有 Databench object-store 长期凭据，不直连 Postgres。
12. result staging 只使用 attempt-scoped exact key，禁止 prefix delete。
13. API key、headers、signed URL、prompt/prediction 不进入 PG、URL、日志或归档 manifest。
14. upstream UI/Python 固定 commit、source manifest、patch digest 和 dependency lock，禁止浮动 main。
15. gateway 只允许评审过的 HTTP method + exact path；禁止 `/api/v1/*` wildcard 自动暴露新 endpoint。
16. 用户提交的模型 URL 默认 deny，只允许 operator 配置并通过 DNS/redirect/egress 全链复核的 HTTP(S)
    destination。
17. raw report HTML 不进入浏览器；HTML/Markdown 隔离、本地 Plotly、task claim/reconcile 必须在 E3 首次
    暴露相关 API 前完成，E9 只做最终复核。
18. runtime disabled-by-default；安全/离线 gate 前不得扩大现有发布声明。
19. 本计划不启动或完成 V16/V17，不解除公共云 D3 决策门。

## 3. 里程碑

```text
E0 决策、来源和 parity 基线
 ↓
E1 general_qa Projection
 ↓
E2 Evaluation Run 控制面
 ↓
E3 EvalScope backend-only、安全 gateway 与任务正确性边界
 ↓
E4 Databench Evaluation UI foundation
 ↓
E5 Tasks 与 Databench Dataset 闭环
 ↓
E6 Reports、Details 与 Predictions
 ↓
E7 Dashboard、Compare、Performance、Benchmarks、Viewer
 ↓
E8 完整结果归档与 retention
 ↓
E9 安全复核、离线、升级与最终 parity gate
```

| Step | 单次交付 | 主要落点 | Gate |
|---|---|---|---|
| E0 | ADR、方案、parity/source evidence | docs、third-party evidence | GE0 |
| E1 | `evalscope-general-qa@1.0.0` | schema、io、workspace、API | GE1 |
| E2 | `evaluation_runs_v2` 和 REST | Prisma、catalog、workspace、API | GE2 |
| E3 | backend-only image、exact API proxy、active-content/egress/task safety、Databench source preparation | deploy/evalscope、gateway | GE3 |
| E4 | routes、API adapter、tokens、i18n、primitives | apps/web | GE4 |
| E5 | eval/perf tasks、monitor、Dataset selector | apps/web、EvalScope backend | GE5 |
| E6 | reports/detail/predictions/full sample rendering | apps/web | GE6 |
| E7 | 剩余全部 upstream 业务页面与全量 parity | apps/web | GE7 |
| E8 | metrics callback、result archive、online/archive states | store、workspace、API、EvalScope | GE8 |
| E9 | security revalidation、capacity、offline、upgrade/rollback、final review | deploy、docs、full system | GE9 |

## 4. Step 交付与 Gate

### E0 — 决策、来源和 parity 基线

交付：

- 接受 ADR 0017、技术方案和本计划；
- 锁定 EvalScope commit、license、package locks 和研究 evidence；
- 建立完整 capability-level route/component/field/action/state/default/responsive/a11y/API parity checklist；
- 对 upstream 21,096 行和 34 个 tests 建立 migrate/adapt/replace/exclude 文件级分类；
- 明确 brand/shell exclusions：App boot、BrowserRouter、EvalScope Logo/GitHub、独立 TopNav/Theme/Locale；
- PathBar 不属于 shell-only：editable root 分类为 `security-replacement`，用户 Refresh/Rescan 目的必须由
  configured-source 控件等价保留；
- 记录每个 exclusion/replacement/extension，禁止用“未迁移”规避能力；Benchmark launch 和 Databench
  Dataset source 明确为 `databench-extension`；
- 定义 `THIRD_PARTY_NOTICES.md`、`UPSTREAM.md`、file-level `upstream-manifest.json` 和 capability-level
  `ui-capability-manifest.json` schema；
- capability coverage checker 双向拒绝 uncovered upstream capability、orphan target、无 test/evidence parity、
  未保留用户目的的 security replacement，以及被计入 upstream coverage 的 Databench extension；
- 枚举 Flask `url_map`，固化 method + exact-path classification、request/response fixtures，并明确
  `/eval/resume/invoke` blocked、`/reports/scan` 由 configured-root `/reports/list` replacement；
- 固化 CSS collision、router dependencies 和 output layout evidence；
- 建立 active-content threat model：`autoescape=False`、Markdown→HTML、`analysis_html | safe`、Plotly script、
  iframe/`window.open` 路径逐一对应 sanitizer/safe-document/CSP test；
- 枚举 `reports.py`、`perf_archive.py`、`report.html.j2`、`perf_report.html.j2` 的所有
  `PLOTLY_CDN_URL`，锁定待分发 Plotly version/digest/license；
- 固化 Benchmark schema/category fixtures，必须包含 all/text/multimodal/agent/aigc；
- 不修改 runtime、Prisma、OpenAPI、产品状态或发布声明。

> **GE0:** 文档 links/fences/trailing whitespace、`git diff --check`、`pnpm v2:status:check` 通过；
> owner 将 ADR、技术方案和计划改为 Accepted；source/capability manifests 实际存在，双向 coverage checker
> 为绿，parity checklist 无未分类业务功能，endpoint classification、active-content threat model、Plotly
> asset evidence 和五类 Benchmark fixtures 均完整，才进入 E1。

### E1 — `evalscope-general-qa` Projection

交付：

- `V2_CONVERTER_NAMES` 新增 `evalscope-general-qa`；
- task view 新增 `evaluation-qa`；
- strict options：selected candidate / ground truth / none；
- text-only eligibility 和 bounded exclusion reasons；
- deterministic messages/response/`_databench` JSONL；
- config hints 固定 `general_qa`、subset 和 eligibility summary；
- fidelity changes/approval；
- registry list/show、inspect/export、CLI/Web fidelity review 兼容。

> **GE1:** 三种 profile fixed bytes、所有 exclusion reasons、multi-selected count、inspect→stream
> binding、fidelity mismatch 和真实 exact Dataset export 通过；适用全仓 gates 通过。

E1 不修改 EvalScope，不增加 run 表。使用锁定 EvalScope 做手工/自动 compatibility smoke，证明
`general_qa` wire format 成立。

### E2 — Evaluation Run 控制面

交付：

- additive `evaluation_runs_v2` migration 和 raw CHECK；
- required exact Dataset FK；
- bounded `provider_report_ids_json`，不保存 public `report_url`；
- strict run、metric、error、pagination 和 transition schemas；
- Catalog create/read/list/transition；
- Workspace exact version re-inspect 和 normalized plan binding；
- `/v2/evaluation-runs*` create/get/list/start/complete/fail/cancel；
- archive preparation/finalization contract 可以先 disabled；
- provider task unique locator + canonical create-request digest、terminal replay/conflict；
- OpenAPI/generated Web client；
- capability disabled-by-default。

> **GE2:** 真实 Postgres migration、exact FK、Ref move independence、create digest race/replay/mismatch、
> transition matrix、provider report ID bounds、metrics/secret rejection、API lifecycle 和全仓 gates 通过。

E2 只记录 Databench Dataset evaluation run，不把 native Benchmark/perf run 强行装入该表。

### E3 — EvalScope backend-only、安全 gateway 与任务正确性边界

交付：

- `deploy/evalscope/upstream.lock` 固定 commit、source digest、Python/npm lock evidence；
- reproducible production image；
- `EVALSCOPE_SERVE_WEB=false`，不注册/暴露 upstream SPA；
- production WSGI one-process + threaded；
- Vite/Caddy `/evalscope-api` 使用同一 method + exact-path manifest；所有未评审 path/method/query 默认拒绝；
- 只开放技术方案 §8.1 allowlist；显式测试 `/eval/resume/invoke`、`/reports/scan` 和 synthetic upstream
  endpoint 不可达；
- configured output root，禁止 browser `root_path` override；
- configured-root list/refresh 返回非路径 `report_root_generation`，保留 rescan 语义；
- `/api/v1/config` 使用无绝对路径的 capability/version schema；
- report/media realpath allowed-root containment；
- raw report/chart/perf HTML 不到浏览器；建立 sanitizer、`GeneratedDocumentDescriptor`、短期 opaque
  document、无 `allow-same-origin` sandbox、nonce CSP、nosniff/content-type/no-referrer/frame 策略；
- 固定 Plotly version/digest/license 随 image 分发，重写全部 `PLOTLY_CDN_URL` 生成路径，断网零外部请求；
- model endpoint policy：仅 HTTP(S)、operator host/CIDR/port allowlist、每次连接 DNS/IP 复核、redirect
  逐跳复核、metadata/link-local/default-private deny 和容器 egress policy；
- native Benchmark `dataset_args` recursive locator admission：规范化 key 后拒绝 path/dir/url/uri family，
  拒绝 absolute/traversal/drive/UNC/URI-like value，返回稳定 field error 且不创建 task claim；
- native eval、Databench eval、perf 共用 task-local exclusive claim + HMAC config digest；禁止 process registry
  overwrite；同 digest active/terminal replay与 mismatch 409；
- stop intent 先原子持久化，terminal callback 有稳定裁决；
- startup manifest scan：terminal callback 重放、stop intent → cancelled、失联 prepared/running → failed
  `provider_interrupted`；增加不经 browser gateway 的 authenticated operator reconcile endpoint；
- `DatabenchClient`、exact re-inspect/export、atomic input staging；
- `general_qa` TaskConfig injection 和 `_databench` metadata；
- create/start/complete/fail/cancel callbacks；
- 原子 `task-claim.json` 和 `databench-integration.json` replay；
- task/concurrency/disk/body bounds 的最小 fail-closed 配置。

> **GE3:** pinned image 断网可复现；upstream SPA root 和所有非 allowlist API blocked；health/exact proxy
> 通过；真实 Databench export → general_qa → progress/log/stop/report；same-ID race、active/terminal replay、
> config mismatch、registry overwrite、stop/fail race、prepared/running restart、callback loss、startup/manual
> reconcile 全通过；malicious HTML/Markdown/Plotly、top-level raw HTML、root/media traversal、scheme/host/
> port/DNS rebinding/redirect/metadata、arbitrary URL/path、nested/case/kebab/alias `dataset_args` locator、
> `/config` absolute-path response 和 credential leakage negative tests通过；所有
> report/chart/perf HTML 断网零外部请求；一个 blocking invoke 与 polling 并发通过。

E3 后 backend 已具备运行能力且首次暴露的接口已有完整安全边界，但 Databench 产品面仍 disabled，不声明
UI 完成。E9 会在目标部署复核这些性质，不得把任何上述控制推迟到 E9 首次实现。

### E4 — Databench Evaluation UI foundation

交付：

- `THIRD_PARTY_NOTICES.md`、`apps/web/src/evaluations/UPSTREAM.md`、source manifest、capability manifest 和
  coverage checker；
- 全部 `/evaluations/*` TanStack routes 和 lazy boundaries；
- Databench 主导航 `Evaluations` 和 Evaluation subnav；
- EvalScope external Zod client、统一 `/evalscope-api/api/v1` base 和 errors；
- exact route manifest client、无路径 config schema 和 generated-document descriptor schema；
- no-bare-`/api/v1` static check；
- Evaluation capability/unavailable boundary；
- `.evaluation-surface` 和 `--es-*` scoped tokens；
- common primitives 映射到 Databench Button/Card/Tabs/Badge/Field/Alert/Skeleton/Table；
- `evaluations.*` i18n namespace 和 locale key drift test；
- report key base64url codec、typed route/search params；
- route-level skeleton/error/404；
- initial bundle 和 heavy dependency lazy-load budgets。

> **GE4:** no React Router/ThemeContext/LocaleContext/root token pollution；Databench datasets 首屏不包含
> Evaluation heavy chunks；所有空 route 可 direct refresh；proxy unavailable 状态；CSS token/static checks；
> route/i18n/unit tests、desktop/narrow shell browser smoke 和全仓 gates 通过。

E4 只建立可信迁移底座，不用占位页冒充功能 parity。

### E5 — Tasks 与 Databench Dataset 闭环

交付：

- Tasks page 的 Evaluation/Performance tabs 和 typed `?tab=`；
- upstream EvalConfigForm 全字段、text+multimodal autocomplete（最多 8 项、multi-value、键盘/outside-click）、
  advanced params、validation/focus；agent/aigc suggestion expansion 不计 upstream parity；
- `dataset_args` raw JSON/object validation 和 payload parity；E3 locator security error 保留 raw input 并聚焦
  editor；
- upstream PerfConfigForm 全字段、validation/focus；
- Databench Dataset source selector：Ref/exact version/task type/target；
- inspect eligibility/fidelity review；
- source switch payload isolation；
- `crypto.randomUUID()` provider task IDs；
- invoke/progress/log/stop/report；
- report action 不生成 raw HTML URL；保留上游“在新标签页打开”，使用
  `<a target="_blank" rel="noopener noreferrer">` 打开 Databench `/evaluations/viewer?document=<opaque-id>`
  壳，generated document 只进入壳内 safe frame；
- polling cancellation、network degradation、duplicate submit protection；
- Dataset detail preselection；
- Databench source run row/callback；
- native Benchmark 和 performance 仍可直接运行。

> **GE5:** capability manifest 中 Tasks/EvalForm/PerfForm/TaskMonitor 全绿；真实 Ref → inspect → fidelity →
> export → eval → progress/log → report；native Benchmark task；performance task；stop、disconnect、polling
> failure、refresh 后 terminal/interrupted 可见性、same-ID duplicate、stop/fail race、safe new-tab action、
> raw-report navigation、dataset_args locator field error/raw preservation、secret negative tests；desktop/narrow/
> keyboard/a11y browser gate 和全仓 gates。

### E6 — Reports、Details 与 Predictions

交付：

- Reports 300ms search、model/dataset multi-select、score range、time/score/model/dataset + asc/desc、active
  chips/clear、每页 20 条；
- responsive desktop table/narrow cards、current-page select-all、跨 filter/sort selection、cap=5 notice、
  single-selection HTML、2+ compare/first-three slots；不新增 view toggle；
- configured report source status + 用户可见 Refresh/Rescan；删除 editable PathBar/arbitrary path，但保留共享
  generation、request cancellation、cache/filter/page/selection reset；
- ReportHeader、avg/best/worst/total Summary；安全 viewer 同页和 new-tab actions；
- Overview sortable table；仅 3+ comparable bounded datasets 显示 table/radar；heterogeneous/unbounded 禁止
  radar；collapsible Task Config JSON；
- Details overall score、analysis Markdown、subset/metric/score/num table、PerfMetricsPanel；subset click →
  Predictions；
- Predictions subset、threshold、All/Above/Below counts、previous/next、sample Index、按 Index 跳转、按
  message ID 搜索/高亮及 invalid states；
- metric native scale/format；
- legacy/structured/traced Chat presentation；Generated/Pred、Expected/Extracted、normalized/raw score、Score
  JSON、Metadata；
- role/reasoning/tool call/result/error/latency、message/perf chips、copy、reasoning collapse；
- AgentTrace step、cross-step tool result、env execution、nudge、loop error、stop reason、residual tools；
- prediction/message/trace virtualization；
- Markdown/GFM/KaTeX/syntax highlight/copy；
- image lightbox/audio/video/JSON fallback；
- report HTML/chart/media URL base rewrite；
- HTML/chart/history 使用 E3 的 safe generated-document pipeline；frame 无 `allow-same-origin`，原始 active
  HTML 不进入 DOM/顶层窗口；
- 所有 report/chart/perf viewer 只加载固定本地 Plotly asset，断网零 external request；
- online unavailable/archive state placeholder；
- bounded report cache 和 AbortSignal cleanup。

> **GE6:** capability manifest 中 Reports/ReportDetail/Predictions/SingleSample 全绿；pinned
> single/multi/heterogeneous/unbounded/tool-trace/cross-step/error/media fixtures；真实 provider report；所有
> filter/jump/highlight/pager/copy/collapse/radar-condition/refresh/new-tab actions；large prediction/trace
> virtualization；malicious Markdown/HTML/event/URL/Plotly
> fixtures、top-level/`window.open` 阻断、sandbox/CSP/nonce/nosniff/content-type/frame 策略；media/root escape；
> schema mismatch/partial report；断网零外部请求且 Plotly digest 命中；desktop/narrow/keyboard/a11y/browser
> console；bundle budgets 和全仓 gates 通过。

### E7 — 剩余完整 UI 与全量 parity

交付：

- Dashboard evaluation/performance/去重模型/最近运行四个 KPI、可点击 KPI 导航、不预截断且按时间
  排序的 eval + perf recent feed；All/Evaluation/Performance 类型筛选、model/dataset/provider/protocol
  搜索、分页、行跳转、partial-data/loading/welcome/no-data/no-match states；
- Evaluation Compare 从 URL 恢复且硬限制 2–3 个 model slots，按 report name add/remove/cancel；
  Score/Prediction tabs，average/dataset table、radar/chart fallback，共同 dataset/subset 交集及无交集
  incompatibility；threshold、每模型 Any/Above/Below、All Any/All Above/All Below presets、above
  rate；对齐样本分页、previous/next、Left/Right keyboard、showing X of Y、并排 ChatView、score/delta
  和单列异常隔离；
- Performance catalogue 的 model/dataset/api type/provider/protocol 搜索、time/RPS/latency 排序、
  provider/protocol 独立展示、selection cap/clear、single HTML、2+ compare/first-three slots、可见
  Refresh/Rescan、retry/no-data/no-match 和 invalid-refresh stale-data preservation；
- Performance detail 的 provider resolution fallback、Overview/Charts/Runs tabs、single-run 分支、basic KPI、
  summary/best/config/recommendations、closed-loop 表示；embedding/rerank 条件 metric/chart；per-run
  selector/workload/percentile；request All/Success/Failed、count、50/page、pagination/charts/table 及无
  DB/无 percentile states；
- Performance Compare 默认 oldest baseline + newest candidate、swap 并写入 URL；baseline/candidate/sample
  counts、absolute/percent delta、direction-aware verdict；critical/warning/normal low-sample 阈值；
  workload mismatch、missing/sparse data、symmetric config diff、部分 metric 不可计算时的独立降级、
  embedding/rerank 条件 chart、latency/throughput groups 和 fallback table；
- Benchmark `upstream-parity`：all/text/multimodal/agent/aigc tabs + counts、300ms search、tag
  multi-filter/chips/clear、24/page responsive cards、category/samples/subsets/few-shot/tags/metrics、详情
  modal、中英文完整 Markdown、Paper link、loading/no-result；
- Benchmark detail → task preselection 作为独立 `databench-extension` 交付，不计入 upstream
  parity coverage；
- HTML Report Viewer 的 loading/error/sanitized document；保留同页和安全新标签页操作，新标签页只打开
  Databench viewer route + opaque document ID，不打开 raw HTML；
- 所有 cross-page selection/search/direct refresh，包括 Refresh/Rescan 的 request cancellation、generation、
  cache/filter/page/selection reset 语义；
- upstream 34 tests 的最终 migrate/adapt/replace/exclude closure；
- `upstream-manifest.json` 文件来源闭环；`ui-capability-manifest.json` 每个业务能力绑定
  classification、target、test 和 browser evidence；
- Databench visual review，确认无 EvalScope Logo/顶栏/第二套壳和无丢失业务操作。

> **GE7:** file manifest 无未分类文件；capability manifest 双向 coverage checker 通过，所有
> `upstream-parity`/`security-replacement` 为 green，没有 orphan target、无 test/evidence 项或被计入
> coverage 的 extension；同一 pinned API fixtures 的 upstream/migrated domain equivalence；全部 routes
> desktop/narrow/keyboard/a11y/direct refresh；真实 eval/perf reports 和 compare；Predictions threshold/search/
> jump/highlight，Evaluation Compare add/remove/intersection/per-model filters/keyboard，Performance single-run/
> embedding/baseline swap/delta verdict/low-sample/workload mismatch/config diff 全通过；browser console clean；
> 五类 Benchmark parity fixtures 的 counts/filter/detail 通过，launch extension 单独通过且不提高 parity
> coverage；safe new-tab 和 configured-source Refresh/Rescan 通过；generated content 断网零外部
> 请求；独立功能 review 无 blocker；全仓 gates 通过。

GE7 是“最新 UI 功能完整迁移”的唯一 gate。E4-E6 不得提前宣称完整复刻。

### E8 — 完整结果归档与 retention

交付：

- execution/archive state 独立；
- EvalScope result → bounded metrics/provider report IDs；
- deterministic allowlist `tar.zst` 和 integration manifest；
- credential/path/symlink deny gate；
- attempt-scoped staging、15-minute conditional PUT、size cap；
- Workspace digest/size verify、content-addressed final object、PG locator、exact cleanup；
- prepare/finalize/fail archive REST；
- archive retry/lost response/orphan-safe ordering；
- UI 显示 online available / archive available / online unavailable / archive failed；
- online/archive retention 和 backup ownership 文档。

> **GE8:** deterministic archive bytes、secret fixtures、oversize、wrong digest/size、expired URL、
> concurrent finalize、conditional-create replay、PG failure、exact cleanup、真实 MinIO/OSS-contract tests；
> UI 状态 tests 和全仓 gates 通过。

### E9 — 安全复核、容量、离线与最终集成 Gate

交付：

- 复核 E3 已实现的 method + exact-path 网关，EvalScope root/static SPA 和新增 upstream endpoint 继续默认
  blocked；
- 环境访问控制覆盖 `/evalscope-api`；可信内网/公网边界不混淆；
- 对 E3 的 task claim/reconciliation、model endpoint SSRF/egress、HTML sanitizer/generated-document/
  sandbox/CSP、secret redaction 做目标环境 failure injection；本 Step 不首次交付这些控制；
- 复核 `/config` 不含绝对路径，raw HTML 不顶层打开，所有 report/chart/perf 路径使用本地 Plotly 且
  断网零 external request；
- task/model/CPU/GPU/memory/input/output/archive/time/concurrency limits；
- WSGI/gateway long invoke 和 drain；
- EvalScope image/volume 纳入 offline bundle、Compose、Caddy、health、backup；
- install/upgrade/drain/rollback；
- upstream UI/Python upgrade runbook、source diff 和 compatibility matrix；
- final threat model、failure injection、capacity evidence 和 operator runbook；
- project structure/directory layout/HANDOFF/product surface/status 文档同步。

> **GE9:** 真实目标部署和 Ubuntu 22.04 amd64 断网环境完成 install → Dataset selection → eval →
> native report → compare → performance → callback → archive → restart/reconcile → upgrade → rollback；另完成
> exact-route drift、same-ID race/stop race/callback-loss、malicious active content、DNS rebinding/redirect/metadata、
> 零外部 asset request 的负面验证；全 parity、安全、容量、bundle、全仓 gates 和独立 review 无 blocker。

GE9 只发布 ADR 0017 范围，不自动完成 V16/V17 或公共云 D3。

## 5. UI parity 追踪规则

`upstream-manifest.json` 是文件级 source/license manifest，对每个 upstream production/test file 记录：

```text
upstream path
upstream digest
target path
status: migrated / adapted / replaced / excluded
reason
parity IDs
tests
```

文件状态约束：

- `migrated`：业务代码基本保留，适配 imports/tokens；
- `adapted`：Router/API/state 等按 Databench 架构重构，但能力等价；
- `replaced`：文件由 Databench primitive 或安全实现替代，不代表内部能力自动覆盖；
- `excluded`：只允许品牌、独立 SPA boot 或重复 shell；必须给出 `brand-shell-exclusion`
  理由。不安全的任意 path 不得直接排除用户目的，必须进入 `security-replacement`。

`ui-capability-manifest.json` 是能力级验收真源，每项记录：

```text
parity ID + route + upstream component
field / action / state / default / responsive / a11y / API contract
target component + target capability
classification: upstream-parity / security-replacement / databench-extension / brand-shell-exclusion
test locator + browser evidence locator + status
```

分类约束：

- `upstream-parity`：锁定上游的业务能力，必须有 target、test、evidence 且行为等价；
- `security-replacement`：不保留不安全机制，但必须保留用户目的。PathBar 的 editable root 归此类，
  替代 target 是 configured source 下用户可见的 Refresh/Rescan 及完整 reset 语义；
- `databench-extension`：上游没有的增强，必须单独测试且不计入 upstream coverage。Benchmark
  detail → task preselection 和 Databench Dataset source 属于此类；
- `brand-shell-exclusion`：仅允许上游 Logo/顶栏/BrowserRouter boot/重复 shell，不允许包含业务操作。

双向 coverage checker 同时从 upstream source 枚举 capability，从 Databench target 枚举实现能力，拒绝：
未分类 upstream capability、orphan target、无 target/test/evidence 的 parity、未保留用户目的安全替代、
被计入 upstream coverage 的 extension 和所有 `pending` 项。文件标记 `migrated`/`adapted` 不能
代替内部能力覆盖证明。任何 upstream 新 commit 增加 production UI file 或 capability 时，upgrade
gate 自动产生未分类项并阻止 lock 移动。

## 6. 兼容性矩阵

每次 EvalScope upstream 升级至少验证：

| 维度 | 必测 |
|---|---|
| Source | commit/license/file manifest/diff classification |
| Capability coverage | capability manifest 双向 coverage、classification、test/evidence、无 orphan/extension inflation |
| Routes | dashboard/tasks/reports/detail/compare/perf/benchmarks/viewer；direct refresh + safe new-tab viewer |
| Forms | 全字段、defaults、validation、payload、focus；text+multimodal autocomplete；`dataset_args` locator admission/raw preservation |
| Task | invoke/progress/log/stop/report/disconnect |
| Refresh | Dashboard/Reports/Performance configured-source Refresh/Rescan、cancel/generation/cache/filter/page/selection reset |
| Report | list/load/dataframe/predictions/analysis/chart/media；threshold、Above/Below、Index/message-ID jump/highlight |
| Sample | chat/reasoning/tool/agent/media/Markdown/math/code |
| Evaluation Compare | URL slots、add/remove、dataset/subset intersection、threshold/per-model filters、presets、pagination/keyboard、parallel errors |
| Performance | catalogue selection；single-run/embedding branches；runs/requests；baseline swap/delta verdict/low-sample/workload mismatch/config diff |
| Benchmarks parity | all/text/multimodal/agent/aigc count/filter/detail/Markdown/Paper，不包含 launch |
| Databench extensions | Benchmark launch preselection、Databench Dataset source 单独验收且不计 parity coverage |
| Dataset | general_qa local path/subset/metadata |
| Files | output tree/report IDs/predictions/reviews/perf DB |
| Runtime | WSGI/concurrency/persistent roots/task claim/stop/reconciliation/restart convergence |
| Databench | refs/inspect/export/run/archive |
| Security | exact proxy drift、active HTML/sandbox/CSP/local Plotly、SSRF/egress、root/media/secret/resource bounds |

任何 matrix 项变化都先更新 source adapter、Zod fixtures、file/capability manifests 和方案兼容说明，
再移动 lock。

## 7. 每步共同验证

按改动比例运行并记录真实结果：

```bash
git diff --check
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm openapi:check
pnpm v2:status:check
pnpm peers check
pnpm offline:check
```

额外要求：

- Catalog/Workspace/Store/API Step：真实 Postgres + MinIO；
- EvalScope Step：pinned reproducible image 和 compatibility tests；
- UI Step：真实浏览器 desktop/narrow/keyboard/a11y/console；
- dependency Step：license、lock、bundle split/size；
- offline Step：真实断网 bundle lifecycle，不接受只做静态 Compose check。

## 8. 计划外变化

下列变化必须先回到 ADR/技术方案评审，不能实施中顺手加入：

- 把功能等价改回 iframe 或第二个 SPA；
- 迁移旧 Gradio UI；
- 删除 capability manifest 中的 upstream 业务能力；
- 新增 EvalScope 通用任务数据库、Databench 执行队列或多实例 scheduler；
- 把 EvalScope engine/metrics/Judge/report generator 重写成 TypeScript；
- 把所有 native Benchmark/perf run 强行纳入 `evaluation_runs_v2`；
- 从 object archive 自动重建 EvalScope online work dir；
- 支持 DPO-as-QA、MCQ、FC、VQA 或任意 mapping script；
- 改变 canonical record/identity/layout；
- EvalScope 直连 Databench DB/object credentials；
- 公网匿名部署或新的公共云平台选择。
