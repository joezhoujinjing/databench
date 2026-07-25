# Databench 当前架构

> 当前产品已按 ADR 0013 切换为 v2-only。Web 和 CLI 使用无版本产品入口；
> REST、数据库、对象布局与内部类型保留稳定的 v2 协议命名。

## 系统目标

Databench 管理 LLM post-training 数据：immutable versioned datasets、record/dataset
lineage、确定性 transforms、可审计导入和显式 fidelity 的导出。

系统分为：

- control plane：Postgres catalog，只存 identity、snapshot/layout metadata、run、
  lineage 与 refs；
- data plane：对象存储中的 immutable Parquet artifacts 与 manifests；
- application plane：无状态 Hono API、in-process CLI 和 React/Vite Web。

样本 payload 不进入 Postgres。

## 运行形态

```text
┌────────────────────┐
│ React/Vite Web SPA │
│ versionless routes │
└─────────┬──────────┘
          │ generated OpenAPI client
          ▼
┌────────────────────┐
│ Hono API            │
│ meta + /v2 REST     │
└─────────┬──────────┘
          │ Workspace
          ▼
┌───────────────────────────────────────────────┐
│ Engine · IO · Ops · Store · Catalog          │
└─────────────────┬───────────────────┬─────────┘
                  │                   │
                  ▼                   ▼
             PostgreSQL        OSS / S3 / MinIO

CLI ───────────────► Workspace
```

API 和 CLI 都只经 `@databench/workspace` + `@databench/schema` 触达领域能力。
Web 不 import 后端包，只消费由 OpenAPI 生成的类型。

## 产品入口与协议

| 层 | 当前入口 |
|---|---|
| Web | `/datasets`、`/ingest`、`/transforms` 及其详情子路由 |
| CLI | `databench dataset|converter|transform|ref|lineage ...` |
| REST | `/health`、`/version`、`/capabilities`、`/v2/*` |
| Postgres | `*_v2` catalog tables |
| Object store | `objects/v2/` |

这里的 v2 是稳定协议/持久化边界。它不会因为 UI 不显示版本而被重命名，也不表示还有
可用的 v1 产品面。

## 数据身份与 artifact

- RFC 8785 JCS 和 BLAKE3 是身份基础。
- identity hash 必须带明确 domain、profile 和 schema envelope。
- record revision、dataset version、run/cache 与 artifact digest 各自有独立语义。
- `record-json-v1` 是当前 Parquet 布局格式名，不是旧产品 API v1。
- artifact 与 manifest 使用 conditional create；同一 key 不允许覆盖。
- Ref 更新使用 compare-and-set，避免并发静默覆盖。

完整 fixed vectors 与不变量见 ADR 0011 和 `docs/v2/TECHNICAL-DESIGN.md`。

## 数据处理

- `@databench/engine` 使用 `hyparquet`、`hyparquet-writer` 和
  `@bokuweb/zstd-wasm` 编解码受约束的确定性 Parquet layout。
- `@databench/ops` 提供五个版本化、确定性的内置 transform。
- `@databench/io` 负责 canonical JSONL 和 converter registry。
- Transform 产生 immutable output dataset、run metadata 和 record lineage。
- Export 先 inspect fidelity plan，再由调用方明确接受 digest 后流式输出。

退役的 v1 Recipe/Vocabulary/Processing 产品实现不在当前 runtime 中。ADR 0010 的可选 Worker
是新的内部执行边界，不恢复 Processing 产品：Worker 只运行 allowlisted Python capability，
Workspace 仍负责 canonical Dataset、Run、cache 和 lineage。P1 已完成 Proto、通用 Python
server 与 Workspace internal client；Job、staging、Data-Juicer 和应用生命周期尚未接入，当前
已部署拓扑仍只有 TypeScript API、Postgres 与对象存储。

## 部署

有状态依赖始终只有：

1. Postgres；
2. 对象存储。

当前 adapter：

- hosted production：Aliyun OSS；
- local development：Postgres + MinIO；
- ADR 0012 offline single host：Docker Compose 内的 Postgres + MinIO，Caddy 仅发布
  Web 入口并把外部 `/api/*` 去前缀转发到 API。

公共云 API 托管平台仍受 D3 owner 决策门约束。ADR 0012 的 Ubuntu 单机离线通道是独立
已接受路径，不代表 V16/V17 recovery/security/capacity gate 已完成。

## 不变量

1. 所有 wire schema 只在 `@databench/schema` 定义一次。
2. OpenAPI 从 API route schema 确定性生成，前端 client 由该文档生成。
3. 参与身份的序列化只走 `@databench/hashing`，不得用裸 `JSON.stringify` 构造 hash
   输入。
4. Catalog 不依赖领域包；应用不绕过 Workspace。
5. 对象是 immutable，refs 是可变指针；二者不能混为一层。
6. 产品切换 R0-R5 不自动完成 V16/V17，也不扩大 D3 的部署授权。
