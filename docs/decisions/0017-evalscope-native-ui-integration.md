# ADR 0017 — EvalScope 功能等价 UI 迁移与 Databench 集成

- **状态:** Accepted——owner 于 2026-07-27 确认方案 review 问题修复并要求开始实施；2026-07-28
  确认预构建镜像离线交付口径，并接受 ms-swift S4 的 opaque Model Deployment 扩展；2026-07-29
  接受测评工作区桌面侧栏与窄屏横向导航
- **日期:** 2026-07-27
- **决策者:** owner
- **依赖:** [ADR 0003](0003-storage-postgres-object-store.md)、
  [ADR 0008](0008-object-store-aliyun-oss.md)、
  [ADR 0009](0009-canonical-post-training-record-v2.md)、
  [ADR 0011](0011-identity-hashing-versioning-v2.md)、
  [ADR 0012](0012-offline-single-host-deployment.md)、
  [ADR 0013](0013-v2-product-cutover-and-v1-retirement.md)
- **详细方案:** [EvalScope 集成技术方案](../evalscope/TECHNICAL-DESIGN.md)
- **实施计划:** [EvalScope 集成实施计划](../evalscope/PLAN.md)
- **EvalScope 基线:** `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`

## 背景

Databench 已选定 EvalScope 作为模型评测和性能压测能力。主要诉求是：用户选择 Databench 的
Dataset exact version，使用 EvalScope 的模型配置、执行、指标、Judge、进度、日志、逐样本结果、
报告、比较、性能压测和 Benchmark 目录，同时整个产品只呈现 Databench 的导航、路由、视觉语言和
访问入口。

EvalScope v1.6.1 的 `7860` 页面是 Gradio 报告看板；研究基线上的最新 `main` 已在 2026-05-07
用 React + Vite 替换 Gradio，并把任务、报告、比较、性能和 Benchmark 页面整合进
`evalscope/web`。本 ADR 只针对锁定的 React 基线，不迁移或兼容旧 Gradio UI。

研究基线前端约 21,096 行 TypeScript/TSX、34 个测试文件，技术栈与 Databench 的 React 19、Vite、
Tailwind 4、Zod 和 Lucide 高度兼容。但它带有独立 BrowserRouter、应用壳、主题、国际化、根级 CSS
变量和服务器本地输出路径交互，不能原样作为第二个 SPA 放进 Databench。

EvalScope Flask service 的 API 与 SPA 是可分离的：`/api/v1/eval/*`、`/api/v1/perf/*` 和
`/api/v1/reports/*` 先注册，React `dist` 只是可选静态资源。评测输出、日志和报告主要落在持久化
输出目录，活动进程登记在服务内存；性能压测内部 SQLite 不是统一业务数据库。

## 决策

### 1. 迁移最新 React UI 的全部业务功能，不使用 iframe 嵌入 EvalScope SPA

- 将锁定基线的全部评测业务功能迁入 `apps/web`，成为 Databench 原生路由和代码；
- 不部署第二个用户可见 SPA，不在 iframe 中嵌入 EvalScope SPA，不使用 `postMessage` 拼接双应用壳，也不
  暴露 EvalScope 顶栏；
- HTML report 和 Plotly chart 是生成结果，不是 EvalScope SPA。为保留这两项业务能力，只允许在
  Databench 审查、清洗和重写后进入不含 `allow-same-origin` 的受限 sandbox frame；禁止在 Databench
  origin 顶层打开原始 active HTML；
- “功能等价”以本 ADR 的 capability manifest 为准，要求页面能力、表单字段、操作、错误/空/加载状态、
  逐样本呈现和可访问性行为与锁定基线一致；
- source manifest 只负责文件来源和许可证；另以 capability manifest 逐项记录 route、component、field、
  action、state、default、responsive/a11y behavior、API、Databench target、test 和 browser evidence。文件
  被标记为 `adapted` 不能替代其内部全部 capability 的覆盖证明；
