# ADR 0015 — 内网 Agent 的 MCP 数据接入

- **状态:** Accepted——owner 于 2026-07-25 接受六项产品决策并授权实施
- **日期:** 2026-07-25
- **决策者:** owner
- **依赖:** [ADR 0002](0002-http-framework.md)、
  [ADR 0009](0009-canonical-post-training-record-v2.md)、
  [ADR 0011](0011-identity-hashing-versioning-v2.md)、
  [ADR 0012](0012-offline-single-host-deployment.md)、
  [ADR 0013](0013-v2-product-cutover-and-v1-retirement.md)
- **详细方案:** [Databench MCP 最小可用技术方案](../mcp/TECHNICAL-DESIGN.md)
- **Identity 修订:**
  [ADR 0016](0016-canonical-draft-raw-adapter-identity.md)

## 背景

Databench 已经具备 canonical JSONL 的导入、查看与确定性导出，但真实用户拿到的通常是 Excel、
CSV 或其他表格数据。目标 code agent 应能直接读取用户给出的文件、理解 Databench 契约、完成字段
映射并把数据导入，而不是要求用户先手工转换 JSONL 或编造 `rec_*`、`cand_*` 等 canonical IDs。

首期运行环境是防火墙限定的可信内网。Agent 可能无法访问 OpenAI 或任何公网，但可以访问同一内网
的 Databench。当前系统没有 principal、role、tenant 或 policy 模型；owner 决定先打通匿名全权限
闭环，后续再按真实需求增加认证。

## 决策

### 1. MCP 首期内嵌现有 API

- 在 `apps/api` 的同一个 Hono 进程挂载 MCP Streamable HTTP，内部路径为 `POST /mcp`；
- 复用同一个惰性 `V2Workspace`、Postgres pool、Store、cache 与资源预算；
- 首期使用 stateless JSON response mode，不提供 server notification stream；
- 不新建 `apps/mcp`、独立容器、端口、healthcheck 或 Caddy upstream；
- 只有出现独立扩容、故障隔离或发布节奏需求时，才通过后续 ADR 拆分进程。

MCP 模块仍只能通过 `@databench/workspace` 与 `@databench/schema` 触达数据，不得直连 Catalog、
Store、Engine 或现有 REST handler。

### 2. 首期只发布四个 tools

M1b3 完成时的首期 surface 固定为：

1. `contract_get`：返回 canonical JSONL / canonical draft schema、规则、示例与 effective limits；
2. `data_process_prepare`：为 preview、dataset import 或 canonical JSONL materialize 创建一次性
   PUT URL；
3. `dataset_show`：读取 exact dataset version；
4. `dataset_export_canonical_prepare`：为 committed dataset 创建一次性 canonical JSONL GET URL。

首期不追求 CLI/REST parity，不提供 transform、ref、lineage、record detail、audit、Resources、
prompts 或 provider-specific raw adapter。后续通过增加 tool 迭代，不修改现有 dataset identity。

M1 分步实施期间，`tools/list`、tool input schema 与 initialize instructions 只能声明当前 Step 已实现
的 branches；不得提前宣告 unsupported 能力。完整首期 surface 在 M1b3 gate 后首次冻结，部署配置
在 M2 前保持 disabled。

### 3. Agent 自主编排，不建立人工审批状态机

`validate-preview` 是可选能力，不是 import/materialize 的服务端前置条件：

- 用户已经要求“导入 Databench”且映射足够确定时，agent 可以直接 import，不机械地再次确认；
- 用户要求先看、映射存在歧义或 agent 判断展示样例有帮助时，可以 preview 并按反馈重试；
- 用户只要文件时，agent 使用 materialize，不得悄悄替换成 dataset import；
- 只有用户意图不清且 action 副作用不同，agent 才追问。

Preview 返回 exact input bytes 的 BLAKE3 `input_digest`。后续 action 可以携带可选
`expected_input_digest`，在任何 claim/object/dataset 写入前比对；它只防止 agent 意外换了输入，
不证明人工批准，也不创建服务端 session。

