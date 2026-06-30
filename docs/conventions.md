# 编码规范(权威)

> 配套 [`project-structure.md`](project-structure.md)。这些规则进 Biome / tsconfig / CI,**机器能强制的尽量机器强制**,以防迁移漂移。

## 1. 命名

| 对象 | 约定 | 例 |
|---|---|---|
| 包 | `@databench/<kebab>`,目录 `packages/<kebab>` | `@databench/workspace` |
| 文件/目录 | kebab-case `.ts` | `row-digest.ts`、`filter-by-signal.ts` |
| 类型/接口/类 | PascalCase | `Sample`、`Manifest`、`Workspace` |
| 变量/函数 | camelCase | `canonicalJson`、`hashUnordered` |
| 常量 | UPPER_SNAKE | `SCHEMA_VERSION`、`MAX_PAGE_LIMIT` |
| zod schema | `XxxSchema` + 推导 `type Xxx = z.infer<typeof XxxSchema>` | `SampleSchema` → `Sample` |
| 错误码(对外) | snake_case 字符串,集中枚举 | `not_found`、`validation_error` |
| DB 表 | snake_case 复数(沿用 Python) | `datasets`、`runs`、`refs` |
| DB 列 | snake_case(沿用 Python,保数据兼容) | `row_digest`、`output_version`、`cache_key` |
| Prisma model | PascalCase + `@@map`/`@map` 映射到 snake 表/列;TS 字段 camelCase | `model Run { outputVersion String @map("output_version") }` |
| REST 路由 | **逐字沿用 Python**(契约对拍) | `/v1/datasets:ingest-jsonl` |
| HTTP 头/env | env 用 UPPER_SNAKE | `DATABASE_URL` |

## 2. TypeScript / 模块

- 纯 **ESM**;相对 import 不写扩展名(tsup/bundler 解析);**禁止 default export**,一律具名导出。
- 外部只 import 包的 `index.ts`;**禁止深 import**(package.json `exports` 仅暴露 `"."`)。
- `tsconfig.base.json` 基线(全包继承):
  ```jsonc
  {
    "compilerOptions": {
      "target": "ES2023", "module": "ESNext", "moduleResolution": "Bundler",
      "strict": true,
      "noUncheckedIndexedAccess": true,
      "exactOptionalPropertyTypes": true,   // ← 关键:逼出 null vs undefined 区分(CORE-06)
      "verbatimModuleSyntax": true,
      "isolatedModules": true, "skipLibCheck": true, "declaration": true
    }
  }
  ```
- `exactOptionalPropertyTypes` + 显式 `| null` 是**刻意的**:Python `content_dict` 保留 `null`,TS 不能用 `undefined` 糊弄(否则 id/version 全错)。

## 3. 确定性纪律(直接关系 golden 闸门,**最高优先级**)

迁移最大风险是「算出来的 id/version/cache_key 和 Python 对不上」。以下为硬约定:

- **凡参与哈希的序列化,只能走 `@databench/hashing` 的 `canonicalJson`**;**任何地方都不许用裸 `JSON.stringify` 做哈希输入**(它不排序键、丢 `undefined`、对 `Date`/`BigInt` 行为不对)。Biome 加自定义/约定禁止在 `hashing` 外手写哈希。
- **blake3 固定**,不实现 blake2b 回退(既有 store 全 blake3)。
- **银行家舍入**(half-to-even)用 `@databench/engine` 暴露的 `bankersRound`,**禁止裸 `Math.round`** 于 recipe 计数(`RECIPE-05`)。
- 权重退化:`weight || 1.0`(0→1.0),**不要用 `?? 1.0`**(`RECIPE-05`)。
- 空数据集 version = `hashText("empty")`,不是 `hashUnordered([])`(`DATASET-04`)。
- `word_len` 复刻 Python `str.split()`:`text.trim().split(/\s+/).filter(Boolean).length`,空文本→0(`OPS-04`)。
- 采样确定性以 **G5 闸门**为准;若 nodejs-polars 与 Python 不一致,采样统一改走 DuckDB `REPEATABLE(seed)`(决策记进 ADR)。

每条确定性约定**必须有对应 golden 测试**(见 §6)。

## 4. 错误处理(域 → HTTP 的统一映射)

