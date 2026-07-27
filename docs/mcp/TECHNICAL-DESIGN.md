# Databench MCP 最小可用技术方案

- **状态：** Accepted——owner 于 2026-07-25 接受六项产品决策并授权从 M0 开始实施；
  2026-07-27 接受 M3 必填 CAS ref 修订
- **日期：** 2026-07-25
- **代码基线：** `main@258bacaf673a0395c8fb3d769bd4bf6f78dcde56`
- **原则：** 先打通真实 Excel 导入闭环；不预建平台终局；通过稳定边界保留后续扩展性
- **首期环境：** 不暴露公网的可信内网，无应用认证，所有可访问者均有完整能力；CIDR 为可选加固
- **相关决策：** ADR 0002、0009、0011、0012、0013、0015、0016

## 1. 评审后的结论

初版方案经过三组独立评审后，统一收敛为一个纵向 MVP。交互流程由 agent 根据用户当前意图
编排，不由服务端强制为固定审批状态机：

```text
用户把 Excel 给 code agent
→ agent 识别任务与字段映射
→ agent 根据指令与映射确定性自行选择
   ├─ 用户已要求直接导入：直接导入；必要时 agent 自行先 preview
   ├─ 用户希望先看结果或映射存在歧义：preview，按反馈修改后继续
   └─ 用户只要文件：生成 canonical JSONL 交给用户，不发布 dataset
```

Agent 内部自动完成：

```text
Excel
→ code agent 读取导入契约
→ agent 自动检查 workbook/sheet/header 并完成字段映射
→ agent 在本地临时生成无 Databench-managed IDs 的 canonical draft JSONL
→ 根据上下文直接 import/materialize，或先通过一次性 URL 做完整语义校验/preview
→ 如果做过 preview，agent 可把该次 input digest 带到最终操作，防止内容意外变化
→ agent 删除本地临时 draft
```

用户不创建、不保存、不上传 draft/JSONL，不需要知道 draft schema、canonical ID、curl 或 MCP
tool 名。Draft 是 agent 与 Databench 之间的内部 wire format，不是用户操作步骤。Agent 从整段
对话判断用户意图；“导入 Databench”本身已经授权导入，不要求机械地再次确认。只有意图不清或
拟执行的副作用超出当前指令时才追问。“只生成 JSONL”不得被悄悄改成导入。

首期只保留四个长期稳定的边界：

1. Tool 参数不携带 token、user 或 tenant；认证以后从 transport middleware 加入；
2. 文件 bytes 不进入 MCP JSON 参数，而是通过一次性 HTTP URL 流式传输；
3. 所有数据领域操作仍只经过 `V2Workspace + @databench/schema`；
4. 导入结果返回 immutable exact dataset version，并创建或 CAS 移动必填 ref；后续 exact 读取仍可
   直接使用 immutable version。

其余能力按真实使用需求迭代，不作为首期前置建设。

## 2. 当前 `main` 的事实

当前系统已经具备：

- `V2Workspace.addJsonl()`：流式读取 canonical JSONL，全文件通过后才 publish；
- `describeDataset()`：读取 dataset/ref；
- `inspectExport()` + `export()`：确定性导出 canonical JSONL；
- Postgres + MinIO/OSS 的 immutable dataset、manifest、identity claim 与 CAS ref；
- Hono API 与离线 Caddy `/api/*` 转发；
- canonical record、identity、hashing 与 resource limits 的 Zod 真源。

当前缺少：

- MCP transport；
- agent 可发现的导入契约；
- 普通表格数据的服务端 ID 分配；
- 适合 code agent 的一次性大文件传输入口。

最关键的产品事实是：仅给 agent 一份 canonical JSON Schema 还不够。Canonical JSONL 要求
`rec_*`、`cand_*` 等 IDs 已经合法存在；agent 不能自行编造这些 IDs。

## 3. 首期范围

### 3.1 必须完成

- 在现有 API 进程内提供 MCP Streamable HTTP；
- 首期显式运行在 `auth_mode=none`；
- agent 能获取 canonical JSONL 与通用 canonical draft 契约、SFT/DPO/RLVR 示例和 effective
  limits；
- 用户只提供原始 Excel 和自然语言导入指令，agent 自动完成读取、映射、上传与结果确认；
- 已有 canonical JSONL 可直接导入；
- Excel/CSV 可由 agent 映射成通用 canonical draft，再由服务端生成 record/candidate/signal/
  preference IDs；
- 文件通过一次性 PUT/GET URL 流式传输；
- 导入失败不发布 dataset，也不创建或移动 ref；
- 导入成功返回 exact dataset version，并创建或 CAS 移动必填 ref，使 Web 列表立即可见；
- 可读取 dataset 摘要并导出 committed canonical JSONL；
- 内网离线环境无 OpenAI、npm、镜像仓库或公网依赖。

### 3.2 明确后做

- provider-specific 原始格式 adapter；agent 首期统一先映射到 canonical draft；
- transform、独立 ref tool、lineage、audit、record detail、通用 converter 等 MCP parity；
- MCP Resources；首期只提供兼容性更好的 `contract_get` tool；
- 多错误聚合；首期 preview 做完整语义校验，import/materialize 再完成 identity/publish 检查，
  parser 保持 fail-fast；
- 独立 `apps/mcp` 进程、独立容器和多副本；
- stdio adapter；
- OIDC、RBAC、多租户、per-user quota；
- 公网部署。

这些后续项都可以增加新 tool，不要求修改首期 tool 参数或 dataset identity。

## 4. 架构选择

### 4.1 首期内嵌现有 API

```text
Internal code agent
  ├─ MCP POST /api/mcp
  ├─ HTTP PUT /api/mcp-files/process/<one-time-token>
  └─ HTTP GET /api/mcp-files/export/<one-time-token>
                         │
                         ▼
                 apps/api（同一 Hono）
                    ├─ /v2/*
                    ├─ /mcp
                    └─ /mcp-files/*
                         │
                    同一 V2Workspace
                      ↙       ↘
                PostgreSQL   MinIO/OSS
```

选择内嵌而不是独立 `apps/mcp`，因为首期无需：

- 第二个 Workspace、连接池、cache 和 transform semaphore；
- 第二个容器、镜像、端口、healthcheck 和 rollback 单元；
- 新 Caddy upstream；
- API + MCP 的聚合内存预算；
- 修改 ADR 0012 的离线服务拓扑。

离线 Caddy 已有 `handle_path /api/* → api:8000`。因此外部 MCP 地址直接是：

```text
http://<内网 Databench 地址>/api/mcp
```

不需要修改 Caddy 路由，只需在现有 API image 中加入 MCP 模块。

### 4.2 模块边界

M1a 实际落点（后续 draft branches 继续扩展同一组文件）：

