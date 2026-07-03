# 任务:把 apps/api 重构成 idiomatic Hono + @hono/zod-openapi

> Archived task brief. Do not treat repository-state statements in this file as
> current; use `AGENTS.md`, `docs/README.md`, and `git status` for current
> operating context.

仓库:`~/Desktop/databench-ts`(monorepo)。**先读** `AGENTS.md` + `docs/conventions.md`(尤其「契约单源 / 错误映射 / 依赖 DAG」)+ `docs/migration/inventory-service.md`(端点行为基线)。

⚠️ **仓库当前无任何 git commit、工作树有未提交改动。直接在工作树原地改,不要 commit、不要 git init/reset。** 改完只报告改了哪些文件 + 闸门结果。

## 背景
`apps/api`(Hono + @hono/zod-openapi)核心做得好(集中式错误信封、env zod 校验、CORS+PNA、流式导出、multipart 清理、依赖边界都对)。但有几处偏离 zod-openapi 惯用法,要修。**外部 HTTP 行为/契约语义必须保持不变**(端点、状态码、响应形状、错误信封、CORS/PNA、NDJSON 流、multipart 字段 `file`);`openapi.json` 的内部形状可以变(命名 component/$ref),但必须仍是合法 OpenAPI 3.x 且前端 codegen 仍可用。

## 要修的(按重要性)

### 1)请求校验收敛到 `c.req.valid()`,去掉手动 `.parse()` 和双 schema
现状:route 在 `createRoute({request:{query/body}})` 用 `*OpenApiQuerySchema` 声明,handler 里又手动 `XxxRequestSchema.parse(await c.req.json())` / `PaginationQuerySchema.parse(c.req.query())` 再校验一遍。
改成:**schema 在 `createRoute` 声明一次**,handler 直接读 `c.req.valid('query'|'json'|'param')`(已校验、带类型),删掉手动 `.parse()`。
- 尽量**消除 `*OpenApiXxxSchema` 与 `*XxxSchema` 的成对存在**,合并为**单一** zod schema。
- 注意 query 参数是字符串:单 schema 必须用 `z.coerce.number()` 等做强制转换,且仍能被 zod-openapi 正确输出。
- 涉及文件:`routes/{transforms,datasets,refs,recipes,lineage}.ts`。

### 2)OpenAPI component 收敛到 zod `.openapi()` 单源(去掉手写 JSON Schema)
现状:`apps/api/src/openapi.ts` 的 `registerOpenApiComponents` **手写 JSON Schema** 注册 HealthInfo/VersionInfo/Capabilities/TransformRunRequest/TransformInfo/RefInfo/*Page/ErrorResponse,与 `@databench/schema` 的 zod 并存 = 契约双源、会漂。
- **先验证**:在 `@databench/schema` 给共享 schema 加 `.openapi('Name')` 元数据,让 `@hono/zod-openapi` **自动生成命名 component + $ref**。若自动生成出的 `openapi.json` 合法且等价 → **删掉手写的 `registerOpenApiComponents`**。
- **若确实是 zod v4 + @hono/zod-openapi 1.x 的限制导致自动注册不行**(很可能,代码里已有 `z.toJSONSchema()` 的痕迹):**保留手写 component,但**(a)加一个测试断言「emitted openapi.json 的 component 形状 == 对应 zod schema(用 `z.toJSONSchema` 对拍)」防漂移;(b)在 `openapi.ts` 顶部注释说明为何手写 + 链接到限制。
- 二选一都行,**目标是契约单源 / 不静默漂移**。把你的判断(能否收敛 / 为何)写进报告。

### 3)去掉 export route 的 `as never`
`routes/datasets.ts` 的 export handler 现在 `(... ) as never` 返回裸 `Response`。改成类型正确的流式返回:用 `c.body(stream, 200, {headers})` 或 `hono/streaming` 的 `stream()` helper,使 handler 无需 `as never`。**保持** `content-type: application/x-ndjson; charset=utf-8` 与 `content-disposition: attachment; filename="..."` 行为不变。

### 4)小项
- `routes/datasets.ts` 的 `samples` handler:别 `Array.from(dataset.toSamples())` 全量物化再 slice;**惰性**只取 `offset..offset+limit`(迭代到够即停),输出与现在完全一致(total 仍为 `dataset.length`)。
- `config.ts`:`version` 从根 `package.json` 读,别硬编码 `'0.0.0'`。

## 约束
- 不改外部契约语义;不碰 store/catalog/engine(handler 只经 `getWorkspace`,依赖 DAG)。
- 错误信封/映射(`middleware/error.ts`)行为不变。

## 验证(闸门,全要绿)
确保 `docker compose up -d`(api 测试会跑 `prisma migrate deploy`)。然后:
- `pnpm lint`
- `pnpm exec turbo run typecheck --force`
- `pnpm exec turbo run test --force`(含 `apps/api` 的 lifecycle/errors/app-support 测试)
- `pnpm openapi:check`(若 emitted openapi.json 因命名 component 改变,**更新提交的 openapi.json 快照并使 check 通过**;但要肉眼确认仍合法、端点/字段没丢)
- 若 DB 相关测试因环境起不来,至少跑 lint/typecheck/openapi:check + 不依赖 DB 的单测,并在报告里说明。

## 输出
**不要 commit。** 报告:① 改了哪些文件;② #1 是否完全去掉了双 schema/手动 parse;③ #2 走的是「收敛到 .openapi()」还是「保留+加对拍测试」及原因;④ 各闸门结果;⑤ openapi.json 是否有变化、变了什么。
