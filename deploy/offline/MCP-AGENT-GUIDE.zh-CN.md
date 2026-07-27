# Databench 内网 Agent 接入指南

本文面向现场管理员和使用 Databench 的 code agent。它只说明如何连接已经安装好的内网 MCP，
不复制 JSONL schema；agent 每次应通过 `contract_get` 获取当前契约。

## 1. 安全边界

- 当前 MCP 没有用户名、密码、token、tenant 或 RBAC；任何能访问 Databench TCP 80 的主体都拥有
  完整 MCP 能力。
- 只能部署在不暴露公网的可信内网，禁止映射到公网。企业内网本身已经封闭时，不需要额外配置
  CIDR/iptables；需要更细粒度隔离时可将其作为可选加固。
- 浏览器请求仍受 `Origin` allowlist 校验；它与 CIDR 无关，也不是用户身份认证。
- MCP 内嵌现有 API，没有第二个服务或端口。PostgreSQL、MinIO 和 API 仍不发布宿主机端口。
- Caddy access log 默认关闭，runtime error log 会删除 request URI。若现场前置代理或负载均衡
  记录完整 URI，必须先跳过或脱敏 `/api/mcp-files/process/*` 和
  `/api/mcp-files/export/*`。
- Agent 不需要访问 OpenAI、npm、镜像仓库或其他公网；只需要能访问这台 Databench。

## 2. Agent 连接参数

把以下参数填入 agent 自己的 MCP 配置界面或配置文件：

| 字段 | 值 |
|---|---|
| 名称 | `databench` |
| Transport | Streamable HTTP |
| URL | `http://<稳定内网 IP 或 DNS>/api/mcp` |
| Authentication | None / 不配置凭据 |

不要把 URL 写成 `/mcp`、`/api` 或 `/api/mcp/`。同一个 agent 还必须能流式访问 server 返回的绝对
`PUT /api/mcp-files/process/...` 和 `GET /api/mcp-files/export/...` URL；只连通 MCP JSON-RPC 而
无法访问 companion URL，不能完成文件导入或导出。

连接后应能看到且只看到四个 tools：

1. `contract_get`
2. `data_process_prepare`
3. `dataset_show`
4. `dataset_export_canonical_prepare`

## 3. 用户怎么说

用户不需要准备中间 JSONL，也不需要知道 tool 名。可以直接把 Excel/CSV 放进 agent 可读的位置并
使用自然语言：

```text
把这个 Excel 导入 Databench。
```

映射足够确定时，agent 可以直接导入，不机械地要求再次批准。用户希望先确认时可以说：

```text
先识别 sheet、字段映射和三条样例给我看；按我修改后的要求再导入 Databench。
```

只需要文件时可以说：

```text
不要导入数据集，只生成 Databench canonical JSONL 给我。
```

Agent 应根据当前指令和映射确定性自主选择 direct import、preview/修改后 import 或 JSONL-only；
preview 不是服务端审批状态机。

## 4. Agent 必须遵守的流程

1. 只读检查 workbook、sheet、used range、headers 和数据量。
2. 调用 `contract_get(name="canonical-draft-import")`，按当前 schema、rules、examples 和 limits
   把 Excel/CSV 行映射成临时 `canonical-draft-jsonl-v1`。
3. 不自行编造 `rec_*`、`cand_*`、`sig_*` 或 `pref_*` IDs。
4. 根据用户意图选择：
   - `import-dataset`：登记稳定 IDs 并发布 immutable dataset，不更新 ref；
   - `validate-preview`：完整校验但不写入，返回计数、样例和 exact-byte digest；
   - `materialize-jsonl`：登记稳定 IDs 并返回 canonical JSONL，不发布 dataset/ref/object。
5. 如果做过 preview 且继续使用同一份 bytes，把 `input_digest` 作为
   `expected_input_digest`；内容改变后重新 preview，或按用户当前明确指令继续。
6. 使用 prepare 返回的一次性绝对 URL 流式 PUT/GET，文件 bytes 不放进 MCP JSON 参数。
7. 完成后删除 agent-owned 临时 draft；只报告 exact dataset version，或把用户要求的 JSONL 文件
   交付给用户。

JSONL-only 不是完全无写：它不会创建数据集，但会永久登记 Databench 分配的 immutable identity
claims，保证以后用相同 exact bytes 导入时得到相同 IDs。

## 5. 重试规则

| 现象 | Agent 动作 |
|---|---|
| `429` 且有 `Retry-After` | 等待后复用同一个 URL；该 token 尚未消费 |
| token 已用、过期、API 重启或传输超时 | 重新调用 prepare，使用新 URL |
| `input_digest_mismatch` | 上传 preview 对应的 exact bytes，或重新 preview 当前内容 |
| validation error | 按返回的 line/path 修复 draft，再重新 prepare/upload |
| import 响应丢失 | 重新 prepare 并上传相同 exact bytes；结果应是同一 dataset version |
| materialize 响应丢失 | 重新 prepare 并上传相同 exact bytes；结果应是相同 canonical JSONL |

不要尝试恢复、猜测或记录一次性 token。进程重启后旧 token 必然失效；已经成功提交的 dataset 不
受影响。

## 6. 上线验收

在实际断公网的目标环境，用真实内网 URL 和目标 agent 完成：

1. MCP initialize、tools/list、`contract_get`；
2. 直接把原始 Excel 导入，返回 exact dataset version；
3. 先 preview 三条样例，修改映射后再导入；
4. JSONL-only，确认 `dataset_show` 对 prospective version 返回 not found；
5. 对已导入 dataset 执行 show、canonical export 和 reimport，version 不变；
6. 重启 API，确认旧一次性 URL 失效，重新 prepare 后恢复；
7. 检查 API、Web 与现场前置代理日志，不包含 `proc_<64 hex>` 或 `exp_<64 hex>`。

上述验收只授权 ADR 0012 的可信内网离线通道，不表示 Databench 已具备公网 MCP、应用认证或
多租户能力。
