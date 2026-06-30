# ADR 0006 — 前端栈(apps/web)

- **状态:** Accepted
- **日期:** 2026-06-29
- **决策人:** owner

## 背景
前端也全新重写(见 ADR-0001 更新)。后端是独立 Hono `/v1` API,前端是**纯 REST 客户端**——数据不在前端服务端取,因此**不需要 SSR/RSC**。它是数据密集的内部工具(虚拟化样本表、lineage DAG、recipe 构建、文件上传)。

## 决策

| 维度 | 选择 | 备注 |
|---|---|---|
| 框架/构建 | **React 19 + Vite SPA** | 纯客户端,静态产物(CDN/对象存储);无 SSR/无额外 Node 服务 |
| 路由 | **TanStack Router** | 文件式 + 类型安全;替代旧 react-router(greenfield 取类型安全) |
| server state | **TanStack Query** | 沿用;每端点一组 hooks |
| 虚拟化 | **TanStack Virtual** | 样本大列表分页/虚拟滚动 |
| 组件/样式 | **shadcn/ui + Tailwind v4** | 代码归己、可改;`@tailwindcss/vite`;图标 lucide-react |
| API 客户端 | **openapi-typescript + openapi-fetch** | 从 `apps/api` 导出的 `openapi.json` 生成类型;契约优先 |
| 表单 | **react-hook-form + zod** | 可复用 `@databench/schema` 的部分 schema 做前端校验 |
| lineage 可视化 | **React Flow(`@xyflow/react`)** | DAG 渲染 |
| i18n | **i18next + react-i18next** | 沿用 en/zh(旧 UI 已有 locales) |
| 测试/规范 | **Vitest + Testing Library + Biome** | 与 monorepo 一致 |

## 原则
- **契约优先不变**:只通过 `openapi-typescript`/`openapi-fetch` 消费 `/v1`;**不 import 任何后端包**(与 `apps/api` 仅共享生成的类型)。
- **旧 `databench-ui` 是功能参考**,不是被搬运的代码;重写时按「前端功能清单」(待做)逐页保功能。
- 选 SPA 而非 Next:内部工具、数据在独立 authed REST API 后、无 SEO 需求,SSR 收益小且会多一个 Node 服务——与「API 是唯一 Node 服务」的部署原则冲突。

## 待做
1. **前端功能清单**:仿后端那套,对旧 `databench-ui`(`~/Desktop/databench/databench-ui/`)逐页/逐交互梳理(Datasets/DatasetDetail/Transforms/Recipe/Lineage/Ingest/Vocabulary*/连接面板/i18n),防重写漏功能。
2. `apps/web` 文件级结构见 `directory-layout.md`。