```text
apps/api/src/mcp/
├─ register.ts          MCP server、四个 tools 与 /mcp route
├─ config.ts            disabled-by-default runtime config
├─ contracts.ts         contract projection；不手写 canonical schema
├─ file-tokens.ts       process/export 共用的一次性 token registry
├─ file-streams.ts      upload/export deadline、abort 与 cleanup
├─ file-routes.ts       /mcp-files/process|export
└─ origin.ts            strict Origin middleware
```

M1a 保持这些职责为七个短文件，没有为四个 tool 各建一层目录，也没有新建 MCP 专用错误 taxonomy；
companion HTTP 继续复用 API 的 typed error middleware。通用 response stream 与 Content-Disposition
helper 位于 `apps/api/src/response.ts`，避免 MCP 反向依赖 `/v2` route 实现。

规则：

- MCP 模块只使用 `@databench/workspace`、`@databench/schema` 和 transport dependencies；
- 不 import `apps/api/src/routes/v2/*`，避免与 REST handler 耦合；
- 不调用 CLI，不通过 HTTP 回调自己的 `/v2` API；
- 复用 Hono context 中的同一个 Workspace；
- tool schema 在 `@databench/schema` 定义；
- 模块未来可以原样抽到 `apps/mcp`，外部 `/mcp` 协议和 tool schema 不变。

只有出现独立扩容、故障隔离或独立发布节奏的真实需求时，才拆成独立进程。

当前 Workspace middleware 只挂在 `/v2/*`。实施时创建一个 middleware handler 实例，并把同一
实例同时挂到 `/v2/*`、`/mcp`、`/mcp-files/*`，确保共享其惰性 Workspace promise；不能为每个
route pattern 分别创建 handler。M1a 在 Workspace 增加 `previewCanonicalJsonl()`，负责 exact raw
digest、全文件 canonical 校验、count 与有界 sample；API 不得为 preview 直连 IO/Engine/Hashing。
`ApiV2Workspace` 的 narrow `Pick` 同步加入该方法及后续 canonical-draft import 所需方法。`/mcp`
与 `/mcp-files/*` 同时复用 request ID、`Cache-Control: private, no-store`、
`X-Content-Type-Options: nosniff` 和安全错误映射；companion route 进入与 `/v2/*` 相同的 strict
typed error normalization，实施时把当前只识别 `/v2/*` 的 error-surface predicate 显式扩展到
`/mcp-files/*`；`/mcp` 不进入该 predicate，MCP JSON-RPC 错误仍按 MCP 协议返回。MCP 使用普通
Hono route 注册，不进入 OpenAPI registry，因此现有 OpenAPI bytes 不变。

## 5. MCP transport

- 使用官方 TypeScript MCP SDK，实施时精确锁版本；
- 使用 Streamable HTTP；
- 首期使用 stateless JSON response mode；
- MCP 内部 route 为 `POST /mcp`；
- 不提供 server-initiated notification stream；
- `GET /mcp` 返回 405；
- tool call 的 HTTP abort 贯穿到 Workspace `AbortSignal`；
- JSON-RPC request/response 设小型结构化数据上限，默认 1 MiB；
- 文件内容禁止出现在 tool arguments/results。

Initialize instructions 只说明：

1. 用户提供 Excel/CSV 并要求导入时，不要要求用户先转换 JSONL；
2. agent 自己读取 workbook、识别 sheet/header、调用 `contract_get("canonical-draft-import")` 并
   判断目标是 SFT、DPO、RLVR 或其他 canonical 形状；
3. 不要自行生成 canonical IDs；
4. agent 从用户当前指令和上下文选择 `validate-preview`、`import-dataset` 或
   `materialize-jsonl`；preview 是可选能力，不是后两者的服务端前置条件；
5. 映射不确定、用户要求先看，或 agent 判断展示样例有助于避免误导入时，先 preview；用户已经
   明确要求直接导入且映射足够确定时，不机械地要求再次确认；
6. preview 后继续处理同一份 bytes 时，把返回的 `input_digest` 作为
   `expected_input_digest`，内容变化则重新 preview 或按当前用户意图继续；
7. 用户只要 JSONL 时使用 `materialize-jsonl`，不得替换成 `import-dataset`；用户意图不清且不同
   action 会产生不同副作用时才追问；
8. 每次 `import-dataset` 都提供稳定 lowercase ASCII `ref` 和 `expected_ref_version`：新 ref 传
   `null`，更新已有 ref 传 agent 已知的 exact 当前 version；不得盲覆盖；
9. 完成后删除临时 draft，只向用户报告导入结果或交付 JSONL；
10. 当前环境为匿名全权限共享 workspace。

首期不同时实现 MCP Resources 和 prompts。

## 6. 首期四个 tools

本节定义 M1b3 完成时的首期最终 surface。M1 实施期间，`tools/list` 和每个 tool input schema 只暴露
当前 Step 已实现的 union branches，initialize instructions 也只描述当前可用 action；不得先宣告
一个必然返回 unsupported 的未来分支。该 surface 在 M1b3 gate 后首次冻结，部署配置在 M2 前始终
保持 MCP disabled，因此中间提交不构成对外兼容承诺。M3 是 owner 接受的 import 参数窄修订，
tool 数量与名称不变。

| Tool | 作用 | 副作用 |
|---|---|---|
| `contract_get` | 获取导入 schema、规则、例子和 limits | 无 |
| `data_process_prepare` | 创建 preview、import 或 materialize 的一次性 PUT URL | 仅创建短期 token |
| `dataset_show` | 查看 exact dataset 摘要 | 无 |
| `dataset_export_canonical_prepare` | 创建一次性 canonical JSONL 下载 URL | 仅创建短期 token |

不在首期暴露 CLI/API 的全部能力。它们已经能通过现有 Web、REST、CLI 使用；MCP tool 只在
agent 真实需要时逐个增加。

### 6.1 `contract_get`

输入：

```ts
interface ContractGetInput {
  name: 'canonical-jsonl' | 'canonical-draft-import'
}
```

返回：

```ts
interface ImportContractExample {
  name: 'sft' | 'dpo' | 'rlvr'
  jsonl: string
}

interface ImportEffectiveLimits {
  max_request_bytes: number
  max_record_bytes: number
  max_snapshot_records: number
  max_canonical_bytes: number
  max_preview_response_bytes: number
}

type ImportContractResult =
  | {
      name: 'canonical-jsonl'
      version: '2.0.0'
      schema: JsonObject
      rules: readonly string[]
      examples: readonly ImportContractExample[]
      effective_limits: ImportEffectiveLimits
    }
  | {
      name: 'canonical-draft-import'
      version: '1.0.0'
      schema: JsonObject
      rules: readonly string[]
      examples: readonly ImportContractExample[]
      effective_limits: ImportEffectiveLimits
    }
```

两个结果是 strict discriminated Zod union。`max_snapshot_records`、`max_record_bytes` 与
`max_canonical_bytes` 直接来自当前 Workspace runtime capability，不另造含义相近的 limit；
`max_preview_response_bytes` 首期固定为 1 MiB，并同时受 MCP JSON response 上限约束。