- **域层(packages/\*)抛类型化领域错误**,不抛裸字符串、不抛 HTTP 概念:
  `NotFoundError`、`BadInputError`、`ValidationError`(从 zod issue 构造)、`ConflictError`。定义在 `@databench/schema`(或 `@databench/errors` 小包)。
- **只有 `apps/api` 知道 HTTP**:用一个错误中间件把领域错误 + zod 错误映射成统一信封(`ERR-01..06`):
  ```jsonc
  { "error": { "code": "not_found", "message": "...", "detail": [/* 可选 */] } }
  ```
  映射表:zod/请求校验→422 `validation_error`;`NotFoundError`/缺失→404 `not_found`;`BadInputError`/解析失败→400 `bad_request`;无参 transform 传参/返回类型错→400;**补一个兜底 `Exception`→500 `internal_error` 信封**(Python 当前缺,迁移补上)。
- `ErrorResponse` 必须**进 OpenAPI**(`@hono/zod-openapi` 注册),修正旧契约缺失(见迁移清单「决策 #3」)。

## 5. 契约单一来源(zod → OpenAPI → 前端)

- 所有 wire 类型(Sample 判别联合、Manifest、各 Page/Request、ErrorResponse)**只在 `@databench/schema` 用 zod 定义一次**;运行时校验、OpenAPI、TS 类型同源。
- `apps/api` 用 `@hono/zod-openapi` 注册路由与 schema;`tooling/openapi-export` 导出**确定性** `openapi.json`(sorted keys / indent 2 / 末尾 newline),CI `--check`。
- `apps/web` 只用 `openapi-typescript` 生成 client,**不手写 API 类型、不 import 后端包**。

## 6. 测试

- **Vitest**;单测与源码 colocate 或放 `test/`;命名 `*.test.ts`。
- **Golden 对拍**放 `packages/<x>/test/golden/`,fixtures 取自现有 Python `bench/`(catalog.db + store/objects);命名 `*.golden.test.ts`。
- **每个功能的「验收点」(见迁移清单 inventory)→ 一个测试**;**每条 G 闸门 → CI 必过的 golden 测试**(G1 canonicalJson 逐字节、G2 content_dict null、G3 空集 version、G5 采样确定性、G7 三 upsert、G8 cache_key/银行家舍入、G10 错误信封、G11 全生命周期、G12 openapi 稳定)。
- 阶段验收:该阶段所有功能测试 + 该阶段 G 闸门全绿,才进下一阶段。

## 7. 配置 / 环境变量(契约)

`.env.example` 列全;读取集中在各 app 的 `config.ts`(zod 校验环境变量,缺失即启动失败):

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | Supabase Postgres(本地指向 docker pg) |
| `S3_ENDPOINT` | 对象存储 endpoint(GCS S3 互操作 / 本地 MinIO) |
| `S3_REGION` `S3_BUCKET` | bucket 与区域 |
| `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` | GCS HMAC / MinIO 凭据 |
| `DATABENCH_CORS_ORIGINS` | 逗号分隔精确 allowlist(`SVC-02`) |
| `PORT` | API 端口 |

- **绝不**把密钥写进代码/仓库;本地用 `.env`(gitignore),CI/生产用平台 secret。

## 8. 依赖纪律(防漂移,CI 校验)
- 新增跨包依赖必须符合 `project-structure.md` 的分层 DAG;**`apps/api` 不得直连 store/catalog/engine**。
- 用 `pnpm` 的 workspace 协议 `workspace:*` 引内部包;Turborepo 任务声明 `dependsOn` 反映构建顺序。
- 引第三方依赖前先看是否已有(避免重复造轮子/多套 JSON/hash 实现)。

## 9. Git / 协作
- **Conventional Commits**(`feat:`/`fix:`/`chore:`/`refactor:`/`test:`/`docs:`);scope 用包名,如 `feat(engine): ...`。
- 分支 `feat/<phase-or-feature>`;**一个迁移阶段(或一组紧耦合功能)一个 PR**,PR 必须带该阶段的 golden 闸门通过。
- pre-commit(lefthook)跑 Biome;push/PR 触发 GitHub Actions 全量闸门。
- 改了契约(zod schema)必须同 PR 跑 `openapi:check` 并更新前端生成类型。
