# databench-ts 维护交接文档

> 交给后续维护 agent。重写与 parity 主线已经完成;你的任务是按当前代码结构维护、扩展、修复和验证,不是重新执行迁移计划。任何结构/契约/平台决策变化都要同步更新对应文档或 ADR。

## 0. 一句话目标
在 `~/Desktop/databench-ts/` 维护已落地的 all-TypeScript databench monorepo,保持 API/UI/CLI 三个表面共享同一 `Workspace` 核心,并持续守住确定性、契约单源和依赖 DAG。

## 1. 当前状态
- 代码库处于维护/扩展期;历史迁移与扩展进度见 `docs/migration/STATUS.md`。
- `apps/api`、`apps/web`、`apps/cli` 已是当前长期表面,新增能力要按当前边界接入。
- 旧实现 `~/Desktop/databench/` 是只读参考 + golden 源,不得修改。

## 2. 必读(按任务选择)
1. **`/AGENTS.md`** — 当前总纲、防漂移硬规则、已锁决策。
2. **`docs/project-structure.md` + `docs/directory-layout.md`** — app/package 边界、依赖 DAG、文件落点。
3. **`docs/conventions.md`** — 命名、ESM、确定性、错误、契约、测试、env。
4. **`docs/architecture.md`** — 当前系统形态、控制面/数据面、Python boundary。
5. **相关 ADR**:
   - API/Hono:`docs/decisions/0002-http-framework.md`
   - 存储/部署:`0003`、`0005`
   - 前端:`0006`
   - CLI:`0007`
6. **行为 parity / golden 相关**:`docs/migration/*` 与 `docs/spikes/s1-determinism.md`。这些是历史证据和回归合同,不是待重做的任务清单。
7. **部署相关**:`docs/deployment/README.md`;历史平台比较见 `docs/migration/d3-api-hosting-brief.md`,使用前要按当前 OSS/阿里云上下文刷新。

## 3. 当前 app/package 边界
```
apps/api  -> @databench/workspace + @databench/schema
apps/cli  -> @databench/workspace + @databench/schema
apps/web  -> generated OpenAPI client only
tooling/openapi-export -> apps/api

packages/hashing <- schema <- {engine,io,catalog} <- {ops,store} <- workspace
```

`apps/api` 与 `apps/cli` 是两个薄适配器。新增业务能力应先进入核心包/`workspace`,再分别接 API、CLI、Web。不要在 app 层复制业务逻辑。

## 4. 绝对红线
1. **依赖 DAG**:禁止 `apps/api` / `apps/cli` 直连 `store`、`catalog`、`engine`、`ops`、`io`;禁止 `apps/web` import 后端包;禁止深 import。
2. **确定性**:哈希输入只走 `canonicalJson`;blake3 固定;保留 null;recipe 用 `bankersRound`;权重语义 `weight || 1.0`;空集 version=`hashText("empty")`。
3. **契约单源**:wire 类型在 `@databench/schema` 定义;OpenAPI 由 API 导出;Web 由 `openapi-typescript` 生成;CLI 复用同源 schema 和错误分类。
4. **错误边界**:域层抛类型化领域错误;API 映射 HTTP envelope;CLI 映射 stderr envelope + exit code。
5. **存储边界**:样本数据不进 Postgres;Parquet/Vocabulary blob 在对象存储;PG 只存 catalog 元数据。
6. **旧仓库只读**:不得修改 `~/Desktop/databench/`。

## 5. 环境 / 运行 gotcha
- Node 22(`.nvmrc`);pnpm;`docker compose up -d` 起 Postgres。
- Aliyun OSS 没有本地 emulator;本地真实数据读写需要 `OSS_*` 凭据,测试优先注入内存 store。
- 本机 Postgres 映射可能不是默认 5432;以 `.env.example` / 当前 `.env` 为准。
- 若必须启动旧 Python 做 parity:本机历史上 Rosetta x86-64 Python + polars 可能 SIGILL(exit 132),需要 `polars[rtcompat]`;优先使用现有 TS golden/parity 测试,不要轻易改旧仓库。
- golden 源路径:`~/Desktop/databench/databench/bench/`。

## 6. 验证策略
- 局部改动:跑对应 package/app 的 `test` + `typecheck`。
- 跨包、schema、workspace、API/CLI 适配器改动:至少跑 `pnpm lint`、`pnpm typecheck`、相关 `pnpm --filter ... test`。
- 改契约:跑 `pnpm openapi:check`,并确认 Web generated client 同步。
- 改确定性/id/version/cache/export/lineage:跑相关 golden/parity 测试。
- 改前端:跑 `pnpm --filter @databench/web test`、`typecheck`、必要时 `build` 和浏览器 smoke。
- 改 CLI:跑 `pnpm --filter @databench/cli test`;涉及 shared error/capability/extractor 时也跑 API 相关测试。

## 7. 检查点协议
- 普通 feature/fix 可以自治推进,但必须报告改动范围和验证结果。
- 需要暂停请示:偏离已锁 ADR、改变依赖 DAG、改变 deterministic contract、改变对外 API/CLI 语义、进入部署实施、或连续 gate 失败且没有明确回退。
- 每次改变代码结构、命令表面、能力位、错误/契约语义,同步更新 `AGENTS.md`、相关 README/ADR/结构文档。