Canonical schema 从 `PostTrainingRecordV2Schema` 投影。Zod cross-field rule 无法完全表达为
JSON Schema 的部分放进 `rules`；服务端 strict validation 始终是最终真源。

首期不计算 contract digest，不重复提供 resource URI。

### 6.2 `data_process_prepare`

输入：

```ts
type DataProcessPrepareInput =
  | {
      format: 'canonical-jsonl' | 'canonical-draft-jsonl-v1'
      action: 'validate-preview'
      preview_records?: number
    }
  | {
      format: 'canonical-jsonl'
      action: 'import-dataset'
      ref: string
      expected_ref_version: string | null
      message?: string | null
    }
  | {
      format: 'canonical-draft-jsonl-v1'
      action: 'import-dataset'
      ref: string
      expected_ref_version: string | null
      message?: string | null
      expected_input_digest?: string
    }
  | {
      format: 'canonical-draft-jsonl-v1'
      action: 'materialize-jsonl'
      expected_input_digest?: string
    }
```

这是 `@databench/schema` 中四个 strict object 的 union，不接受未声明字段。因而 preview 不能携带
expected digest、canonical input 不能 materialize，非 preview action 也不能携带
`preview_records`。Digest 使用现有 64 lowercase hex schema。

返回：

```ts
interface PreparedFileOperation {
  method: 'PUT'
  put_url: string
  content_type: 'application/x-ndjson'
  max_bytes: number
  expires_at: string
}

type DataProcessPrepared =
  | PreparedFileOperation & {
      format: 'canonical-jsonl' | 'canonical-draft-jsonl-v1'
      action: 'validate-preview'
      response_kind: 'json-preview'
      side_effects: readonly []
    }
  | PreparedFileOperation & {
      format: 'canonical-jsonl'
      action: 'import-dataset'
      ref: string
      expected_ref_version: string | null
      message: string | null
      response_kind: 'json-ingest-result'
      side_effects: readonly ['dataset_publish', 'ref_update']
    }
  | PreparedFileOperation & {
      format: 'canonical-draft-jsonl-v1'
      action: 'import-dataset'
      ref: string
      expected_ref_version: string | null
      message: string | null
      response_kind: 'json-ingest-result'
      side_effects: readonly ['identity_claims', 'dataset_publish', 'ref_update']
    }
  | PreparedFileOperation & {
      format: 'canonical-draft-jsonl-v1'
      action: 'materialize-jsonl'
      response_kind: 'canonical-jsonl'
      side_effects: readonly ['identity_claims']
    }
```

实现仍由四个 strict Zod objects 组成 union；`PreparedFileOperation` 只用于文档避免重复，不是放宽
unknown keys 的 runtime intersection。

`put_url` 返回可直接交给 curl/HTTP client 的绝对 URL，例如：

```text
http://databench.internal/api/mcp-files/process/proc_<64 lowercase hex>
```

URL 只能从显式可信配置 `DATABENCH_MCP_PUBLIC_BASE_URL` 生成，不从未校验的
`Host`/`Forwarded` headers 推导。离线环境配置为用户实际访问的 `/api` base，并有真实 Caddy
前缀测试。

Token registry 只保存少量 metadata：format、action、preview limit、expected digest、import 的
ref/CAS/message、expiry 和状态，不保存文件 bytes。`preview_records` 是 0-10 的整数、默认 3，只
影响返回样例数量，不影响全文件校验。允许的组合与 `side_effects` 固定为：

| format | action | side_effects |
|---|---|---|
| canonical / draft | `validate-preview` | `[]` |
| canonical | `import-dataset` | `["dataset_publish", "ref_update"]` |
| draft | `import-dataset` | `["identity_claims", "dataset_publish", "ref_update"]` |
| draft | `materialize-jsonl` | `["identity_claims"]` |

Canonical 输入本身已经是目标 JSONL，因此不接受 `canonical-jsonl + materialize-jsonl`；agent 直接
交付原文件即可。

`validate-preview` 的 PUT 成功响应是按 `format` 区分的 strict union：

```ts
type ValidationPreviewResult =
  | {
      format: 'canonical-jsonl'
      input_digest: string // exact uploaded bytes 的 64 lowercase hex BLAKE3
      record_count: number
      records: readonly PostTrainingRecordV2[]
      records_truncated: boolean
    }
  | {
      format: 'canonical-draft-jsonl-v1'
      input_digest: string
      record_count: number
      records: readonly CanonicalDraftRecordV1[]
      records_truncated: boolean
    }
```

其中 `CanonicalDraftRecordV1Schema` 是完全物化默认值后的命名 schema，不包含 Databench-managed
IDs；canonical preview 保留原文件中的合法 canonical IDs。两个 `records` 数组都最多 10 条，且
对应 schema 与 tool success schema 一起定义在 `@databench/schema`。完整 preview tool response
不得超过 `max_preview_response_bytes=1 MiB`：只追加完整 record；下一条会超限时停止，绝不截断
record。若因此少于 `min(record_count, preview_records)`，`records_truncated=true`；第一条就过大时
允许返回空 `records`，但全文件校验、digest 和 count 仍然完成。

`import-dataset` 与 `materialize-jsonl` 可以直接调用，不强制先 preview。如果 agent 做过 preview，
可以携带其 `input_digest` 作为 `expected_input_digest`。PUT 在任何 identity claim、object 或
dataset 写入前计算并比对 exact bytes digest；不一致使用现有 `validation_error` envelope，issue
code 为 `input_digest_mismatch`，且不产生写入。这个字段用于防止 agent 在 preview 后意外上传了
另一份内容，不承担“证明人类批准”的职责。

每次 `import-dataset` 必须携带 `ref` 与 `expected_ref_version`。新 ref 使用
`expected_ref_version=null`；更新已有 ref 时使用 agent 已知的 exact 当前 version。`message` 可选，
省略时在 prepared result 中物化为 `null`。Ref 继续使用现有 lowercase ASCII schema；本修订不增加
中文 display name 或名称转换协议。

PUT 行为：

- token 256-bit CSPRNG、短期有效、只允许消费一次；
- request body 直接传给 Workspace；
- `validate-preview`：完整读取文件，校验 draft/index graph、canonical cross-field invariants 与
  resource limits，按输入 format 返回 digest、count 和前 N 条对应命名 schema 的语义预览；不访问
  namespace 或 identity claims，也不写 dataset、object 或 ref；
- `import-dataset`：canonical 格式调用现有 `addJsonl()`，draft 调用新增的
  `addCanonicalDraftJsonl()`；Workspace 完成全文件校验后才 publish，成功返回现有
  `IngestResultV2` 和 exact dataset version，并在相同发布路径中 CAS 更新 ref；