### 4. 文件 bytes 不进入 MCP JSON

- MCP JSON-RPC request/response 只承载小型结构化参数，默认上限 1 MiB；
- 文件使用一次性 bearer URL：`PUT /mcp-files/process/<token>` 与
  `GET /mcp-files/export/<token>`；
- URL 由显式可信 `DATABENCH_MCP_PUBLIC_BASE_URL` 生成，不读取未校验 Host/Forwarded headers；
- token 只存在进程内，256-bit CSPRNG、默认 15 分钟、单次使用；进程重启丢失即可；
- 不实现 staging session、resume、status、discard、distributed token store 或 raw upload 对象；
- API/Caddy access log 必须脱敏 token path segment，不记录完整 bearer URL。

具体并发、timeout、preview/output bytes 与 token registry 上限以详细技术方案为规范来源。

### 5. 首期显式使用匿名可信内网模式

MCP 默认关闭。启用时必须同时配置：

```text
DATABENCH_MCP_ENABLED=true
DATABENCH_MCP_AUTH_MODE=none
DATABENCH_MCP_PUBLIC_BASE_URL=http://databench.internal/api
```

`AUTH_MODE` 未设置或不是已支持值时 fail closed。无 Origin 的非浏览器 agent 可访问；请求只要携带
非空 Origin，就必须与 public base origin 或 operator allowlist 精确匹配，否则在 handler 前返回
403。MCP/file routes 复用 request ID、private/no-store、nosniff、abort 与 typed error normalization。

首期不创建假的 user/role/tenant 抽象。未来认证只从 transport middleware 加入，不把 token、user
或 tenant 放进 tool 参数。

### 6. Contract 与错误保持单一来源

- Tool input/result、canonical draft、preview 与 companion JSON success schema 全部定义在
  `@databench/schema`，发送前 strict parse/assert；
- `/mcp-files/*` 使用现有 `{error:{code,message,detail}}` typed envelope；
- `/mcp` 的协议错误仍使用 MCP JSON-RPC error；
- MCP routes 不进入 OpenAPI registry，现有 `/v2` OpenAPI bytes 必须保持不变；
- canonical draft 的 ID 分配和副作用由 ADR 0016 规范。

### 7. 离线 production 是范围化发布例外

Owner 明确授权：M2 自身的 scoped security/capacity/offline gate 通过后，MCP 可以在 GV16/GV-final
未完成时进入 ADR 0012 的内网离线 production 通道。该授权只覆盖本文定义的匿名可信内网 surface，
不表示 V16、V17、GV16、GV-final 或公共云 D3 已完成，也不授权公网暴露。

## 非目标

- 公网 MCP、多租户、OIDC、RBAC、per-user quota；
- Agent 或服务端访问 OpenAI、公网模型、npm、镜像仓库；
- 在 MCP server 中运行任意 shell、Python、SQL、URL fetch 或用户代码；
- 让服务端理解 Excel 业务语义；workbook 读取与字段映射由 code agent 完成；
- 把 JSONL 标准先包装为 skill；首期由 `contract_get` 直接发布当前契约。

## 后果

- **+** 内网 agent 可以在无公网依赖的情况下直接把 Excel/CSV 映射并导入 Databench；
- **+** MCP 复用现有 Workspace/Schema 真源，不引入第二套数据访问层；
- **+** 文件传输与 MCP JSON 解耦，避免 base64/超大 JSON；
- **+** Agent 交互可按上下文演进，服务端不承担僵化审批流程；
- **−** 首期任何能访问入口的主体都拥有完整能力，安全边界依赖防火墙与 operator 配置；
- **−** 进程重启会使一次性 URL 失效，客户端必须重新 prepare；
- **−** MCP 与 API 共进程，MCP 负载会共享 API 资源预算；达到真实隔离需求后再拆分。
