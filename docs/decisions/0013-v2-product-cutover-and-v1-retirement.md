# ADR 0013 — v2 产品切换与 v1 退役

- **状态:** Accepted——owner 于 2026-07-24 确认采用第三版单层导航视觉稿与本文退役边界；
  2026-07-25 接受产品文案去技术化修订；2026-07-29 在测评成为产品面后接受数据集侧栏
  与铜橙主题修订
- **日期:** 2026-07-24
- **决策者:** owner
- **依赖:** [ADR 0009](0009-canonical-post-training-record-v2.md)、
  [ADR 0011](0011-identity-hashing-versioning-v2.md)、
  [v2 产品切换技术方案](../v2/PRODUCT-CUTOVER-TECHNICAL-DESIGN.md)
- **接受后取代:** `docs/v2/TECHNICAL-DESIGN.md` 的 T1、T15、T16、Q7、Q9，
  以及 `docs/v2/PLAN.md` 中要求 v1 API、CLI、Web 与测试长期共存的条款

## 背景

ADR 0009、ADR 0011 与现有 v2 技术方案采用了“加法式共存”路线：v1 继续作为默认产品，
v2 通过独立 `/v2` API、`databench v2` CLI、`/v2/...` Web 路由和 capability gate 逐步上线。
该路线已经完成 V0-V15，并成功验证了 v2 的完整纵向链路。

共存路线达到验证目的后，产品出现了两套并列入口：默认无版本 Web 路由仍指向 v1，v2
又在同一 SPA 中增加一层独立导航。用户必须理解“v1 页面”和“v2 页面”的区别，才能进入
当前真正要使用的数据模型。这不再符合产品目标。

Owner 于 2026-07-24 明确决定：**v2 直接替代 v1，v1 不再作为产品或兼容面保留。**
Recipe 与 Vocabularies 目前只有 v1 实现，owner 同意随 v1 退役，不要求先迁入 v2。

## 决策

### 1. v2 成为唯一产品语义

- Web 不再提供版本选择、v1/v2 切换或并列入口；
- 用户可见文案不再出现实施期的 `V2`、`V2 / refs` 或“v2 数据集”；
- 默认数据集、导入、转换、记录、血缘和导出全部使用现有 v2 语义；
- Recipe 与 Vocabularies 入口、API、CLI 和领域实现退役，不在切换中补做 v2 版本；
- 旧只读参考仓库 `~/Desktop/databench/` 继续保留且不得修改，它不是运行时兼容面。

### 2. 产品路由无版本，协议路由继续版本化

Web 使用无版本产品路由：

```text
/datasets
/datasets/:ref
/datasets/:ref/records/:recordId
/ingest
/transforms
/lineage/:ref
/export/:ref
```

REST API 继续使用 `/v2`。`/v2` 表示 wire contract 与 canonical data profile 的版本，
不是产品中仍存在 v1。保留它可以避免无收益的大规模协议改名，并为未来 API 演进保留边界。

现有 `/v2/...` Web URL 不作为长期别名保留。浏览器路由和 REST API 共用 `/v2` 前缀会在
反向代理与直接刷新时产生不可可靠消除的歧义；切换后 `/v2` 前缀专属于 API。

### 3. UI 只保留一个导航层级

桌面应用壳的主导航固定为：

```text
数据集    导入    转换
```

血缘与导出依赖一个已解析的数据集，作为数据集详情的上下文动作，不进入一级导航。
语言与连接设置属于全局工具，保留在右侧。现有 v2 页面顶部的第二层导航被提升为唯一主导航，
不再与 v1 主导航叠加。

### 4. 内部 v2 命名不做无意义重写

以下名称继续保留：

- `/v2` API；
- `objects/v2/` 对象前缀；
- `*_v2` Postgres 表名；
- `V2Workspace`、`V2Dataset`、`RecordRevisionV2` 等内部类型；
- `apps/web/src/v2/` 与 query key 中的 `v2` 协议边界。

这些名称保护已经发布的 identity、layout、对象 key、数据库 migration 与 generated contract，
不构成用户可见的双版本产品。把它们改成无版本名称只会制造高风险机械 churn，不属于本次目标。

### 5. CLI 默认命令切换到 v2 语义

- 现有无版本 v1 命令退役；
- `databench dataset|converter|transform|ref|lineage ...` 成为当前 v2 命令的默认入口；
- `databench v2 ...` 可保留一个发布周期作为不出现在主 help 中的兼容别名；
- 兼容别名只复用同一 v2 handler，不保留任何 v1 实现。

### 6. v1 持久化数据通过显式退役动作清理

代码切换不得在应用启动、普通 migration 或首次请求时静默删除 v1 数据。

- 新安装最终只建立 v2 当前态；历史 migration 文件保留，避免破坏 Prisma migration history；
- 已有安装先停止 v1 读写，再通过独立 preflight 列出 v1 表行数与对象 key/bytes；
- Postgres v1 tables 使用一条显式 forward migration 删除；
- v1 object keys 使用独立 maintenance 命令删除，并必须证明不会匹配 `objects/v2/`；
- 实际删除前生成可审计清单并要求 operator 显式确认；不自动迁移或映射 v1 数据到 v2。

### 7. 退役不能删除仍保护 v2 的测试

v1 Python parity 与 v1 wire/UI golden 可以删除，但以下覆盖必须先由 v2 gate 接任：