- capability 必须明确分类为 `upstream-parity`、`security-replacement`、`databench-extension` 或
  `brand-shell-exclusion`。只有第一类计入“完整复刻”；安全替代必须保留原用户目的，Databench 扩展不得
  冒充上游原生功能；
- “功能等价”不要求像素复刻。EvalScope Logo、GitHub 入口、独立顶栏、独立主题切换和独立语言切换
  由 Databench Shell 的品牌、导航、主题和国际化替代；
- 任意服务器路径输入不迁入普通产品 UI。报告扫描只读取 operator 配置的受控输出根；Dashboard、Reports
  和 Performance 仍保留用户可见的“重新扫描/刷新”操作、loading/error 状态和原有跨页面 cache/selection
  reset 语义，但不显示或允许编辑绝对路径；
- 不通过复制旧 Gradio 页面填补功能，所有迁移证据只取自锁定的 React 基线。

首期必须达到下列页面能力等价：

```text
Dashboard
Tasks: Evaluation + Performance
Reports list
Report detail: Overview + Details + Predictions
Prediction: chat + reasoning + tool calls + agent trace + media
Evaluation compare
Performance reports + detail + request rows + compare
Benchmark catalogue
Benchmark categories: all + text + multimodal + agent + aigc
HTML report viewer
```

上游所有“在新标签页打开报告”操作必须保留，但目标只能是 Databench
`/evaluations/viewer?document=<opaque-id>` 产品壳；generated document 仍只在该页面的受限 sandbox frame
中加载。禁止新标签页直接导航 raw report/chart HTML。

### 2. Databench 拥有应用壳、路由、样式和前端状态边界

- 所有 Evaluation 页面使用 Databench TanStack Router、主导航、连接状态和 `react-i18next`；
- EvalScope 的 `App.tsx`、`MainLayout`、`TopNav`、BrowserRouter、ThemeContext 和 LocaleContext
  不迁入生产入口；
- 迁移代码置于 `apps/web/src/evaluations/`，禁止 deep import 到临时 clone 或部署镜像；
- EvalScope CSS 不得直接写入 `:root`。专用 token 使用 `--es-*` 并限定在
  `.evaluation-surface`，公共控件优先映射到 Databench primitives；
- Evaluation 路由按页面 lazy load，Markdown、KaTeX、syntax highlighting 和大图表依赖不得无条件
  进入 Databench 首屏 bundle。

### 3. EvalScope 保持独立、无用户界面的 Python 执行服务

- EvalScope 继续负责模型调用、指标、Judge、评测/压测子进程、progress、log、stop、报告生成和报告
  数据 API；
- Databench 不把 EvalScope Python 引擎、Benchmark adapters 或报告解析逻辑重写成 TypeScript；
- production image 固定 upstream commit、Python dependency lock 和 downstream patch digest；
- 生产模式关闭或不暴露 EvalScope SPA 静态 catch-all，只允许网关访问 `/health` 和按 method + exact
  path 评审过的 API；
- 首期仍是单 EvalScope service 实例和持久化输入/输出卷，不宣称多实例调度或服务重启后恢复运行中
  子进程；但必须通过 task-local manifest 在启动时确定性收敛失联任务：有 terminal evidence 时重放
  callback，无活动进程且无 terminal evidence 时以 `provider_interrupted` 失败，不能永久停在
  `prepared`/`running`。

### 4. 浏览器通过 same-origin gateway 使用 EvalScope API

- Databench Web 对自身 REST 继续使用 generated OpenAPI client；
- EvalScope 没有可依赖的 OpenAPI 契约，迁移其 Zod response schemas 和 typed Fetch client，封装为隔离的
  external-service adapter；
- 浏览器只访问 `/evalscope-api` 下按 HTTP method + exact path 评审过的 allowlist；网关默认拒绝其他
  `/api/v1` 路径，不能用 wildcard 自动暴露 upstream 新 endpoint；
- 首期明确阻断上游 `/api/v1/eval/resume/invoke` 和 `/api/v1/reports/scan`：前者不属于当前 UI，后者由
  configured-root 的 `/reports/list` 语义替代；
