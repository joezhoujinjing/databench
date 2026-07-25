# MCP 目标 Agent 能力预检

- **日期:** 2026-07-25
- **目标:** 在服务端 M1 实现前确认 code agent 能承担 Excel→canonical draft 的客户端职责
- **原则:** 本文记录能力证据，不把 agent 的语义推断伪装成确定性服务端测试

## 1. 能力矩阵

| 能力 | M0 结果 | 证据 / 后续 gate |
|---|---|---|
| 读取本地 `.xlsx` | ✅ 已验证 | 目标开发 agent 使用固定 spreadsheet runtime 只读导入真实电缆工作簿 |
| 识别 sheet/range/header/count | ✅ 已验证 | `Sheet1`、`A1:C500`、3 列表头、499 条非空数据记录 |
| 创建并删除临时 JSONL | ✅ 已验证 | 本地 harness 以 `wx` 创建 0600 临时 JSONL，传输后删除文件与临时目录 |
| 流式 HTTP PUT/GET | ✅ 已验证 | 本地 loopback harness 从文件流 PUT 33 bytes，并分块 GET 22 bytes；M1a 再以真实 companion URL smoke |
| Streamable HTTP MCP | 🟡 待端点联调 | 目标 agent 支持配置 HTTP MCP；M1a endpoint 可用后必须完成 initialize/tools/list/tools/call smoke |
| 访问绝对内网 URL | 🟡 待部署联调 | M1a 用本机 public base 验证；M2 用实际 Caddy `/api` public base 和防火墙环境复验 |

黄色项不是已发现的能力缺失，而是服务端 endpoint/实际内网地址尚不存在，无法在 M0 伪造成功
证据。它们是 GM1a 和 GM2 的显式 blocking smoke：失败则停在对应 Step，不能宣布闭环可用。

本地 HTTP harness 只证明 agent runtime 能创建/删除临时文件并进行流式 request/response；它不
替代 MCP 协议、token 生命周期、Workspace 操作或 Caddy 前缀的真实联调。

## 2. 真实 Excel 只读结果

输入文件：`电缆_DEMO_20260723.xlsx`。

```text
sheet count:          1
sheet:                Sheet1
used range:           A1:C500
rows:                 500（1 header + 499 data）
columns:              3
headers:              SPU_ID, COMBINED_GOODS_INFO, ATTR_JSON
first data cell types: number, string, string
```

预检只读取 workbook metadata、used range、表头、非空数据行数和首行值类型。没有修改、重算、保存
或导出原工作簿。

499 条数据的 `SPU_ID` 均为 `10037`，只有 1 个 unique value，因此它不能作为
`source.original_id` 的行级稳定 ID。Agent 的首期映射应把它放入 namespaced `extra`，并令
`source.original_id=null`；最终仍以用户当前指令和实际数据检查为准。

## 3. Agent 责任边界

目标 agent 必须：

1. 自己读取 Excel/CSV，识别 sheet、headers、数据类型和明显的数据质量问题；
2. 调用 `contract_get` 获取实时 schema/rules/examples/limits，不缓存一份私有“标准”；
3. 生成无 Databench-managed IDs 的临时 `canonical-draft-jsonl-v1`；
4. 从用户意图与映射确定性判断直接 import、可选 preview/修改，或 JSONL-only；
5. 使用 prepare 返回的绝对 URL 流式 PUT/GET，不把文件 bytes 塞进 MCP JSON；
6. 完成后删除 agent-owned 临时 draft，只报告用户需要的结果。

目标 agent 不得：

- 自行生成 `rec_*`、`cand_*`、`sig_*`、`pref_*` IDs；
- 因为服务端提供 preview 就强制用户经历审批状态机；
- 把“只生成 JSONL”替换成 dataset import；
- 把本地路径交给服务端读取，或要求 MCP server 执行 shell/Python/任意代码。

## 4. 后续强制 Smoke

### GM1a 本机联调

```text
target agent → MCP initialize → tools/list → contract_get
             → data_process_prepare(canonical preview/import)
             → absolute URL PUT
             → dataset_show
             → dataset_export_canonical_prepare → absolute URL GET
```

必须证明同一 agent 能处理 MCP control plane 与 companion data plane；仅用 curl 单测 route 不足以
替代 agent MCP smoke。

### GM1b3 真实 Excel 验收

只把原始电缆 Excel 和自然语言指令交给 agent，分别完成：直接导入；先看样例并修改后导入；只生成
canonical JSONL。用户不手工制作中间 JSONL。

### GM2 内网离线验收

在断开公网、使用实际内网 DNS/Caddy 地址的目标 agent 环境重跑 GM1b3 生命周期，确认不访问
OpenAI、npm、镜像仓库或其他公网服务。