- package DAG 与禁止深 import；
- BLAKE3/JCS identity fixed vectors；
- Postgres 不保存 record payload；
- conditional object create 与 manifest commit；
- ref CAS、exact lineage、fidelity export；
- 浏览器完整生命周期、直接刷新、连接身份隔离和离线部署 smoke。

## 非目标

- 不把 v1 数据自动转换成 `PostTrainingRecord 2.0.0`；
- 不恢复 Recipe 或 Vocabularies 的 v2 实现；
- 不重命名 v2 identity profile、record schema、layout、object keys 或数据库表；
- 不在本决策中选择 D3 公共云 API 托管平台；
- 不宣称尚未执行的 V16/GV16 或 V17/GV-final 已完成。

## 后果

- **+** 用户只看到一套产品和一套数据模型；
- **+** 截图中的“数据集 / 导入 / 转换”成为稳定主导航，不再叠加版本导航；
- **+** API、存储与 identity 的 v2 稳定边界保持不变；
- **−** `/v1` API、v1 CLI、Recipe、Vocabularies 和旧 Web bookmark 是明确 breaking change；
- **−** 已有 v1 数据不会自动出现在新产品中；需要时必须在退役前自行导出；
- **−** v1 数据清理是不可逆 operator 动作，必须独立于代码切换验证和执行；
- **−** 当前已接受的 v2 技术方案与实施计划需要在本 ADR 接受后做规范性修订。

## 接受记录

Owner 于 2026-07-24 采用第三版视觉稿，并确认基于当前最新 `main` 实施。以下接受门均已满足：

1. 一级导航只保留“数据集 / 导入 / 转换”；
2. 血缘与导出只作为数据集上下文动作；
3. 列表页删除 `V2 / refs`，保留四列数据表语义；2026-07-25 的 owner 修订将用户可见
   “引用 / 精确版本”改为“数据集名称 / 版本 ID”，wire contract、API 与内部 Ref 命名不变；
4. Recipe 与 Vocabularies 确认直接退役；
5. `/v2` 保留为 API/存储内部版本边界，但不再出现在产品 UI。

## 2026-07-25 产品文案修订

Owner 接受全站产品文案清单，补充决定：

1. 列表页标题由“训练后数据集”改为“数据集”；自解释页面不再显示顶部说明文字；
2. 用户界面以“数据集名称 / 版本 ID”表达 Ref 与 exact version，冲突、防覆盖和完整性提示
   继续保留，但不显示 CAS、canonical、fidelity、deterministic 等实现术语；
3. 记录详情不再把完整 record ID 作为页面标题，ID 继续在基本信息中完整展示；
4. 本修订只影响 Web 产品文案与展示层，不重命名 `/v2` API、Ref wire fields、identity、layout、
   object keys、数据库表或内部 `V2*` 类型。

## 2026-07-29 产品导航与主题修订

在 `/evaluations/*` 成为独立产品面后，owner 接受新的信息架构。本节取代本文
“UI 只保留一个导航层级”中对当前导航形态的限制，但不重新打开已经完成的 v1 退役决策：

1. 全局一级导航固定为“数据集 / 测评”；
2. `/datasets*`、`/lineage/*`、`/export/*`、`/ingest` 与 `/transforms` 都属于数据集工作区，
   一级“数据集”在这些路径持续选中；
3. 数据集工作区在桌面使用“数据集列表 / 导入 / 转换”左侧栏；测评工作区在桌面使用
   “看板 / 报告 / 性能 / 任务 / 基准测试”左侧栏；两者在窄屏分别退化为同组横向导航；
4. 数据集详情、记录、血缘与导出继续选中“数据集列表”，不增加没有上下文的独立入口；
5. 全站交互强调色由紫色改为铜橙，主题基线为 `#f08a3c`；警告语义改用偏黄的
   `#f4c95d`，避免主动作与告警混淆；
6. 本修订不改变任何 Web URL、REST/OpenAPI、CLI、identity、layout、对象或数据库契约。

## 2026-08-03 数据集列表桌面修订

Owner 接受按现有产品能力优化数据集列表，不增加筛选、排序、统计或其他业务功能：

1. 数据集工作区去掉侧栏左侧的壳级空 gutter；桌面侧栏展开宽度收紧为约 184px，并可收起为
   约 52px 的图标栏，导入与转换入口继续可达；窄屏仍沿用既有横向导航；
2. 列表页签使用“全部 / 回收站”，不再把所有未删除 Ref 表达为业务状态“使用中”；
3. 列表按桌面 viewport 高度每页显示 8/10/12 条，1366×768 首屏须看到分页，高屏同时提高信息
   密度；分页继续是已加载结果上的本地视图，不改变现有后端 cursor 分页；
4. 四列列表改用语义化 table；记录数右对齐，时间固定显示为 `YYYY-MM-DD HH:mm`，完整源值保留
   在可访问属性中；行 hover 只使用轻背景，不能遮挡记录数；
5. Ref message 不在列表中显示，但 wire contract、后端数据和其他产品语义保持不变；
6. 搜索后显示匹配数量与已加载总量，无匹配结果使用独立空状态；页签支持完整方向键、Home/End
   导航；
7. 本修订不改变 Web URL、REST/OpenAPI、CLI、identity、layout、对象或数据库契约。