- 所有 JSON、经过安全转换的 HTML report/Plotly chart 和 media URL 必须由统一 gateway base 构造，禁止
  散落硬编码 `/api/v1`；
- EvalScope service 不直接暴露公网，不依赖 CORS 作为安全边界；网关统一执行环境允许的访问控制、
  超时、body 和并发限制；
- `/api/v1/config` 不得向浏览器返回 output/input root 等绝对路径，只能返回版本、capability、
  `reports_configured` 和不含路径的 generation/digest；
- report/analysis 中的 Markdown 和 HTML 必须清洗；所有报告和图表生成路径只使用镜像内固定版本、
  digest 和许可证的 Plotly 资产，并以 nonce CSP、`nosniff`、精确 content type 和 sandbox frame 隔离；
- Evaluation `api_url` 和 Performance `url` 只允许 operator 配置的 HTTP(S) host/CIDR/port，DNS 初次及
  每次连接、redirect 每一跳都重新校验；metadata、link-local、Unix socket 和非 HTTP(S) scheme 默认
  拒绝，内网或 localhost 模型服务必须由 operator 显式允许并受容器 egress policy 限制；
- 由于 `/invoke` 是 blocking request，production WSGI 和网关必须允许 invoke 与 progress/log polling
  并发，不能让一个长请求阻断状态读取。

Task ID 只负责定位任务，不单独构成幂等保证。EvalScope 必须在启动任何准备或子进程前，以 task ID
原子 claim 一个包含 normalized config digest 的 task-local manifest；同 digest 的 active 重放返回 typed
`already_running`，同 digest 的 terminal 重放返回既有终态，不同 digest 返回 409。stop intent 必须先
持久化再发送信号，所有 manifest 更新必须原子落盘，避免 stop 与 invoke failure callback 竞态或同 ID
覆盖活动进程。

### 5. Databench Dataset 作为原生任务表单中的第一类数据源

- Evaluation 表单保留 EvalScope 内置 Benchmark 模式和全部现有字段；
- 新增 `Databench Dataset` 模式，用户选择 Ref、锁定 exact version、选择 task type 和 target source，
  并在启动前查看 projection eligibility/fidelity；
- 浏览器通过 Databench generated client 读取 Ref/version/inspect，不再在 EvalScope 增加 Dataset list 或
  inspect proxy blueprint；
- 真正执行前，EvalScope 后端仍用 operator 配置的固定 Databench base URL 重新校验 exact version、
  converter options 和 fidelity digest，再流式下载输入；
- 首期新增 `evalscope-general-qa@1.0.0`，对应 `general_qa`，target source 只能显式选择 selected
  candidate、verification ground truth 或无参考答案；
- native Benchmark 的 `dataset_args` JSON 编辑器、默认值、validation 和 payload shape 保留，但这是明确的
  `security-replacement` 边界：服务端递归拒绝路径/目录/URL locator key、绝对/遍历路径、UNC/drive path
  和 URI-like value，不能借任意 JSON 恢复服务器文件或网络访问；拒绝必须返回字段级错误并保留用户原始
  JSON；
- Benchmark catalogue 的 all/text/multimodal/agent/aigc、计数、搜索、tag、分页、详情 Markdown、metadata
  和 Paper 链接属于 `upstream-parity`。从详情进入任务并预选 Benchmark 属于
  `databench-extension`，单独验收，不能作为上游 parity 证据；
- 后续 MCQ、Function Calling 和多模态通过新的 versioned converter 扩展，不按模型品牌创建格式。

### 6. Databench 保存关联与摘要，EvalScope 保存在线结果，对象存储保存完整归档

- `evaluation_runs_v2` 只索引使用 Databench Dataset 的 evaluation run；EvalScope 内置 Benchmark 和
  performance 功能必须完整可用，但首期不强制进入该表；
- 表中保存 exact Dataset version、EvalScope task ID、converter/version/options、benchmark、模型、
  状态、有限指标摘要、provider report locator、错误摘要和 result artifact locator；