- `materialize-jsonl`：完整校验并分配/claim server IDs，但不 publish dataset/ref/object；在
  Workspace 临时目录生成 canonical JSONL，写入时执行 temp-disk admission，并按现有 Engine 语义
  限制 canonical record bytes 不超过 `max_canonical_bytes`；JSONL physical spool 的上界为
  `max_canonical_bytes + record_count`（每条一个 LF）；完整 fsync/seal 且全部成功后才开始
  `application/x-ndjson` 响应，agent 保存为用户指定文件；
- Workspace materialization 返回显式 output lease；调用方必须完整消费 bytes 或调用幂等
  `dispose()`。HTTP companion 在正常关闭、client cancel、timeout 与 response 构造失败时兜底释放；
- 失败使用统一 typed error envelope；dataset 只在成功响应前的最终 publish 阶段可见；
- 客户端断开立即 abort；
- 失败或 token 过期时重新调用 prepare，不提供 status/discard tool。

Agent 编排示例，不是服务端状态机：

```text
agent 生成 draft
├─ 直接导入：import-dataset
├─ 需要检查：validate-preview → 可选修改/重试 → import-dataset 或 materialize-jsonl
└─ 只要文件：materialize-jsonl
```

Preview 不保留上传 bytes。若 agent 随后继续处理同一份内容，会重新 PUT 并可携带 expected
digest。PUT 响应丢失时，agent 重新 prepare 并上传相同 bytes；import 必须得到相同 dataset
version/ref，materialize 必须得到相同 canonical JSONL。Import 重试必须复用相同 ref、expected
version 和 message；如果先前请求已经成功且 ref 仍指向同一 version、message 相同，按成功重放。
其他 ref 变化保持 CAS conflict。Digest mismatch 不产生写入或 ref 更新。

Preview 是完整的语义校验，不是 identity claim 预占或并发承诺；因此 import/materialize 仍可能
因既有 identity claim 或 preview 后发生的并发写入而失败。为保持 preview 无副作用，首期不新增
只读 claim lookup。

#### 6.2.1 真实电缆 Excel 的用户可见预览

以 `电缆_DEMO_20260723.xlsx` 为验收 fixture。Agent 只读检查后应识别：`Sheet1` 的
`A1:C500` 包含 1 行表头和 499 条记录，列为 `SPU_ID`、`COMBINED_GOODS_INFO`、`ATTR_JSON`。
它可以根据现有样本语义提议 SFT 属性抽取映射。用户要求先看、映射存在歧义或 agent 判断有必要
时，可展示：

```text
识别结果
- Sheet: Sheet1
- 数据量: 499 条
- 任务形态: SFT / 结构化属性抽取

字段映射
- 固定 system: 根据商品描述抽取 unit、attrs、brand，只输出 JSON 对象
- COMBINED_GOODS_INFO → user message
- ATTR_JSON → selected assistant candidate
- SPU_ID → extra.databench.adapter.cable-attribute-xlsx.v1.spu_id
- source.original_id → null（SPU_ID 在多行重复，不是行级唯一 ID）

样例 1
- user: (国标) 铜芯电缆线 3*2.5铜芯电缆线 米
- assistant: {"unit":"米","attrs":[{"attrKey":"导体材料","attrValue":"铜"},
  {"attrKey":"导体芯数","attrValue":"3芯"},
  {"attrKey":"主芯标称截面","attrValue":"2.5 mm2"}],"brand":""}

全文件语义校验: 499/499 通过
下一步: 直接导入 / 告诉我如何修改 / 只生成 canonical JSONL
```

这里的“字段映射”由 agent 根据 workbook 和 contract 生成；Databench 的 preview endpoint 负责
返回 digest、全文件语义校验结果、计数和前 N 条 canonical 语义预览。任务类型和字段映射由
agent 判断与说明；MCP server 不内置 LLM，也不需要理解电缆领域。若用户要求“不要固定
system”“把 SPU_ID 与 Excel 行号一起放入 extra”或修改 tag，agent 更新 draft 后再次 preview，
直到符合用户要求。若用户一开始已经明确要求直接导入且 agent 判断映射足够确定，可以不展示
该模板，也不要求重复确认。

“只生成 canonical JSONL”不会创建 dataset/ref/object，但会永久登记由 Databench 分配的稳定
IDs。Agent 应以用户能理解的方式说明为：“只生成文件，不创建数据集；系统会登记这份文件的
稳定标识，便于以后导入”。用户当前指令已明确要求只生成文件时即可执行，不机械地再次确认。

### 6.3 `dataset_show`

输入：

```ts
interface DatasetShowInput {
  dataset_version: string // DigestHexV2Schema
}
```

这是使用现有 `DigestHexV2Schema` 的 strict object。只接受 exact dataset version，成功响应直接复用
现有 `DatasetViewV2Schema` 与 `describeDataset()`；首期不把 mutable ref 带回 agent 导入
流程。

### 6.4 `dataset_export_canonical_prepare`

输入：

```ts
interface DatasetExportCanonicalPrepareInput {
  dataset_version: string // DigestHexV2Schema
}

interface DatasetExportCanonicalPrepared {
  method: 'GET'
  get_url: string // trusted public base 生成的 absolute URL
  media_type: 'application/x-ndjson'
  filename: string
  dataset_version: string // DigestHexV2Schema
  expires_at: string // RFC 3339 datetime
}
```

Tool 内部调用现有
`inspectExport(dataset_version, {converter:"canonical-jsonl", options:{}})`。返回一次性绝对 GET
URL、media type、filename、exact version 与 expiry；input/output 都是 `@databench/schema` 中的
命名 strict schema，URL 使用与 import 相同的可信 public base。

GET 时调用现有 lazy `export()` 流，不预生成完整文件，不写新的 staging artifact。Canonical
converter 没有 semantic loss，因此复用当前 `ExportRequestV2Schema` 并把
`accepted_fidelity_digest` 设为 `null`；不为 MCP 发明另一套 fidelity 语义。

所有 tool success results 与 `/mcp-files/*` JSON success responses 都必须在发送前通过对应的命名
Zod schema parse/assert；文件流本身按 content type、byte limit 与 Workspace codec 验证，不包装进
JSON schema。

## 7. 通用 Canonical Draft

### 7.1 一种 draft 覆盖全部 canonical 能力

简单不等于只支持 SFT。首期只定义一种 `canonical-draft-jsonl-v1`，它能表达当前
`PostTrainingRecordV2` 的全部语义：

- SFT：shared prompt + 一个 candidate；
- DPO：两个或多个 candidates + preference relations；
- RLVR：verification、candidate 与 signals；
- tools/function-call trajectories；
- rank、selected、generator、loss weight、lineage、tags 与 extra。

Draft 与 canonical record 的差别仅限 Databench 管理的实体 IDs 和指向这些 IDs 的内部引用。
Agent 不按任务选择不同 draft DSL，而是始终生成同一种 canonical-shaped draft。

