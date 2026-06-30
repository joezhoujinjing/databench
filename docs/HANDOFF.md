# databench-ts 实现交接文档

> 交给**实现 agent**(goal 模式)。设计、技术选型、目录、规范、逐功能清单、执行计划**都已完成且锁定**——你的任务是**实现**,不是重新规划。不要推翻已定决策(要变先改对应 ADR 并说明)。

## 0. 一句话目标
在 `~/Desktop/databench-ts/` 把 databench(LLM post-training 数据基础设施)**完整重写为 TS monorepo(后端 + 前端)**,达到与旧 Python 实现的 **parity**,按 `docs/migration/PLAN.md` 逐步交付。

## 1. 现状(你接手时)
- **S0.1-S21 已完成,M5 parity & 切换收尾完成;D1 已由 owner 改为实现 vocabularies,S19 已补齐。** 进度以 `docs/migration/STATUS.md` 为准。
- 后端核心、Hono API、确定性 `openapi.json`、React/Vite 前端主流程、S20 新旧端到端 parity 均已落地并过闸门。词表域已按最新旧后端 + 旧 UI 语义迁入,入口由 `features.vocabularies:true` 开启。
- 下一步是 **D3 API 托管平台决策**;owner 拍板前不得进入 S22 部署/平台选择。旧实现 `~/Desktop/databench/`:Python 后端(`databench/`)+ 旧前端(`databench-ui/`)。**只读参考 + golden 源,默认保留,严禁修改。**

