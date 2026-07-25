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
| Streamable HTTP MCP | ✅ GM1a 已验证 | 目标开发 agent 连接真实 TCP endpoint，完成 initialize/tools/list/tools/call 与四工具 smoke |
| 访问绝对 URL | ✅ 本机已验证 | 目标开发 agent 使用 prepare 返回的 `http://127.0.0.1:18080` 绝对 URL 完成 PUT/GET；M2 用实际内网 Caddy `/api` 地址复验 |

GM1a 的真实 endpoint 已完成；实际内网 DNS/Caddy 与防火墙环境仍不存在，因此只把该部署环境复验
保留为 GM2 blocking smoke，不能用本机 loopback 证据替代。

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

**结果：✅ 2026-07-25 已完成。** 当前 Codex 目标开发 agent 启动真实 API TCP endpoint，使用官方
TypeScript MCP Client 身份 `codex-target-agent-smoke` 完成：

- initialize instructions guard、`tools/list` 四工具与 `contract_get(canonical-jsonl@2.0.0)`；
- `data_process_prepare` 后以 10 个 137-byte 级别的 body chunks PUT 同一份 3-record canonical
  JSONL，分别完成 no-write preview 与 dataset import；
- `dataset_show` 返回 exact version
  `8e3d6141d4c74c102cf52cbde258ce01c76ea4e02fc4b70c0e02f220913b14a8`；
- `dataset_export_canonical_prepare` 返回绝对 GET URL，agent 通过 response reader 读取 1362 bytes；
- smoke 使用独立 Postgres schema 与现有 MinIO，完成后停止临时 API、删除 test schema，并将临时
  root 移入废纸篓；未触碰 public catalog。

这证明同一目标开发 agent 能处理 MCP control plane 与 companion PUT/GET data plane。M1a 仍只接受
已有 Databench-managed IDs 的 canonical JSONL；Excel/CSV 与 canonical draft 验收仍分别属于
GM1b3/GM2，不在这里提前宣称可用。

### GM1b3 真实 Excel 验收

只把原始电缆 Excel 和自然语言指令交给 agent，分别完成：直接导入；先看样例并修改后导入；只生成
canonical JSONL。用户不手工制作中间 JSONL。

**结果：✅ 2026-07-25 已完成。** 当前 Codex 目标开发 agent 在真实 Postgres、MinIO 与 API TCP
endpoint `http://127.0.0.1:18080` 上完成：

- 通过 spreadsheet runtime 重新只读导入原始 `.xlsx`，生成 499 行、716,367 bytes 的 0600 临时
  draft；workbook BLAKE3 在验收前后均为
  `27762b6e7c866b166a5b25c9fc329e78f3250206f8a11cd244dc49545f6f3b48`，draft BLAKE3 为
  `76d426e6157e3e1ba3fc86676973b80238ecc38f9c5c3bb595111d6702d1bd0b`；
- 调用 `contract_get(canonical-draft-import@1.0.0)` 后，不经过 preview 直接流式 PUT draft，得到
  dataset version `9e59b4edfd42e3c24fe4e03c698717c034734377931091dfef5f20e3891a101c`；
  `dataset_show` 返回 499 条，export 得到 858,083 bytes canonical JSONL，再导入保持同一 version；
- 按“不要固定 system”的反馈机械移除全部 system content，再次 preview 返回 499 条、3 条样例与
  digest `f361437b189f9edf2300481d3983ddce77b6956803e90f39efa92d935127ca82`；携带该 digest
  导入得到 version `4bee431343b9c15cf6bd460f17dd380b88d058f78051b880f157b5d3f269686d`；
- 按“只生成 JSONL”意图直接 materialize，流式保存 499 行、869,061 bytes canonical JSONL；响应
  给出的 prospective version 为
  `61ce13c4c731f3254b51c6f62ed0d5564bf7abda81aa2a9871d23751a629fb17`，随后
  `dataset_show` 明确 not found，证明未发布 dataset；
- 两条 dataset import 的 `ref_update` 都是 `not_requested`。验收后停止临时 API，删除独立 test
  schema 与 4 个精确 MinIO test objects，并将 agent-owned 临时目录移入废纸篓；没有覆盖用户已有
  JSONL，也没有触碰 public catalog。

这些 exact versions 是本次持久 Workspace namespace 内的验收证据。Draft managed IDs 包含
namespace；全新 test schema 会创建新的 namespace UUID，因此不能把这些值误写成跨 namespace
fixed vectors。自动测试锁定原始 draft bytes/digests，并在同一 namespace 内断言
materialize/import/export/reimport 的 exact version 一致性。

### GM2 内网离线验收

在断开公网、使用实际内网 DNS/Caddy 地址的目标 agent 环境重跑 GM1b3 生命周期，确认不访问
OpenAI、npm、镜像仓库或其他公网服务。