- 不保存独立 EvalScope public `report_url`。Databench 根据 run/provider locator 生成自己的
  `/evaluations/*` 路由；
- 样本输入、prediction、完整报告和日志不进入 Postgres；
- 完整结果包通过 attempt-scoped exact staging key 上传，Databench 校验 digest/size 后写入 immutable、
  content-addressed object；
- execution 与 archive 状态分离。归档失败不回滚已完成测评；
- 在线报告继续读取 EvalScope persistent output volume。对象归档首期用于备份和审计，不假装能够直接
  恢复 EvalScope 在线工作目录。

### 7. EvalScope 不直接访问 Databench 底层基础设施

- EvalScope 不连接 Databench Postgres，不读取 internal object key，不持有 OSS/MinIO 长期凭据；
- Dataset export、run transition 和 archive preparation 只通过 Databench REST，REST 只经 Workspace +
  Schema；
- 结果上传只获得有时限、exact-key 的一次性 PUT 能力；cleanup 只能删除记录过的 exact staging key，
  禁止 prefix delete；
- Databench base URL 只来自 operator 配置，不能接受 browser 提交任意 URL、local path 或 storage URL。

### 8. 迁移源码作为受追踪的 Apache-2.0 派生代码维护

- 新增 third-party notice、上游来源清单和 source manifest，记录 commit、原始路径、目标路径、原始
  digest、迁移/排除原因和 Databench 修改类别；
- 保留适用的 Alibaba ModelScope 版权与 Apache-2.0 许可证，修改文件必须能够识别已修改；
- 不迁移或冒用 EvalScope/ModelScope Logo 和商标；
- 不使用 git submodule，也不在构建时拉取浮动 `main`；
- upstream upgrade 必须显式移动 lock，重新生成 source diff，逐项运行 UI/API/file-layout compatibility
  matrix。未通过 parity gate 不得升级生产镜像或迁移源码；
- Databench 可以重构视觉和内部组织，但不得以“风格统一”为由删除 capability manifest
  中的上游业务能力。

### 9. 本集成不改变既有发布声明

- 新增 Python service、前端依赖和 Evaluation 产品面会改变 ADR 0012 离线包的镜像、配置、备份、
  升级、回滚和 lifecycle gate；完成对应 Step 前不得声称离线包已包含 EvalScope；
- 本 ADR 不完成 V16/V17，不解除公共云 D3 决策门，不授权匿名公网部署；
- 只有本 ADR、详细技术方案和实施计划被接受后，才进入 runtime 实施。

### 10. 离线交付以预构建镜像为边界，不要求源码仓库携带 apt/PyPI 镜像

- production image 必须固定 upstream source、base image digest、Python lock、downstream patch 和运行时
  asset digest；联网 fresh build 只能读取这些锁定输入，禁止浮动 `main` 或未锁依赖；
- ADR 0012 离线包交付已经构建并记录 digest 的 EvalScope image；目标机安装、启动、报告查看、升级和
  回滚不得访问公网；
- fresh `docker build --network=none` 不属于 GE3/GE9。仓库不为此提交数百 MB wheelhouse 或 Debian
  mirror；如果未来需要 air-gapped source build，应作为独立发布供应链决策实施；
- 该澄清不放宽运行时断网、固定本地 Plotly、许可证、image digest、离线 bundle lifecycle 或目标机
  无外部 DNS/HTTP 请求的要求。

### 11. Model source 与 Dataset source 独立，Databench Deployment 只以 opaque ID 进入浏览器契约

- Evaluation 表单的 Dataset source 与 Model source 是两个独立维度。Dataset 继续支持原生 Benchmark 和
  Databench exact Dataset；Model 继续支持手工 endpoint，并新增 Databench Model Deployment；
- 浏览器选择 Databench Deployment 时只提交 `databench_deployment_id`，不得同时提交 `model`、
  `api_url` 或 `api_key`。EvalScope 通过固定 Databench base URL 和 service credential 调用 internal
  resolver，在服务端取得 served model 与 endpoint；
