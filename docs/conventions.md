# 编码规范（权威）

> 配套 [`project-structure.md`](project-structure.md)。当前 runtime 是 v2-only；
> 历史 parity 规则只在迁移文档和已完成记录中保留。

## 1. 命名

| 对象 | 约定 | 例 |
|---|---|---|
| 包 | `@databench/<kebab>` | `@databench/workspace` |
| 文件/目录 | kebab-case | `artifact-hasher.ts` |
| 类型/类 | PascalCase | `V2Workspace` |
| 变量/函数 | camelCase | `canonicalJsonV2` |
| 常量 | UPPER_SNAKE | `DEFAULT_V2_PAGE_LIMIT` |
| Zod schema | `XxxSchema`，类型由 `z.infer` 推导 | `RecordV2Schema` |
| 错误码 | 集中声明的 snake_case 字符串 | `not_found` |
| DB 表/列 | snake_case；稳定 v2 表保留 `_v2` | `dataset_snapshots_v2` |
| REST | 稳定 `/v2` 协议路径 | `/v2/datasets:ingest-jsonl` |
| Web/CLI | 无版本产品入口 | `/datasets`、`databench dataset show` |
| env | UPPER_SNAKE | `DATABENCH_OBJECT_STORE` |

`v2` 可以出现在协议、持久化、内部类型与测试名中，但不应重新出现在产品导航或 CLI
命令层级中。

## 2. TypeScript 与模块

- 纯 ESM；相对 import 使用项目既有 `.js` specifier 约定。
- 禁止 default export，使用具名导出。
- 外部只能 import package barrel；禁止 `@databench/x/src/...` 深 import。
- 所有项目继承 `tsconfig.base.json`，保持 `strict`、
  `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `verbatimModuleSyntax` 与 `isolatedModules`。
- `undefined` 表示字段缺失，`null` 是显式数据；不得为了通过类型检查混用。

## 3. 确定性与身份

这是最高优先级约束：

- 参与 identity 的序列化只能走 `@databench/hashing` 的 RFC 8785
  `canonicalJsonV2` 路径。
- 禁止用裸 `JSON.stringify` 构造 hash 输入；普通 wire/body/显示序列化不受此禁令。
- BLAKE3 固定；不得增加静默 fallback。
- 每个 identity 必须带 ADR 0011 规定的 domain、profile 与 schema envelope。
- empty dataset version 也必须走相同 profile；不得引入跨版本全局 empty 常量。
- artifact digest 对最终字节计算，写入必须 conditional create。
- object key、manifest、dataset version 与 record revision 的语义不得互换。
- 确定性改动必须更新对应 fixed vector/golden test，并解释兼容性。

## 4. 错误

- 领域包抛 `@databench/schema` 中的类型化错误，不抛裸字符串或 HTTP 概念。
- 只有 `apps/api` 把领域错误映射为 HTTP：

  ```json
  {"error":{"code":"not_found","message":"...","detail":{}}}
  ```

- Zod/request validation、not found、conflict、integrity、unavailable 与内部异常均使用
  现有确定映射；不要在单个 route 自建第二套 envelope。
- CLI 复用同一错误 taxonomy，再映射为确定退出码。

## 5. 契约单一来源

```text
@databench/schema Zod
  → @hono/zod-openapi route
  → openapi.json
  → openapi-typescript
  → apps/web/src/api/generated/schema.ts
```

- 不在 API route 或 Web 中手写平行 wire type。
- 改契约必须在同一变更中运行 `pnpm openapi:check` 并更新 generated client。
- Web 允许本地 UI state type，但不得把它伪装成服务端 response type。

## 6. 测试

- 测试框架 Vitest，文件名 `*.test.ts`；确定性向量可用 `*.golden.test.ts`。
- 单元测试覆盖纯规则；Postgres/MinIO suites 覆盖真实持久化和并发边界。
- API、CLI 与 Workspace 的 lifecycle 测试必须使用独立 test schema，不修改 public
  catalog 数据。
- 真实依赖测试不可用 memory fake 替代后就宣称通过。
- 前端产品切换需要真实浏览器验证无版本路由、刷新、窄屏、console 和完整主流程。
- 离线发布同时需要静态脚本检查与构建产物中的实际 lifecycle smoke。

## 7. 配置

配置由 app/package 的 `config.ts` 用 Zod 校验。主要变量：

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | Postgres catalog |
| `DATABENCH_OBJECT_STORE` | `oss` 或 `s3` |
| `OSS_*` | Aliyun OSS |
| `S3_*` | S3-compatible/MinIO |
| `DATABENCH_CORS_ORIGINS` | 精确 origin allowlist |
| `DATABENCH_OPENAPI_SERVER_URL` | 部署侧 OpenAPI server URL |
| `DATABENCH_ROOT` | bounded local staging root |
| `DATABENCH_V2_CURSOR_SECRET` | v2 cursor signing secret |
| `PORT` | API 端口 |

密钥不写入代码或仓库。本地 `.env` 必须忽略；CI/生产使用 secret store。

## 8. 依赖与存储

- 新增依赖必须符合 `project-structure.md` 的 DAG。
- 内部包使用 `workspace:*`。
- `apps/api`、`apps/cli` 不得绕过 Workspace。
- 样本 payload 不进 Postgres；对象存储中的 artifact/manifest 不得原地覆盖。
- 数据删除只能通过显式 maintenance 流程，普通启动、请求和 migration wrapper 不做
  隐式对象清理。

## 9. Git 与 gate

- Conventional Commits，scope 使用 app/package/领域名。
- 一个已接受 Step 一个 PR/commit，未过当前 gate 不进入下一 Step。
- pre-commit 跑 Biome；R5 至少运行 lint、build、typecheck、test、openapi、
  status、peer、真实依赖、浏览器和离线 smoke。
- 不修改旧参考仓库 `~/Desktop/databench/`。