### 7.2 Draft 形状

每个非空行都镜像一个 `PostTrainingRecordV2`，但：

- 顶层没有 record `id`；
- candidate 没有 `id`；
- signal 没有 `id`，`supersedes` 改为 `supersedes_index: number | null`；
- preference relation 没有 `id`；
- preference 的 candidate 引用改为 `left_candidate_index` / `right_candidate_index`；
- preference 的 `supersedes` 改为 `supersedes_index: number | null`；
- 其余字段与 canonical schema 完全一致，不另造别名。

简化的 DPO 示例：

```json
{
  "draft_schema_version": "1.0.0",
  "schema_version": "2.0.0",
  "contents": [
    {
      "role": "user",
      "parts": [{"type":"text","text":"解释什么是过拟合","thought":false,"thought_signature":null,"part_metadata":{}}],
      "loss_weight": 0
    }
  ],
  "candidates": [
    {
      "contents": [{"role":"ai","parts":[{"type":"text","text":"回答 A","thought":false,"thought_signature":null,"part_metadata":{}}],"loss_weight":1}],
      "finish_reason": null,
      "rank": 0,
      "selected": true,
      "signals": [],
      "generator": null,
      "token_count": null,
      "avg_logprobs": null
    },
    {
      "contents": [{"role":"ai","parts":[{"type":"text","text":"回答 B","thought":false,"thought_signature":null,"part_metadata":{}}],"loss_weight":1}],
      "finish_reason": null,
      "rank": 1,
      "selected": false,
      "signals": [],
      "generator": null,
      "token_count": null,
      "avg_logprobs": null
    }
  ],
  "preference_relations": [
    {
      "left_candidate_index": 0,
      "right_candidate_index": 1,
      "outcome": "left",
      "status": "adjudicated",
      "criterion": null,
      "source": {"type":"imported","id":"excel-import","version":"1"},
      "rationale": null,
      "created_at": null,
      "supersedes_index": null
    }
  ],
  "tools": [],
  "verification": null,
  "source": null,
  "lang": "zh-CN",
  "lineage": null,
  "tags": ["task:dpo"],
  "extra": {}
}
```

Contract 同时返回完整 SFT、DPO、RLVR examples。为了减少 agent 输出，允许省略以下字段并由
服务端物化 canonical 默认值：

- `candidates=[]`、`preference_relations=[]`、`tools=[]`；
- `verification/source/lang/lineage=null`；
- `tags=[]`、`extra={}`；
- candidate 的 `signals=[]`、其他 nullable metadata 为 `null`。

`contents` 与每个 candidate 的 `contents` 仍按当前 canonical 规则校验。所有 index reference
必须指向同一 record 内正确类型的实体；supersession 只能指向同数组内更早的 index。
`source.original_id` 必须是当前行的稳定业务记录 ID；没有行级稳定 ID 时使用 `null`。

### 7.3 Materialization

每行固定按以下顺序处理：

1. 物化 draft 默认值并 strict-validate draft/index graph；
2. preview 使用 synthetic record ID；materialize/import 才分配并 claim real record ID；
3. 按 candidate source output index 生成对应 synthetic/real candidate IDs；
4. 按 candidate index + signal index 生成 synthetic/real signal IDs，并解析 supersession；
5. 按 preference index 生成 synthetic/real preference IDs，并解析 candidate/supersession references；
6. 组装完整 `PostTrainingRecordV2`；
7. 运行全部 canonical cross-field invariants，包括 tools、trajectory、verification、preference 与
   lineage；
8. 按 action 返回无 IDs 的 preview、seal canonical JSONL，或创建 revisions/dataset。

Agent 只需要理解 canonical 数据语义和“ID 由服务端产生”，不需要理解 claim、hash preimage 或
Workspace namespace。用户不需要理解或接触 draft。

当前 identity creation request 的 `initial_record` / `initial_candidate` 要求携带 canonical-shaped
payload，而 nested entities 此时尚未分配 ID。Raw-adapter ADR 必须锁定 owner skeleton：

- root claim 的 initial record 使用已经物化默认值的 shared fields，但固定
  `candidates=[]`、`preference_relations=[]`；
- candidate claim 的 initial candidate 使用最终 candidate fields，但固定 `signals=[]`；
- signal/preference claims 在 owner IDs 分配后创建；
- 最终 record revision 再包含完整 candidates/signals/preferences；
- skeleton 的 exact fields、默认值和 canonical bytes 全部进入 fixed vectors。

同一 claim key 的 request digest 因而不会因实现顺序不同而漂移。

## 8. Canonical Draft Identity

### 8.1 两遍处理

`addCanonicalDraftJsonl()` / materializer 在 Workspace 内部：

1. 把 request stream 写入 Workspace 受控 temp；
2. 同时计算完整 raw bytes BLAKE3；
3. fsync/seal 后得到 `source_artifact_digest`；
4. 第二遍按非空 data row 解析 draft；
5. preview 使用仅限内存、满足 canonical ID 语法的 synthetic IDs 做 cross-field validation，不访问
   Workspace namespace/claim；
6. materialize/import 携带 expected digest 时先比对，再建立完整 ID/claim plan；
7. materialize 先写入并 seal canonical output spool，全部 claim 成功后才开始 HTTP response；
8. import 在全部校验与 claim plan 成功后 publish dataset；
9. 成功或失败都清理 raw/output temp。

这是 raw adapter 的领域 spool，不是通用 MCP upload staging，也不向应用暴露 file path/handle。
当前 Workspace 只把 temp root 交给 Store，并未持有 raw-import spool。实施时由
`V2Workspace.open/options` 注入一个窄 spool facility，继续复用现有受控 root、权限、容量与清理
规则。Canonical output 在每次 append 前按现有 Engine 口径检查累计 canonical record bytes，并
另行检查包含每行 LF 的 physical spool bytes；spool 创建前和增长过程中都按
`max_canonical_bytes + max_snapshot_records` 上界做 free-space/reservation admission，超限返回
typed resource/capacity error 并删除临时文件，不允许先完整占满磁盘再失败。

### 8.2 ID 规则

- record：有 `source.original_id` 时使用 `source-root-v1`，否则使用
  `artifact-row-v1(namespace + draft digest + data row index)`；
- candidate：generation run ID 固定为
  `canonical-draft-jsonl-v1:<draft_digest>:row:<row_index>`，source output index 等于 draft
  candidate array index；
- signal event key 固定为
  `canonical-draft-jsonl-v1:<digest>:row:<row>:candidate:<candidate_index>:signal:<signal_index>`；
- preference event key 固定为
  `canonical-draft-jsonl-v1:<digest>:row:<row>:preference:<preference_index>`；
- 上述 key 进入 ADR 0011 已有 candidate/event identity requests；agent 不能提供 canonical IDs。