- internal resolver 不进入 OpenAPI，也不复用 operator credential。operator 与 service credential
  配置为相同值时启动配置必须 fail closed；
- Deployment resolver 只接受 `active` Deployment。`disabled` 后的新 task/new Evaluation Run admission
  必须稳定拒绝；已经原子 claim 的 terminal replay 和既有 Evaluation Run 仍按原 identity 重放，不依赖
  当前 endpoint、磁盘容量或 Deployment 生命周期；
- 只有 `Databench Dataset + Databench Deployment` 组合创建 `evaluation_runs_v2`，并保存 exact Dataset、
  Deployment、Artifact 与 Deployment create digest。`Benchmark + Databench Deployment` 保留为
  source-less expert/untracked 模式：可执行 EvalScope task，但不创建 Databench Evaluation Run，也不得
  展示成完整 Databench lineage；
- resolved endpoint 只存在于受控服务端执行 payload 和短期内存脱敏上下文，不进入浏览器 response、
  task integration manifest、report HTML、日志或公开 Model Deployment projection；
- 本扩展不改变 E8/E9、V16/V17 或公共云 D3 状态，也不证明 GPU 训练或 GPU inference/deployment。

### 12. 测评工作区使用响应式二级侧栏

- 全局一级导航中的测评入口保持稳定；`/training` 合入后与数据集、测评并列，不改变测评内部结构；
- `/evaluations/*` 在桌面使用“看板 / 报告 / 性能 / 任务 / 基准测试”左侧栏，窄屏退化为同五项
  可横向滚动的二级导航；
- 报告详情、性能详情、比较和 Viewer 沿用现有父级选中语义，不改变任何 URL、route search contract、
  API、capability 或安全边界；
- Evaluation 页面继续 route-level lazy load，不把完整测评词典、图表或富内容依赖拉入数据集首屏。

## 非目标

- 迁移或继续维护 v1.6.1 Gradio UI；
- 像素级复刻 EvalScope 品牌、顶栏或主题；
- 把 EvalScope Python 执行、指标、Judge、Benchmark adapter 或报告生成器重写进 Databench；
- 首期把所有 EvalScope 原生 Benchmark/performance run 复制到 Databench Postgres；
- 首期支持所有 Databench record 形态或把 DPO preference 强行解释为 QA reference；
- 把逐样本输入输出写入 Postgres；
- 让 EvalScope 直连 Databench DB/object credentials；
- 首期实现完整多实例 scheduler、task lease 或恢复运行中的子进程；单实例启动扫描、terminal callback
  重放、失联任务 `provider_interrupted` 收敛和 operator 手动 reconcile 仍属于必需正确性边界；
- 因 UI 迁移修改 canonical identity、record schema、layout 或 Dataset version 公式。

## 后果

- **+** 用户只面对 Databench，一套导航、路由、视觉、语言和访问控制覆盖完整测评功能；
- **+** 最新 EvalScope 的任务、报告、逐样本、比较、性能和 Benchmark 能力得到保留；
- **+** Databench Dataset exact version、projection 和结果摘要进入持久化审计边界；
- **+** EvalScope 后端 patch 比 iframe 方案中的前后端双 patch 更小；
- **+** same-origin gateway 和原生页面消除 SPA iframe、跨域、双登录和双应用壳问题；生成报告只在
  单独的无 same-origin sandbox 安全边界中显示；
- **−** Databench 成为约 2.1 万行迁移 UI 的长期 owner，必须承担 parity、依赖和 upstream merge 成本；
- **−** 视觉重构和功能迁移必须分阶段完成，不能通过一次机械复制获得可信功能等价；
- **−** EvalScope external API 没有正式 OpenAPI，需要维护 pinned Zod contract fixtures；
- **−** 首期仍依赖 EvalScope persistent volume 和单实例进程状态；
- **−** 新服务和前端依赖会扩大离线包、bundle、安全、容量和升级 gate。