## 2. 必读(按此顺序)
1. **`/AGENTS.md`** — 总纲(规则 + 已锁决策 + do/don't)。
2. **`docs/migration/PLAN.md`** — 执行计划(M0..M6 / S0..S22 / 闸门 / 决策门)→ **你照它一步步走**。
3. `docs/project-structure.md` + `docs/directory-layout.md` — 包边界(依赖 DAG)+ **每个文件落点**。
4. `docs/conventions.md` — 命名 / ESM / **确定性纪律** / 错误映射 / 测试 / env。
5. `docs/migration/feature-inventory.md` + `inventory-domain.md` + `inventory-service.md` — 后端逐功能 + **18 条易漏点** + 契约对账。
6. `docs/migration/frontend-inventory.md`(+ `_frontend-pages.md`/`_frontend-shell.md`)— 前端逐功能 + 118 i18n key。
7. `docs/decisions/0001..0006` — 决策依据(可行性 / Hono / 存储 / 工具链 / 基础设施 / 前端栈)。

## 3. 执行方式(硬性)
- **严格按 `STATUS.md` 的当前进度继续执行 `PLAN.md`;一个 Step ≈ 一个 PR;过该 Step 的闸门(`G*`/`FG*`)才进下一步。** 不要重做已完成 Step,除非当前 gate 暴露回归。
- 每步对拍 **golden**(`~/Desktop/databench/databench/bench/` 的 catalog.db + store);M5 端到端新旧 parity 已由 S20 覆盖。
- **Conventional Commits**(scope=包名);Biome;CI 全绿(lint/typecheck/vitest/golden/`openapi:check`)。
- 落代码前对照 `directory-layout.md` 的文件落点 + `conventions.md`。

## 4. 绝对红线(违反 = 返工,细节见 AGENTS.md「硬规则」)
1. **依赖 DAG**:`hashing←schema←{engine,io,catalog}←{ops,store}←workspace←apps/api`;**apps/api 只经 workspace+schema**;catalog 只依赖 Prisma;hashing/schema 保持纯;禁深 import。
2. **确定性**(后端对拍命门):哈希输入**只走** `@databench/hashing.canonicalJson`,**禁裸 `JSON.stringify`**;blake3 固定;序列化**保留 null**;`bankersRound`(非 `Math.round`);`weight || 1.0`;空集 version=`hashText("empty")`。
3. **契约优先**:wire 类型只在 `@databench/schema`(zod)定义一次 → `@hono/zod-openapi` 出 `openapi.json` → `openapi-typescript` 生成前端 client;**不手写 API 类型**(除前端 `ApiError`)。
4. **样本数据绝不进 Postgres**(Parquet 在对象存储;PG 只存 catalog 元数据)。
5. **绝不修改旧仓库 `~/Desktop/databench/`**。

## 5. 决策门(用默认值推进,除非 owner 另行指示)
| 门 | 默认 | 行动 |
|---|---|---|
| **D1 vocabularies** | **已实现** | 后端 `capabilities.vocabularies:true`;前端 FE-5 词表列表/派生/新建/详情已接入;后续不得无决策移除或重新 gated false。 |
| **D2 export TRL/fmt** | **照搬等价** | 不实现 TRL 分支,`fmt` 忽略(与旧后端一致)。 |
| **D3 API 托管平台** | **未定** | **M6 部署前必须暂停,向 owner 请示**(长驻容器;GCP 候选 Cloud Run)。 |

## 6. 环境 / 运行(关键 gotcha)
- Node 22(`.nvmrc`);pnpm;`docker compose up -d` 起 `postgres` + `minio`(S0.2 建)。
- **若需运行旧 Python 后端做 parity**:本机是 Rosetta x86-64 Python,**polars 会 SIGILL(exit 132),除非装 `polars[rtcompat]`;用 `.venv/bin/uvicorn` 启动,别用 `uv run`**。
  - S20 已通过 `apps/api/test/parity.golden.test.ts` 证明 `.venv/bin/uvicorn databench.service.app:create_app --factory` 可用于新旧并跑;多数包级 parity 仍可直接用**静态** golden(`bench/` 的 catalog.db + store),不必跑 Python。
- golden 源路径:`~/Desktop/databench/databench/bench/`(catalog.db + store/objects);旧 UI 功能参考:`~/Desktop/databench/databench-ui/`。

## 7. 关键风险
- **M1 采样确定性 spike 已解除**:S1 证明 positional sampling API 与 Python Polars 同 seed 对拍通过;不要改回直接 `frame.sample({n,seed})` 路径。
- 后端「最易翻车」18 条见 `inventory-domain.md` 结尾;前端风险见 `frontend-inventory.md`「关键清单」(vocab gated、lineage query→path 且升级 React Flow、error envelope 手写 ApiError 等)。

## 8. Definition of Done
- **当前已达成**:`S0..S21` 完成;S19 vocabularies 已补齐;所有已进入的 `G*`/`FG*` 闸门绿;**`G-parity` 通过**(新旧端到端 dataset version / lineage / export / 分页 等价);前端与旧 UI 主流程 parity。
- **剩余 DoD**:M6/S22 在 D3 拍板后完成;若 D3 未定,停在 M5 完成态,不得擅自选择部署平台。

## 9. 检查点协议(goal 模式)
- **里程碑内自治**:按步实现、跑闸门、修失败、逐步提交,不必逐步请示。
- **暂停并向 owner 请示/汇报**,当:① 要**偏离决策门默认**;② **闸门反复失败且无既定回退**;③ **每个里程碑(M*)完成时**——给一页状态报告供 review;④ **M6 部署前(D3)**。
- **进度跟踪**:勾选 `PLAN.md` / 两份 inventory 的勾选框,并维护 `docs/migration/STATUS.md`(每步:状态 + PR + 闸门结果 + 备注)。

---

## 10. 续跑提示词(复制给实现 agent / goal 模式)

```
GOAL:在 ~/Desktop/databench-ts 完成 databench 的完整 TS-monorepo 重写(后端 + 前端),
达到与旧 Python 实现的 parity,按 docs/migration/PLAN.md 逐步交付。

你是实现 agent。设计/选型/目录/规范/逐功能清单/执行计划都已完成且锁定——
你的任务是实现,不是重新规划;不要推翻已定决策(要变先改对应 ADR)。

开始前必读(按序):
  1. ~/Desktop/databench-ts/AGENTS.md            (总纲:规则 + 已锁决策 + do/don't)
  2. ~/Desktop/databench-ts/docs/HANDOFF.md       (交接:现状/红线/决策门默认/环境 gotcha/DoD/检查点)
  3. ~/Desktop/databench-ts/docs/migration/PLAN.md(执行计划:M0..M6 / S0..S22 / 闸门 / 决策门)
  4. ~/Desktop/databench-ts/docs/migration/STATUS.md(当前进度;以它判断下一步)
  其余按 AGENTS.md「先读这些」深入。

执行规则:
  - 先看 STATUS.md,不要重做已完成 Step;从下一个未完成 Step 继续。
  - 当前 S0.1-S21 已完成;S19 vocabularies 已按 owner 新 D1 决策实现;S20 G-parity 已通过。
  - M6/S22 前必须先停下来询问 D3 API 托管平台,不要擅自决定 Cloud Run/GKE/Fly/Railway/ECS。
  - 遵守红线:依赖 DAG(apps/api 只经 workspace)、确定性纪律(canonicalJson-only/blake3/保留 null/
    bankersRound/weight||1.0)、契约优先(zod→openapi→openapi-typescript,不手写 API 类型)、样本不进 PG。
  - 决策门:D1 vocabularies 已实现(capabilities.vocabularies:true)、D2 TRL 照搬等价;
    D3 API 托管在 M6 部署前停下来问我。
  - Conventional Commits;Biome;CI 绿;绝不修改旧仓库 ~/Desktop/databench。

成功标准(DoD):S0..S22 完成、所有闸门绿、G-parity 通过、前端与旧 UI 已实现功能 parity;M6 部署待 D3。

检查点:里程碑内自治推进;在 (a) 要偏离决策门默认、(b) 闸门反复失败无既定回退、
(c) 每个里程碑(M*)完成、(d) M6 部署前,停下来向我汇报/请示。每个里程碑结束给一页状态报告,
并维护 docs/migration/STATUS.md。

现在开始:读完上述文档后,重新检查 git/worktree 与 STATUS.md;若下一步是 D3/S22,先向 owner 索要
API 托管平台决策,不要直接部署。
```