Draft array index 在该 adapter 中定义为 immutable source output index，不是对已存在 canonical
array 的事后位置推断。调整候选/事件顺序会被视为新的 import artifact/identity input。

当前 `V2WorkspaceIdentityAllocator` 只面向 transform 既有 inputs，不能直接复用。Workspace
新增 import-scoped allocator，在内存中维护新 root/candidate owners，并复用现有 identity request、
claim prepare/compare 与 Catalog immutable claims。Seed/claim API 不暴露给 MCP。

`validate-preview` 不创建真实 IDs，不访问 namespace/claim，也不返回内部 synthetic IDs。
`materialize-jsonl` 和 `import-dataset` 才写 immutable claims；前者不发布 dataset。后续 claim
conflict 或 response abort 可能留下未被 dataset 引用的 claims，这些 claim 不删除、不改写、不
复用给不同语义。Materialize 成功后再以相同 bytes import 时必须是 claim replay，并得到与已交付
JSONL 相同的 canonical IDs。

### 8.3 决策门

ADR 0011 当前对缺少稳定 provider run/event key 的输入使用随机 token。上述由 artifact digest +
row/index 派生的 adapter keys 是只适用于 `canonical-draft-jsonl-v1` 的窄例外。实现前必须用一份
raw-adapter ADR 规范性修订 ADR 0011，并锁定：

- raw digest、BOM/空行/data row 计数；
- candidate/event key exact strings；
- index-reference 与默认值规则；
- root/candidate owner skeleton 与 request digest；
- SFT/DPO/RLVR 的 root/candidate/signal/preference fixed vectors；
- preview 无写、materialize-only 与 import 的副作用；
- 相同 exact bytes 的重放行为。

该例外继续复用 ADR 0011 的 entity ID profiles/formulas，不发布新的通用 identity profile，也不
影响其他 provider/raw adapters。

## 9. 文件传输与临时状态

### 9.1 Process upload

首期没有通用 staging 状态机：

- `data_process_prepare` 只创建一个内存 token；
- PUT body 直接进入 Workspace；
- canonical import 单遍 streaming；
- canonical draft 仅在 Workspace 方法内部为了 identity 两遍读取而 spool；
- token 被消费、过期或进程重启后失效；agent 重新 prepare 即可；
- 不提供 upload status、resume、discard；
- 不把 raw upload 复制到对象存储；
- process/export token 视为短期 bearer secret；API 与 Caddy access log 必须对 token path segment
  脱敏，应用日志和错误不得输出完整 URL 或 token。

### 9.2 Export

- prepare token 只保存 exact dataset version、expiry 和状态；
- GET 直接流式调用 Workspace export；
- token 单次使用；失败时重新 prepare；
- 不落完整 export 临时文件。

### 9.3 首期限制

- process/export token 默认 15 分钟过期；
- token 使用 256-bit CSPRNG；
- process + export registry 合计最多 128 个未清理 token；满时 prepare 返回 typed capacity error；
- MCP JSON body 默认 1 MiB；
- import bytes 使用 Workspace runtime capability 的 `max_request_bytes`；
- process/export 共用最多 2 个 active file operations，不设置 pending queue；容量已满时在读取 body
  前返回 `429 too_many_requests`，companion handler 显式设置 `Retry-After: 1`，token 保持 ready，
  可用同一 URL 重试；
- active PUT/GET 默认 idle timeout 60 秒、最大传输时长 30 分钟；token TTL 不代替 active
  connection timeout；
- 进程重启允许丢失 token，不影响 committed dataset。

数值可以通过启动配置调小或调大，但默认值、范围校验和 effective config 必须进入测试；首期不把
这些参数放进 tool arguments。Registry 只保存 `ready | active`：取得 file-operation slot 后以单次
原子 compare-and-set 从 ready 进入 active，只有胜出的请求读取 body；成功、失败、超时或 abort
都立即删除 entry，不保留 consumed tombstone。过期 ready entry 也立即删除；未知、过期、并发中
或已经使用过的 token 统一返回 `token_invalid_or_used` issue，不泄露其历史状态。128 上限只统计
当前 ready/active entries，因此不会被已完成操作耗尽。这样不需要 upload session、恢复协议或
distributed lock。

不做 resume、distributed token store、per-user quota 或多副本一致性。

## 10. 无认证内网模式

新增显式配置：

```text
DATABENCH_MCP_ENABLED=true
DATABENCH_MCP_AUTH_MODE=none
DATABENCH_MCP_PUBLIC_BASE_URL=http://databench.internal/api
```

规则：

- MCP 默认不启用，避免现有部署升级后意外增加入口；
- 启用时必须显式配置 `AUTH_MODE=none`；未知值启动失败；
- public base 必须是 operator 配置的可信绝对 HTTP(S) URL，不含 trailing slash；
- production 启动日志明确警告“匿名全权限，仅限可信内网”；
- API/MCP container 仍不发布宿主机端口；
- 只从现有 Caddy `/api/*` 进入；
- 整个不暴露公网的内网可以作为可信边界；不强制配置主机级 CIDR/iptables，现场需要更细粒度
  隔离时可选配置；
- 非浏览器 agent 未携带 `Origin` 时允许访问；只要请求携带非空 `Origin`，就必须与 public base 的
  origin 或显式 allowlist 精确匹配，否则在进入 MCP/file handler 前返回 403，而不是仅省略 CORS
  response header；
- 不提供 URL import、local path、shell、SQL、Python 或任意代码执行。

首期不创建 principal、role、tenant 或 policy 模型。代码只预留：

```text
request → future auth middleware → MCP/file handler
```

未来认证从 middleware 读取 credential，并在进入 Workspace 前拒绝请求；token/user 不加入 tool
参数。真正外网化和多租户届时另做 ADR，不在首期展开。

## 11. 错误语义

Malformed JSON、JSON-RPC envelope 与未知 protocol method 继续使用 MCP JSON-RPC error。官方
TypeScript SDK 的高层 `McpServer.registerTool()` 会把 tool-specific Zod 参数错误转换为标准
`CallToolResult`，其中 `isError=true`；它不是 transport-level `InvalidParams` response。成功结果仍在
handler 内通过 `@databench/schema` 的命名 strict schema parse，SDK 再校验 advertised output
schema。`/mcp-files/*` companion HTTP 使用当前
`ErrorResponseV2Schema` 的统一 envelope，不为 MCP route 创建第二套错误外形：

```json
{
  "error": {
    "code": "validation_error",
    "message": "Canonical draft validation failed",
    "detail": {
      "issues": [
        {
          "line": 12,
          "path": "/preference_relations/0/right_candidate_index",
          "code": "canonical_draft.index_out_of_range",
          "message": "right_candidate_index is out of range"
        }
      ]
    }
  }
}
```

Request ID 只通过 `X-Request-ID` header 返回。Expected digest 不一致映射为 `validation_error` +
`input_digest_mismatch` issue；无效、过期、并发中或已消费 token 统一映射为 `bad_request` +
`token_invalid_or_used` issue；file-operation slot 已满映射为现有 `too_many_requests`。领域错误继续使用当前
taxonomy 和 detail schemas。错误响应不包含 `published`：companion route 的契约本身保证只有成功
才发布 dataset，但 draft identity 流程失败时可能留下已成功写入的 immutable claims，语义见 8.2。

首期沿用 parser 的 fail-fast 行为，不为了聚合 100 条问题改造 canonical reader。Agent 修复后
重新 prepare/upload；`validate-preview` 始终重新完整读取和校验文件。未来若实际反馈证明多错误
聚合能显著减少轮次，再为 preview 增加错误聚合模式。

规则：

- 错误不返回 stack、host path、完整 record、raw seed 或 token；
- integrity、identity conflict、capacity 与 cancelled 保持可区分；
- import 失败不返回部分 dataset；
- token 失效是可重试错误；
- abort 必须清理 canonical-draft raw spool。

## 12. 测试与验收

### 12.1 Contract

- `contract_get` 的 canonical/draft literal name/version union 与 schema 来自 `@databench/schema`；
- canonical 与 canonical-draft 的 SFT/DPO/RLVR examples 均可被对应 strict parser 接受；
- 当前 system content 规则正确：首条、单 text、`loss_weight=0`；
- DPO example 的 candidate index references 合法；
- RLVR example 的 verification、signals 与 supersession graph 合法；
- `max_snapshot_records`、`max_record_bytes`、`max_canonical_bytes` 与 Workspace capability 一致，
  preview response limit 固定进入 effective limits；
- 每个 tool/companion JSON success response 发送前经过对应命名 strict schema parse/assert；
- M1a/M1b1/M1b2 的 `tools/list` 只声明当步已实现 branches，M1b3 final schema 才冻结。

### 12.2 Protocol 与 token

- MCP initialize、tools/list、tools/call；
- stateless POST、GET 405、invalid params、body limit；
- Origin 校验；
- token 随机性、expiry、单次消费、数量上限；
- `ready → active → delete` 原子生命周期、无 tombstone 泄漏、同 token 并发 PUT/GET、未知 token、
  进程重启失效；
- 无 pending queue 的两并发 admission、429 不消费 ready token、idle/总时长 timeout；
- `input_digest` 与可选 `expected_input_digest` 相同/不同时的成功与 fail-before-write；
- preview 在 1 MiB response budget 内只返回完整 records，首条过大时返回空 records +
  `records_truncated=true`；
- client abort 贯穿 Workspace。

### 12.3 Canonical-draft fixed vectors

- 现有电缆 Excel 派生 draft fixture；
- source original ID 与 artifact-row 两条 root 路径；
- raw digest、空行/data row index；
- candidate generation run key 与各 candidate `output_index`；
- signal/preference event keys 与 index/supersession references；
- root/candidate owner skeleton request digests；
- SFT/DPO/RLVR 的 record/candidate/signal/preference IDs、record digest、dataset version；
- 相同 exact bytes 重放得到相同 IDs/version；
- malformed draft、duplicate key、非法 system/lang/tags/index graph；
- preview 不访问 namespace/claim 且不 publish；materialize claim 但不 publish；import claim 并
  publish；materialize 后 import 是 claim replay；materialize response 绝不返回半份 JSONL；
- materialize output 超过 `max_canonical_bytes` 或 temp reservation 不足时 typed fail、清理 spool，
  不发布 dataset/ref/object。

### 12.4 真实生命周期

自动仓库 E2E 使用由电缆 Excel 固化出的 canonical-draft fixture，从 deterministic runtime 能力开始：

```text
fixed canonical draft
→ validate-preview 返回 digest/count/3 条样例，且无写
→ expected digest 不一致时 fail-before-write
→ expected digest 一致时 import 返回 exact dataset version
→ 不经过 preview 也可以直接 import 并得到相同 exact dataset version
→ 另一条路径 materialize 完整 JSONL，且不发布 dataset/ref/object
→ materialized JSONL 再 import 得到相同 IDs/version
```

Draft entity IDs 是 Workspace namespace-scoped identity。自动测试会锁定 workbook attestation、draft
exact bytes/digests 和机械修改结果，并在同一 namespace 内断言 materialize/import/export/reimport
的 exact version 相等；每次 reset 后创建新 namespace UUID 的 test schema 不把 dataset version 或
canonical digest伪装成跨 namespace fixed vector。人工验收另记录其实际持久 namespace 返回的 exact
versions。

人工产品验收才从真实 `.xlsx` 与具备 Excel 读取能力的 code agent 开始：

```text
只把原始电缆 Excel 交给 agent
→ agent 读取 workbook/sheet/header
→ agent 调用 contract_get
→ agent 自动生成临时 canonical draft
→ agent 根据用户指令与映射确定性决定直接 import 或先 preview
→ preview 路径展示 499 条计数、字段映射和 3 条样例，并能按反馈修改重试
→ import 路径调用 data_process_prepare(action="import-dataset") 并 PUT
→ 返回 exact dataset version 与已更新 ref
→ dataset_show
→ dataset_export_canonical_prepare
→ GET canonical JSONL
→ canonical JSONL 再导入得到相同 dataset version
→ agent 删除临时 draft
```

人工验收至少覆盖三种对话意图：直接导入不重复确认；先看样例、修改后导入；只生成 JSONL。
最后一种由 agent 调用 `action="materialize-jsonl"`，保存响应 bytes 并交付文件；没有
dataset/ref/object 发布。还需证明 invalid import 不发布 dataset 或 ref、成功 import 更新 ref，
以及断网 Docker network 中无 OpenAI/npm/公网依赖。自动 E2E 与人工 Excel 验收必须使用同一
draft/canonical golden 对齐；CI 不运行模型，也不把 agent 的语义推断伪装成 deterministic test。

### 12.5 Repo gates

每个实现 PR 运行现有：

```text
git diff --check
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm openapi:check
pnpm v2:status:check
pnpm offline:check
```

MCP 不改变 `/v2` REST contract，因此 OpenAPI 应保持 byte-identical。

## 13. 三个产品阶段

产品保持 M0→M1→M2 三阶段。为遵守一个 accepted Step 一个 PR 并降低回归风险，M1 的代码纵切
分成 M1a、M1b1、M1b2、M1b3 四个 PR；M1b3 通过后才对用户宣称 Excel 闭环可用。

### M0 — 最小决策

- 接受本方案；
- 新增短 MCP ADR：API 内嵌、Streamable HTTP、`auth_mode=none`、文件不进 MCP JSON；
- 接受 canonical-draft raw adapter identity/mapping 决策与 fixed vectors，并明确它是 ADR 0011 的
  adapter-specific 窄例外；
- 新增 `docs/mcp/PLAN.md` 与 `STATUS.md`：MCP 作为独立 accepted plan 实施，不启动或完成
  V16/V17，也不把 MCP 局部 security/capacity tests 宣称为 GV16；
- owner 已明确授权 M2 在自身 scoped security/capacity/offline gate 通过后，于 GV16/GV-final
  未完成时进入 ADR 0012 的内网离线 production 通道；该例外不启动或完成 V16/V17；
- 用目标 code agent 做基础 capability preflight：能读取本地 `.xlsx`、创建/删除临时 JSONL，并
  具备流式 HTTP PUT/GET client 能力；任一基础能力不具备时先解决 agent 接入，不开始服务端 M1；
- 真实 Streamable HTTP MCP 与 companion absolute URL 依赖 M1a endpoint，作为 GM1a blocking
  smoke；实际内网 DNS/Caddy 地址再于 GM2 复验，不在 M0 伪造 endpoint 成功证据；
- 不修改 ADR 0012 服务拓扑；
- 不改变 V16/V17 或公共云 D3 状态。

### M1a — MCP 与 canonical 纵切

- API 内嵌 MCP；
- 注册四个 tools，但 `contract_get` 只暴露 canonical contract，`data_process_prepare` 只暴露
  canonical `validate-preview | import-dataset` branches；`tools/list` 与 runtime 能力完全一致；
- process/export 一次性 token 和 companion routes；
- `/mcp-files/*` 进入 v2 strict error normalization，`/mcp` 保持 MCP JSON-RPC error，429 明确携带
  `Retry-After`；
- canonical no-write preview 与 import；
- canonical dataset show/export 的真实 Postgres + MinIO 生命周期。

### M1b1 — Canonical-draft contract 与 preview

- 通用 `CanonicalDraftRecordV1Schema`、strict tool contracts 与 SFT/DPO/RLVR examples；
- `contract_get` 增加 draft contract，`data_process_prepare` 只新增 draft `validate-preview` branch；
- no-write preview、synthetic IDs、input digest 与 canonical invariants；
- 不写 namespace/claim/dataset/object/ref 的固定测试。

### M1b2 — Canonical-draft identity 与 materialize

- raw-adapter fixed vectors、import-scoped allocator 与 immutable claims；
- `data_process_prepare` 新增 draft `materialize-jsonl` branch；
- expected input digest fail-before-write；
- seal 完整 canonical JSONL 后才响应；materialize 不 publish dataset/ref/object；
- materialize 重放与 abort/cleanup 生命周期。

### M1b3 — Canonical-draft import 与 Excel 闭环

- draft import、dataset publish 与 materialize → import claim replay；
- `data_process_prepare` 新增 draft `import-dataset` branch，完成并冻结第 6 节首期 tool surface；
- 电缆 fixture 的直接导入、preview/修改后导入和只生成 JSONL 三条真实 Postgres + MinIO 生命周期；
- 真实 `.xlsx` + 目标 code agent 人工验收。

完成 M1b3 时，用户最初的 Excel → Databench → canonical JSONL 场景已经可用。

### M2 — 内网离线交付

- owner 已在 M0 授权该 scoped release；只有本节自身 gate 通过后才启用 MCP；
- 离线配置启用 MCP；
- agent 配置与操作说明；
- Caddy 现有 `/api/*` 路径 smoke；
- token limit、abort、temp cleanup；
- air-gapped lifecycle；
- upgrade/rollback 验证现有 API image。

### M3 — Dataset import 必填 CAS ref

- 保持现有四个 tools；canonical/draft `import-dataset` 新增必填 `ref` 与
  `expected_ref_version`，`message` 可选；
- prepared result 回显 ref intent，side effects 增加 `ref_update`；
- canonical/draft companion PUT 都把 ref options 传入 Workspace；invalid input 与 digest mismatch
  不创建 ref；
- 相同 target/message 的响应丢失重试按成功处理，其他并发变化保持 CAS conflict；
- 更新离线 smoke 与 agent 指南，证明导入完成后 ref 可由 Web/Workspace 立即发现。

## 14. 后续迭代规则

只根据真实使用频率增加能力，建议顺序：

1. preview 多错误聚合；
2. dataset records/record detail；
3. provider-specific raw adapters；
4. 独立 ref tool/lineage；
5. transform/audit/通用 converter；
6. MCP Resources；
7. 认证；
8. 独立 `apps/mcp` 与多副本。

每一项独立增加，不阻塞前一项使用。满足以下任一真实条件才抽独立 MCP 进程：

- MCP 与 API 需要不同扩容；
- MCP 故障需要与 REST 隔离；
- MCP 有独立发布节奏；
- token/连接负载影响 API SLO。

抽离时保持 `/mcp`、`/mcp-files/*`、tool names 和 schemas 不变，只调整 Caddy upstream 和部署。

## 15. 接受标准

Owner 已于 2026-07-25 接受以下六个产品决策：

1. 首期 MCP 内嵌现有 API，不新起服务；
2. 首期只有四个 tools，不追求 CLI/API parity；preview 是可选能力，agent 根据用户意图自主选择
   直接导入、先 preview 或只生成文件，服务端不实现人工审批状态机；
3. 首期使用唯一的通用 canonical draft，覆盖 SFT、DPO、RLVR 与现有完整 canonical 结构；
4. 首期匿名全权限，只用于不暴露公网的可信内网；CIDR/iptables 是可选纵深防御，不是安装前置；
5. “只生成 canonical JSONL”不发布 dataset/ref/object，但会永久登记为 canonical IDs 创建的
   immutable identity claims；
6. 是否授权 MCP 在 GV16/GV-final 未完成时，通过 M2 自己的 scoped security/capacity/offline gate
   后进入 ADR 0012 内网离线 production 通道；owner 已授权，但不得据此宣称 V16/V17 完成。

首要产品验收不是“某个 tool 能调用”，而是：

```text
给 agent 一个 Excel 文件，只说“导入 Databench”
→ 无需用户准备任何中间文件
→ agent 自行识别映射，并在足够确定时直接导入，不要求用户机械地再次确认
→ agent 判断有必要或用户要求时，可以展示映射与样例并按反馈修改
→ 最终可以导入并获得 exact dataset version，也可以只交付 canonical JSONL、不发布 dataset
```

这样第一版解决真实问题，同时没有封死后续扩展：

```text
先让 agent 能把电缆 Excel 按用户意图直接导入、按需预览/修改，或只生成文件
→ 同一 draft 已覆盖完整 canonical 结构
→ 再根据实际调用增加 provider adapters 和 tools
→ 真有容量/安全需求时再拆服务、加认证
```

JSONL 标准不需要先做成 skill。Databench 通过 `contract_get` 向 agent 发布当前 schema、规则、
示例和 limits；只有未来出现固定业务 Excel 模板和专用映射步骤时，才考虑用 skill 封装该映射。
