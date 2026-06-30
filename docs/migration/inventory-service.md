# databench 服务 / 契约 / 行为迁移清单

本文基于实际代码梳理，目标是把当前 Python FastAPI 服务逐功能迁移到 TS monorepo。已读范围：

- `databench/databench/service/app.py`
- `databench/databench/service/routers/*.py`
- `databench/databench/service/schemas.py`
- `databench/databench/service/deps.py`
- `databench/databench/service/registry.py`
- `databench/databench/service/errors.py`
- `databench/databench/service/meta.py`
- `databench/scripts/export_openapi.py`
- 关联域模型：`schema.py`、`dataset.py`、`io.py`、`ops.py`、`recipe.py`、`workspace.py`、`catalog.py`、`store.py`
- 行为来源：`tests/*`、`examples/load_demo.py`
- 前端调用：`databench-ui/src/api/*`
- 契约文件：`databench/openapi/openapi.json`、`databench-ui/schema/openapi.json`

## 逐端点功能清单

### API-01

- **功能ID**：`API-01`
- **名称**：健康检查
- **作用**：返回服务可用性、当前 workspace root、服务版本。
- **现位置**：Python `databench/service/app.py:create_app.health`
- **端点**：`GET /health`
  - 查询参数：无
  - 请求体：无
  - 响应体：开放字符串字典；实际字段为 `{status: "ok", workspace_root: string, version: string}`
- **关键规则与边界**：
  - 不带 `/v1` 前缀。
  - `workspace_root` 来自 `DATABENCH_ROOT` 或默认 `./bench`。
  - `version` 来自 `databench.__version__`，当前为 `0.0.1`。
  - OpenAPI 只声明为 `Record<string,string>`，没有固定列出 3 个字段。
- **TS 目标**：`apps/api` Hono 根路由；`packages/schema` 可选定义 `HealthInfo`。
- **依赖**：`SVC-03`、`SVC-04`
- **验收点**：请求 `/health` 得到 200，`status === "ok"`，包含当前 root 和服务版本；本地 Vite Origin 请求可获得 CORS 回显。
- **备注/疑点**：`tests/test_service.py:test_health` 只断言 `status`，但实现额外返回 `workspace_root` 和 `version`，迁移时不要丢。

### API-02

- **功能ID**：`API-02`
- **名称**：版本握手
- **作用**：前端连接时读取 API major、服务版本、数据 schema 版本。
- **现位置**：Python `databench/service/app.py:create_app.version`、`databench/service/meta.py:version_info`
- **端点**：`GET /version`
  - 查询参数：无
  - 请求体：无
  - 响应体：`VersionInfo {api_version, service_version, schema_version}`
- **关键规则与边界**：
  - 不带 `/v1` 前缀。
  - `api_version` 固定 `"v1"`，和 `/v1` URL 前缀一致。
  - `service_version` 来自 `databench.__version__`，当前 `"0.0.1"`。
  - `schema_version` 固定 `"1"`。
  - 测试断言响应键集合必须正好是 `{api_version, service_version, schema_version}`。
- **TS 目标**：`apps/api` Hono 根路由；`packages/schema` 的版本常量。
- **依赖**：`SVC-04`
- **验收点**：`GET /version` 返回 200；字段集合严格一致；前端 `checkCompatibility` 能解析 major `1`。
- **备注/疑点**：若 TS schema 有破坏性变化才 bump `schema_version`。

### API-03

- **功能ID**：`API-03`
- **名称**：运行时能力握手
- **作用**：告诉前端当前部署实际启用的模块能力。
- **现位置**：Python `databench/service/app.py:create_app.get_capabilities`、`databench/service/meta.py:capabilities`
- **端点**：`GET /capabilities`
  - 查询参数：无
  - 请求体：无
  - 响应体：`Capabilities {api_version, min_client, features: Record<string, boolean>}`
- **关键规则与边界**：
  - 不带 `/v1` 前缀。
  - `api_version` 固定 `"v1"`。
  - `min_client` 固定 `"0.1.0"`。
  - 当前实际 features：
    - `transforms`: `len(TRANSFORMS) > 0`，当前 `true`
    - `recipes`: `hasattr(Workspace, "materialize")`，当前 `true`
    - `lineage`: `hasattr(Workspace, "lineage")`，当前 `true`
    - `jsonl_ingest`: `hasattr(Workspace, "add_jsonl")`，当前 `true`
    - `export`: `hasattr(Workspace, "export")`，当前 `true`
    - `synthesis`: `importlib.util.find_spec("databench.synthesis") is not None`，当前 `false`
    - `annotation`: `importlib.util.find_spec("databench.annotation") is not None`，当前 `false`
    - `vocabularies`: `hasattr(Workspace, "derive_vocabulary")`，当前 `true`
  - 前端 `useModuleEnabled` 对缺失 feature 采用宽松逻辑：缺失不等于 `false`，因此 vocabularies 缺失时 UI 仍可能显示词表页。
- **TS 目标**：`apps/api` capability route；`packages/schema` capability schema。
- **依赖**：`SVC-04`、`SVC-05`、各模块注册。
- **验收点**：测试断言 `transforms/recipes/lineage` 为 `true`，`synthesis/annotation` 为 `false`；前端连接时 compatibility 为 ok。
- **备注/疑点**：D1 已改为实现词表模块；TS 后端应显式返回 `vocabularies:true`，前端入口仍按能力位展示。

### API-04

- **功能ID**：`API-04`
- **名称**：JSON body 样本入库
- **作用**：把已符合统一 `Sample` 判别联合的样本数组写成一个内容寻址 dataset，并可设置 named ref。
- **现位置**：Python `databench/service/routers/datasets.py:ingest_samples`
- **端点**：`POST /v1/datasets`
  - 查询参数：无
  - 请求体：`IngestSamplesRequest {name?: string|null, message?: string|null, samples: Sample[]}`
  - 响应体：`Manifest`
- **关键规则与边界**：
  - `Sample` 是 `kind` 判别联合：`sft`、`preference`、`rl`、`trajectory`。
  - JSON body 路径不做 JSONL 简写归一化；`chosen/rejected` 纯字符串等简写只在 JSONL ingest 里归一化。
  - Pydantic 默认忽略模型未定义字段；例如客户端传入 `id` 不是合同字段，不能依赖其被保存。
  - `name` 传给 `Dataset.from_samples` 成为 `Manifest.name`；只有 truthy `name` 才写入 catalog ref。
  - `message` 只用于 `catalog.set_ref(name, version, message)`；若无 truthy `name`，message 不落库。
  - dataset version 由行摘要顺序无关计算；样本 `source/meta/signals` 不影响 sample id，但会影响 dataset version。
  - 校验失败走 `ERR-01` 或 `ERR-02` 的 422 envelope。
- **TS 目标**：`apps/api` `/v1/datasets` Hono route；`packages/schema` Sample 和 Ingest schema；`packages/workspace` `addSamples`。
- **依赖**：`SCHEMA Sample`、`DATASET Manifest`、`WS add_samples`、`STORE write`、`CATALOG refs`
- **验收点**：POST 3 条 SFT 样本返回 `num_rows: 3`、`kinds: {sft: 3}`；带 `name` 后 `/v1/refs/{name}` 能解析到 version。
- **备注/疑点**：空字符串 `name` 会成为 manifest name，但不会创建 ref；如果 TS 要收紧，应明确破坏性差异。

### API-05

- **功能ID**：`API-05`
- **名称**：JSONL multipart 上传入库
- **作用**：接收上传的 JSONL 文件，按行读取、自动检测或强制指定 kind，归一化简写后写成 dataset。
- **现位置**：Python `databench/service/routers/datasets.py:ingest_jsonl`
- **端点**：`POST /v1/datasets:ingest-jsonl`
  - 查询参数：`name?: string|null`、`kind?: "sft"|"preference"|"rl"|"trajectory"|null`、`source?: string|null`
  - 请求体：`multipart/form-data`，字段名必须是 `file`，类型 `UploadFile`
  - 响应体：`Manifest`
- **关键规则与边界**：
  - 实现先 `await file.read()`，整文件读入内存，再写入临时 `.jsonl` 文件；不是流式 ingest。
  - `source` 缺省且上传文件有 `filename` 时，默认 `Path(filename).stem`，避免记录随机临时路径。
  - 若 `source` 仍为空，`read_jsonl` 会用临时路径 stem 作为默认 source。
  - JSONL 空行跳过。
  - `kind` 不传时逐行检测；传入时所有行强制为该 kind。
  - `detect_kind` 判定顺序：先 `chosen`+`rejected` 为 `preference`，再 `rollouts` 为 `rl`，再 `messages`，其中 message 含 `tool_calls`、`role == "tool"` 或 `tool_call_id` 判为 `trajectory`，否则 `sft`。
  - 简写归一化：
    - preference `prompt` 字符串变 `[{role:"user", content}]`
    - preference `chosen/rejected` 字符串变 assistant message
    - rl `prompt` 字符串变 user message
    - sft/trajectory `messages` 假定已是 message dict 数组
  - 记录内已有 `source` 时，不被 query/default source 覆盖。
  - JSON decode 错误和无法检测 kind 抛 `ValueError`，映射到 400 `bad_request` envelope。
  - 临时文件在 finally 中删除。
- **TS 目标**：`apps/api` multipart route；`packages/io` JSONL parser；`packages/workspace` `addJsonl`。
- **依赖**：`IO detect_kind/read_jsonl`、`SCHEMA Sample`、`WS add_jsonl`、`STORE`、`CATALOG`
- **验收点**：上传 `preference.jsonl` 且不传 source，返回 2 行；随后 `/samples` 中每条 `source === "preference"`；强制 kind 和错误 JSONL 各有对拍用例。
- **备注/疑点**：大文件内存读是当前行为；TS 如果改成流式，要保持外部结果一致。

### API-06

- **功能ID**：`API-06`
- **名称**：获取 dataset manifest
- **作用**：按 ref 名或具体 version 读取 dataset manifest。
- **现位置**：Python `databench/service/routers/datasets.py:get_dataset`
- **端点**：`GET /v1/datasets/{ref}`
  - 路径参数：`ref: string`
  - 请求体：无
  - 响应体：`Manifest`
- **关键规则与边界**：
  - `Workspace.get` 先通过 catalog resolve：若 `ref` 是已登记 dataset version 直接返回；若是 named ref，则取其 version；否则把输入当 version。
  - 若 store 中不存在最终 version，`LocalBlobStore.read` 抛 `KeyError`，映射 404 `not_found`，message 为 `dataset version not found in store: {version}`。
  - 响应 manifest 字段：`name?`、`version`、`schema_version` 默认 `"1"`、`hash_algo` 默认 `"blake3"`、`num_rows`、`kinds`、`columns`、`created_at`。
- **TS 目标**：`apps/api` dataset get route；`packages/workspace` `get`；`packages/store` read。
- **依赖**：`WS get`、`CATALOG resolve`、`STORE read`、`DATASET Manifest`
- **验收点**：ingest 后用 ref 和 version 都能取到同一 manifest；未知 ref/version 为 404 envelope。
- **备注/疑点**：manifest `created_at` 是 dataset 构建时间，不是 catalog 读取时间。

### API-07

- **功能ID**：`API-07`
- **名称**：分页预览样本
- **作用**：读取 dataset 的样本页，供 UI 虚拟列表分页加载。
- **现位置**：Python `databench/service/routers/datasets.py:preview_samples`
- **端点**：`GET /v1/datasets/{ref}/samples`
  - 路径参数：`ref: string`
  - 查询参数：`limit: int = 20`，`1 <= limit <= 500`；`offset: int = 0`，`offset >= 0`
  - 请求体：无
  - 响应体：`SamplesPage {total, limit, offset, items: Sample[]}`
- **关键规则与边界**：
  - 分页常量来自 `meta.py`: `DEFAULT_PAGE_LIMIT = 20`、`MAX_PAGE_LIMIT = 500`。
  - 超出上限如 `limit=5000` 由 FastAPI/Pydantic 触发 422 `validation_error` envelope。
  - `limit=500` 正常接受。
  - 实现用 `islice(ds.to_samples(), offset, offset + limit)`，即按底层 frame 当前顺序切片。
  - `offset` 超过 total 时返回空 `items`，`total` 仍为 dataset 总行数。
  - `Sample.id` 是 Python property，不是 Pydantic 字段；OpenAPI 不声明，`model_dump` 不包含。前端类型把 `id` 标为 optional。
  - 响应样本会包含 Pydantic 字段默认值，例如 `source`、`meta`、`signals`，message 内 null 字段是否出现取决于 FastAPI 序列化默认。
- **TS 目标**：`apps/api` samples route；`packages/schema` Page/Sample；`packages/workspace` get/toSamples。
- **依赖**：`API-06`、`DATASET to_samples`、`SCHEMA Sample`
- **验收点**：3 行 dataset 请求 `limit=2&offset=1` 返回 `total=3`、`offset=1`、2 条 item；`limit=5000` 返回 422 envelope。
- **备注/疑点**：如果 TS API 想在样本响应中显式带 `id`，需同时更新 OpenAPI 和前端类型，不是当前 Python 合同。

### API-08

- **功能ID**：`API-08`
- **名称**：流式导出 dataset 为 JSONL
- **作用**：把 dataset 作为训练格式 NDJSON 流下载。
- **现位置**：Python `databench/service/routers/datasets.py:export_dataset`、`databench/workspace.py:_export_record`
- **端点**：`GET /v1/datasets/{ref}/export`
  - 路径参数：`ref: string`
  - 查询参数：`fmt: string = "messages-jsonl"`
  - 请求体：无
  - 响应体：`StreamingResponse`，实际 `media_type = "application/x-ndjson"`
- **关键规则与边界**：
  - 每个 sample yield 一行：`json.dumps(_export_record(sample, fmt), ensure_ascii=False) + "\n"`。
  - `Content-Disposition` 为 `attachment; filename="{ds.name or ds.version[:12]}.jsonl"`。
  - 当前 `_export_record` 接收 `fmt` 但不分支使用；任意 fmt 值都会按 kind 走同一输出逻辑。
  - sft/trajectory 导出 `{messages: [...]}`，并对 message `exclude_none=True`。
  - preference 导出 `prompt/chosen/rejected`，不导出 `candidates/meta/signals/source`。
  - rl 导出 `prompt/answer/verifier/rollouts`，不导出 `meta/signals/source`。
  - OpenAPI 当前错误地把 200 内容标为 `application/json` 且 schema `{}`；运行时是 NDJSON 流。
  - 失败读取 ref 的错误同 `API-06`。
- **TS 目标**：`apps/api` streaming route；`packages/io` export serializer；`packages/workspace` export。
- **依赖**：`WS get/export`、`SCHEMA Sample`、`IO export`
- **验收点**：2 条混合样本导出 2 行 JSONL，一行含 `messages`，一行含 `chosen`；响应 header 是 NDJSON 和 attachment filename。
- **备注/疑点**：`Recipe.target_format` 和 export `fmt` 都有 `"trl"` 选项/入口，但当前导出逻辑没有实现 TRL 差异。

### API-09

- **功能ID**：`API-09`
- **名称**：列出可用 transforms
- **作用**：返回服务注册表中可通过 HTTP 执行的 transform 及其参数 schema。
- **现位置**：Python `databench/service/routers/transforms.py:list_transforms`
- **端点**：`GET /v1/transforms`
  - 查询参数：`limit: int = 20`，`1 <= limit <= 500`；`offset: int = 0`，`offset >= 0`
  - 请求体：无
  - 响应体：`TransformsPage {total, limit, offset, items: TransformInfo[]}`
- **关键规则与边界**：
  - `TRANSFORMS.values()` 按 `t.name` 排序后分页。
  - 当前实际暴露 4 个 transform：
    - `dedup`, version `"1"`, `params_schema: null`
    - `enrich_length`, version `"1"`, `params_schema: null`
    - `filter_by_signal`, version `"1"`, params schema `SignalFilterParams {key: string required, min?: number|null = null, max?: number|null = null}`
    - `sample_n`, version `"1"`, params schema `SampleNParams {n: int required, seed: int = 0}`
  - 参数 schema 来自 Pydantic `model_json_schema()`，不是手写。
  - 分页上限和错误同 `API-07`。
- **TS 目标**：`apps/api` transforms list route；`packages/ops` registry；`packages/schema` transform schemas。
- **依赖**：`SVC-05`、`OPS registry`
- **验收点**：列表包含上述 4 个名字；`filter_by_signal` 和 `sample_n` 返回可供 UI 展示的 params_schema；分页 cap 生效。
- **备注/疑点**：注册表通过扫描 `vars(databench.ops).values()`，TS 应避免意外暴露非内置 transform。

### API-10

- **功能ID**：`API-10`
- **名称**：执行 transform
- **作用**：按名称运行一个已注册 transform，自动解析输入 dataset、校验参数、缓存命中、记录 lineage，并可设置输出 ref。
- **现位置**：Python `databench/service/routers/transforms.py:run_transform`
- **端点**：`POST /v1/transforms/{name}/run`
  - 路径参数：`name: string`
  - 请求体：`TransformRunRequest {inputs: string[], params: Record<string, any> = {}, ref?: string|null}`
  - 响应体：`Manifest`
- **关键规则与边界**：
  - 未知 transform 显式抛 `HTTPException(404, "unknown transform: {name}")`，经 `ERR-03` 包装为 `not_found`。
  - `inputs` 只要求数组存在，没有最小长度校验；具体 transform 参数数量错误可能以 `TypeError` 400 暴露。
  - 每个 input 通过 `Workspace.get` 解析 ref 或 version。
  - `params` 对 paramless transform 必须为空，否则 `Transform.build_params` 抛 `TypeError`，映射 400。
  - 有 params_model 的 transform 用 Pydantic 校验；失败映射 422。
  - 缓存键内容：`{op, op_version, inputs: [input versions], params: canonical params dict}` 的 hash。
  - 若 catalog 找到 cache_key 且 store 中对象存在，直接读 cached output，不新增 run row。
  - 否则执行 transform；返回 `Dataset` 原样使用，返回 Polars DataFrame 通过 `_coerce` 转 dataset，其他类型 TypeError 400。
  - run 记录包含 op、op_version、params、input versions、output_version；lineage 依赖这些 run rows。
  - truthy `ref` 会写 catalog ref；当前内置 ops 返回的 manifest name 通常保留输入 dataset name，不一定等于 `ref`。
- **TS 目标**：`apps/api` transform run route；`packages/workspace` run/cache/lineage；`packages/ops` transforms。
- **依赖**：`API-09`、`WS run`、`OPS-*`、`CATALOG runs/refs`、`STORE`
- **验收点**：先对重复 SFT 运行 `enrich_length`，再对输出 version 运行 `dedup` 且 `ref=sft-clean`，返回 `num_rows=2`；第二次同参数运行命中缓存不新增 run。
- **备注/疑点**：参数 canonical 化用 Pydantic `model_dump(mode="json")`；TS zod 输出顺序和默认值需要对齐，否则 cache key 会漂移。

### API-11

- **功能ID**：`API-11`
- **名称**：物化 recipe 混合数据集
- **作用**：解析 recipe 的多个 dataset source，按权重、上限、目标大小和 seed 生成可复现训练混合数据集。
- **现位置**：Python `databench/service/routers/recipes.py:materialize_recipe`、`databench/workspace.py:Workspace.materialize`
- **端点**：`POST /v1/recipes:materialize`
  - 请求体：`MaterializeRequest {recipe: Recipe, ref?: string|null}`
  - 响应体：`Manifest`
- **关键规则与边界**：
  - `Recipe {name, sources, target_format="messages-jsonl", target_size?: int|null, seed=0}`。
  - `RecipeSource {dataset: string, weight?: number|null, max_samples?: int|null}`。
  - 每个 source dataset 先 resolve 到 concrete version，再读取 frame。
  - 单 source 基础数量为 frame height；若 `max_samples` 存在则取 min。
  - 有 `target_size` 时，按 `(weight or 1.0) / total_weight` 计算 share，`round(share * target_size)` 后再受 base cap 限制；总和不保证严格等于 `target_size`。
  - 无 `target_size` 时使用各 source base count。
  - 当 count 小于 frame.height，使用 Polars `sample(n=count, seed=recipe.seed)`；否则不打乱。
  - 每个 frame 只选择 canonical `COLUMNS` 后 concat。
  - sources 为空时会生成空 dataset，schema 为所有 `COLUMNS` 的 Utf8。
  - cache key 为 `hash({op: "recipe:{name}", fingerprint})`，fingerprint 包含 recipe JSON 和 resolved versions。
  - lineage run op 为 `recipe:{recipe.name}`，op_version 固定 `"1"`，inputs 为去重排序后的 resolved versions。
  - truthy `ref` 写 catalog ref；manifest name 为 recipe name。
- **TS 目标**：`apps/api` recipe route；`packages/schema` Recipe；`packages/engine` mix；`packages/workspace` materialize。
- **依赖**：`RECIPE mix`、`WS materialize`、`CATALOG runs/refs`、`STORE`
- **验收点**：SFT clean 2 行权重 2 + preference 2 行权重 1，在无 target_size 时输出 4 行；相同 recipe 连续 materialize version 一致；lineage `produced_by.op === "recipe:demo-mix"`。
- **备注/疑点**：`target_format` 当前只进入 recipe fingerprint 和 metadata，不改变 materialize 或 export 行为。

### API-12

- **功能ID**：`API-12`
- **名称**：分页列出 named refs
- **作用**：返回 catalog 中所有 named ref 到当前 dataset version 的映射。
- **现位置**：Python `databench/service/routers/refs.py:list_refs`
- **端点**：`GET /v1/refs`
  - 查询参数：`limit: int = 20`，`1 <= limit <= 500`；`offset: int = 0`，`offset >= 0`
  - 请求体：无
  - 响应体：`RefsPage {total, limit, offset, items: RefInfo[]}`
- **关键规则与边界**：
  - 只返回 named refs，不返回所有 dataset versions。
  - catalog SQL 已 `ORDER BY name`，router 又 `sorted(ws.catalog.list_refs().items())`，最终按 name 字典序稳定排序。
  - 分页用 `islice`，规则同 `API-07`。
  - `RefInfo {name, version}`，不返回 ref message 或 updated_at。
- **TS 目标**：`apps/api` refs list route；`packages/catalog` listRefs。
- **依赖**：`CATALOG refs`
- **验收点**：ingest 或 transform 设置 ref 后，`GET /v1/refs` items 包含该 name/version；limit/offset 和上限验证生效。
- **备注/疑点**：前端 `useRefs(200)` 默认请求 200，不是后端默认 20。

### API-13

- **功能ID**：`API-13`
- **名称**：解析单个 named ref
- **作用**：把 ref 名解析成 concrete dataset version。
- **现位置**：Python `databench/service/routers/refs.py:resolve_ref`
- **端点**：`GET /v1/refs/{name}`
  - 路径参数：`name: string`
  - 请求体：无
  - 响应体：`RefInfo {name, version}`
- **关键规则与边界**：
  - 直接调用 `catalog.get_ref(name)`，不走 `catalog.resolve`。
  - 因此具体 dataset version 字符串若不是 ref 名，也会返回 404。
  - 未知 ref 抛 `HTTPException(404, "unknown ref: {name}")`，经 envelope 返回 code `not_found`。
- **TS 目标**：`apps/api` ref resolve route；`packages/catalog` getRef。
- **依赖**：`CATALOG refs`、`ERR-03`
- **验收点**：`GET /v1/refs/sft-clean` 返回对应 version；`GET /v1/refs/missing` 返回 404 envelope。
- **备注/疑点**：不要把此端点误实现成“ref 或 version 都可解析”，那是 dataset get 的行为。

### API-14

- **功能ID**：`API-14`
- **名称**：读取 lineage DAG
- **作用**：从某个 dataset ref/version 向上递归返回产生它的 transform/recipe 及输入 DAG。
- **现位置**：Python `databench/service/routers/lineage.py:get_lineage`、`databench/workspace.py:Workspace.lineage`
- **端点**：`GET /v1/lineage/{ref}`
  - 路径参数：`ref: string`
  - 请求体：无
  - 响应体：开放 JSON object，典型 `{version, name?, num_rows?, produced_by?, inputs?, cycle?}`
- **关键规则与边界**：
  - `Workspace.lineage` 对字符串先 `catalog.resolve`；未知字符串会原样作为 version。
  - 不读取 store，因此未知 ref/version 不会 404，而是返回 `{version: input}`。
  - 若 catalog 有 dataset metadata，节点追加 `name` 和 `num_rows`。
  - 若 version 已在本次递归 seen set 中，返回节点追加 `cycle: true` 并停止。
  - producers 来自 `catalog.runs_producing(version)`；若多个 producer，只取第一个作为 canonical producer。
  - `produced_by` 形状为 `{op, op_version, params}`；`inputs` 递归展开 run inputs。
  - 原始 ingest dataset 没有 produced_by。
- **TS 目标**：`apps/api` lineage route；`packages/catalog` lineage query；`packages/workspace` lineage。
- **依赖**：`CATALOG datasets/runs`、`WS lineage`
- **验收点**：`sft-clean` lineage 顶层 `produced_by.op === "dedup"`，第一个输入 `produced_by.op === "enrich_length"`，再向上指向原始 raw version。
- **备注/疑点**：未知 ref 不报错是容易漏的行为；如 TS 改为 404，需要同步前端和测试。

## 服务支撑功能清单

### SVC-01

- **功能ID**：`SVC-01`
- **名称**：FastAPI 应用工厂和 `/v1` 路由装配
- **作用**：创建服务实例、挂载 meta routes、把 domain routers 统一挂到 `/v1` 前缀，并安装错误处理器。
- **现位置**：Python `databench/service/app.py:create_app`、`V1_PREFIX`
- **端点**：影响所有端点；domain routes 前缀为 `/{API_VERSION}`，当前 `/v1`
- **关键规则与边界**：
  - `FastAPI(title="databench service", version=__version__, description=...)`。
  - meta routes `/health`、`/version`、`/capabilities` 不带 `/v1`。
  - 只 include 5 个 router module：`datasets`、`transforms`、`recipes`、`lineage`、`refs`。
  - 没有 include vocabularies router。
  - `app = create_app()` 在模块底部创建默认 ASGI app。
  - 测试断言旧未加版本的 domain routes 如 `/datasets`、`/refs` 返回 404。
- **TS 目标**：`apps/api` app bootstrap；Hono route groups `/v1`。
- **依赖**：`SVC-02`、`ERR-*`、`API-*`
- **验收点**：live route list 仅暴露 meta + `/v1` domain；`POST /datasets` 和 `GET /refs` 均 404 envelope。
- **备注/疑点**：FastAPI 自动文档路由 `/docs`、`/redoc`、`/openapi.json` 存在，但不计入产品合同。

### SVC-02

- **功能ID**：`SVC-02`
- **名称**：CORS 与 Private Network Access 预检
- **作用**：允许本地 Vite 和配置的生产 Origin 访问 API，并支持 Chrome PNA preflight。
- **现位置**：Python `databench/service/app.py:CORS_ORIGIN_REGEX`、`cors_origins`、`create_app`
- **端点**：中间件影响所有路径；OPTIONS 预检由 middleware 响应
- **关键规则与边界**：
  - 静态 regex 只允许 `http://localhost:5173`、`https://localhost:5173`、`http://127.0.0.1:5173`、`https://127.0.0.1:5173`。
  - `DATABENCH_CORS_ORIGINS` 用逗号分隔，trim 后作为 exact allowlist。
  - 生产 origin 不硬编码，示例为 `https://databench.jinjing.me`。
  - `allow_methods=["*"]`，`allow_headers=["*"]`。
  - `allow_credentials=False`，不使用 cookie；token 走 header。
  - `allow_private_network=True`。
  - 当预检包含 `Access-Control-Request-Private-Network: true` 且 Origin 允许时，响应 `access-control-allow-private-network: true`。
  - 普通预检不应返回 PNA header。
  - 恶意 suffix/prefix Origin 不回显 `access-control-allow-origin`，但实际 GET 请求本身仍可返回 200。
- **TS 目标**：`apps/api` CORS middleware；必要时自定义 PNA header。
- **依赖**：无，服务启动级。
- **验收点**：测试中的 local origins 回显；配置 prod exact origin 回显；`https://databench.jinjing.me.evil.com` 不回显；PNA header 只在请求 PNA 时出现。
- **备注/疑点**：Hono 常规 CORS middleware 可能不自动支持 PNA，需要补一个 OPTIONS 分支。

### SVC-03

- **功能ID**：`SVC-03`
- **名称**：workspace root 和 Workspace 单例缓存
- **作用**：把 HTTP 请求绑定到共享 Workspace，并按 root 复用实例。
- **现位置**：Python `databench/service/deps.py:workspace_root`、`get_workspace`
- **端点**：所有需要 `Workspace` 的 `/v1` route 通过 FastAPI `Depends(get_workspace)` 使用。
- **关键规则与边界**：
  - 默认 root 为 `./bench`。
  - 环境变量 `DATABENCH_ROOT` 覆盖 root。
  - 模块级 `_workspaces: dict[str, Workspace]` 按 root 字符串缓存。
  - 首次请求某 root 时 `Workspace.open(root)`，后续请求复用同一 handle。
  - 没有关闭或 TTL；不同 root 字符串各有一个实例。
  - 测试通过 `app.dependency_overrides[get_workspace] = lambda: ws` 注入临时 workspace。
- **TS 目标**：`apps/api` dependency/context provider；`packages/workspace` open。
- **依赖**：`WS open`、`STORE`、`CATALOG`
- **验收点**：同一进程内多请求能看到前一个请求写入的 refs/datasets；改变 env root 后使用新的 workspace。
- **备注/疑点**：目标架构使用 Postgres + object store 后，不一定需要进程内 Workspace 缓存，但行为上要保证同一 backend state 可见。

### SVC-04

- **功能ID**：`SVC-04`
- **名称**：服务元信息常量与能力探测
- **作用**：集中维护 API version、schema version、min client、分页默认/上限和 feature detection。
- **现位置**：Python `databench/service/meta.py`
- **端点**：`API-02`、`API-03`、分页 routes
- **关键规则与边界**：
  - `API_VERSION = "v1"`。
  - `SCHEMA_VERSION = "1"`。
  - `MIN_CLIENT = "0.1.0"`。
  - `MAX_PAGE_LIMIT = 500`。
  - `DEFAULT_PAGE_LIMIT = 20`。
  - `_module_available` 捕获 `ImportError` 和 `ValueError`，返回 bool。
  - `detect_features` 在调用时 import `Workspace` 和 `TRANSFORMS`，不是模块加载时固定。
- **TS 目标**：`packages/schema`/`apps/api` contract constants。
- **依赖**：`SVC-05`、`packages/workspace`
- **验收点**：所有分页 route 都使用同一默认和上限；版本和 capabilities 响应一致。
- **备注/疑点**：分页上限也被前端硬编码为 `MAX_PAGE_LIMIT = 500`，迁移改值会影响 UI。

### SVC-05

- **功能ID**：`SVC-05`
- **名称**：transform 注册表
- **作用**：从 `databench.ops` 中发现内置 `Transform` 实例并以 name 建索引。
- **现位置**：Python `databench/service/registry.py:build_registry`、`TRANSFORMS`、`get_transform`
- **端点**：`API-09`、`API-10`、`API-03`
- **关键规则与边界**：
  - 实现：`{obj.name: obj for obj in vars(ops).values() if isinstance(obj, Transform)}`。
  - 当前实际内容是 `dedup`、`enrich_length`、`filter_by_signal`、`sample_n`。
  - 若同名 transform 多次出现，后者覆盖前者。
  - 注册表在模块 import 时构建；后续动态修改 `ops` 不会自动重建。
  - `get_transform` 找不到返回 `None`，由 route 转 404。
- **TS 目标**：`packages/ops` registry；`apps/api` 注入或 import registry。
- **依赖**：`OPS Transform`
- **验收点**：`GET /v1/transforms` 暴露 exactly 当前四个内置 transform；未知 name 运行返回 404 envelope。
- **备注/疑点**：迁移时要确认 registry 是固定 built-in 集合，还是插件式动态发现。

## 请求 / 响应 schema 清单

### CONTRACT-01

- **功能ID**：`CONTRACT-01`
- **名称**：服务层请求、响应和分页模型
- **作用**：定义 HTTP 层自身的 envelope/page/request 模型，并引用核心域模型。
- **现位置**：Python `databench/service/schemas.py`
- **端点**：所有 `/v1` route
- **请求 / 响应体形状**：
  - `IngestSamplesRequest {name?: string|null, message?: string|null, samples: Sample[]}`
  - `TransformRunRequest {inputs: string[], params: Record<string, any> = {}, ref?: string|null}`
  - `TransformInfo {name: string, version: string, params_schema?: object|null}`
  - `RefInfo {name: string, version: string}`
  - `Page {total: int, limit: int, offset: int}`
  - `SamplesPage extends Page {items: Sample[]}`
  - `TransformsPage extends Page {items: TransformInfo[]}`
  - `RefsPage extends Page {items: RefInfo[]}`
  - `MaterializeRequest {recipe: Recipe, ref?: string|null}`
  - 引用核心 `Manifest`、`Recipe`、`Sample`
- **关键规则与边界**：
  - Page 的 `total` 是全集数量，不是当前页数量。
  - Page 的 `limit` 是实际应用的 page size，且应小于等于服务端 cap。
  - `params` default_factory 为空 object，不是 null。
  - `Sample` OpenAPI 是 `kind` discriminator 的 oneOf。
  - `Manifest` 来自核心：`columns` 默认固定 `["id","row_digest","kind","source","payload","meta","signals"]`。
- **TS 目标**：`packages/schema` zod schemas；`@hono/zod-openapi` response/request definitions。
- **依赖**：`SCHEMA Sample`、`DATASET Manifest`、`RECIPE Recipe`
- **验收点**：导出的 OpenAPI component 名称和前端 `types.ts` aliases 可生成兼容类型；分页响应字段完整。
- **备注/疑点**：`ErrorResponse` 模型不在 `schemas.py`，在 `errors.py`，且当前未进入 OpenAPI components。

## 错误合同清单

### ERR-01

- **功能ID**：`ERR-01`
- **名称**：请求校验错误 envelope
- **作用**：把 FastAPI `RequestValidationError` 统一包装。
- **现位置**：Python `databench/service/errors.py:install_error_handlers._on_request_validation`
- **端点**：所有端点
- **响应体形状**：HTTP 422，`{error:{code:"validation_error", message:"request validation failed", detail: exc.errors[]}}`
- **关键规则与边界**：
  - 覆盖 query/path/body/multipart 等请求层校验错误。
  - `detail` 是列表。
  - 当前 OpenAPI 仍声明默认 `HTTPValidationError {detail: ValidationError[]}`，与运行时 envelope 不一致。
- **TS 目标**：`apps/api` 全局 validator error handler；`packages/schema` ErrorResponse。
- **依赖**：zod/Hono validation。
- **验收点**：`GET /v1/datasets/raw/samples?limit=5000` 返回 422 envelope 且 `code === "validation_error"`。
- **备注/疑点**：迁移要决定修正 OpenAPI，还是保留旧 schema 兼容；建议修正为 envelope。

### ERR-02

- **功能ID**：`ERR-02`
- **名称**：Pydantic payload/domain 校验错误 envelope
- **作用**：把 route 内部或 transform params 的 `pydantic.ValidationError` 包装。
- **现位置**：Python `databench/service/errors.py:install_error_handlers._on_validation`
- **端点**：主要影响 `API-04`、`API-10`、`API-11`
- **响应体形状**：HTTP 422，`{error:{code:"validation_error", message:"payload validation failed", detail: exc.errors[]}}`
- **关键规则与边界**：
  - transform params_model 校验失败走这里。
  - 直接 body 解析的 FastAPI validation 多数走 `ERR-01`，不是这里。
- **TS 目标**：`apps/api` domain/schema validation error mapper。
- **依赖**：zod parse errors。
- **验收点**：`filter_by_signal` 缺少 required `key` 或类型错误时返回 422 envelope。
- **备注/疑点**：Hono/zod 的错误结构和 Pydantic `errors()` 不同，若前端读取 detail 需做兼容。

### ERR-03

- **功能ID**：`ERR-03`
- **名称**：HTTPException 状态码映射
- **作用**：把显式 HTTP 错误和 Starlette 404/405 等包装成统一 envelope。
- **现位置**：Python `databench/service/errors.py:install_error_handlers._on_http`
- **端点**：所有端点；显式用于 `API-10`、`API-13`
- **响应体形状**：`{error:{code, message}}`
- **关键规则与边界**：
  - 状态码映射：400 `bad_request`、401 `unauthorized`、403 `forbidden`、404 `not_found`、405 `method_not_allowed`、409 `conflict`、422 `unprocessable_entity`、429 `too_many_requests`、500 `internal_error`。
  - 未列出的 status code 使用 `code: "error"`。
  - message 为 `str(exc.detail)`。
  - unmatched route 也走此 handler，404 code `not_found`。
- **TS 目标**：`apps/api` HTTP error helper/middleware。
- **依赖**：路由错误抛出规范。
- **验收点**：`POST /v1/transforms/nope/run` 返回 404 `{error:{code:"not_found", message:"unknown transform: nope"}}`；`POST /datasets` 返回 404 envelope。
- **备注/疑点**：OpenAPI 没有声明这些 envelope 响应。

### ERR-04

- **功能ID**：`ERR-04`
- **名称**：KeyError 到 404
- **作用**：把 dataset/version/ref 读取中的缺失映射成 404。
- **现位置**：Python `databench/service/errors.py:install_error_handlers._on_key`
- **端点**：`API-06`、`API-07`、`API-08`、`API-10`、`API-11`
- **响应体形状**：HTTP 404，`{error:{code:"not_found", message:string}}`
- **关键规则与边界**：
  - message 优先取 `exc.args[0]`，否则 `str(exc)`。
  - 典型 message：`dataset version not found in store: does-not-exist`。
  - `API-14` lineage 不读取 store，因此未知输入不会触发此错误。
- **TS 目标**：`apps/api` error mapper；`packages/store`/`catalog` not-found errors。
- **依赖**：store/catalog 错误类型。
- **验收点**：`GET /v1/datasets/does-not-exist` 返回 404 envelope。
- **备注/疑点**：TS 不一定有 KeyError，需要定义稳定 NotFound error。

### ERR-05

- **功能ID**：`ERR-05`
- **名称**：ValueError 到 400
- **作用**：把无法解析/无法检测/非法输入这类值错误映射成 bad request。
- **现位置**：Python `databench/service/errors.py:install_error_handlers._on_value`
- **端点**：主要 `API-05`，也可能来自 dataset/frame 构造
- **响应体形状**：HTTP 400，`{error:{code:"bad_request", message:str(exc)}}`
- **关键规则与边界**：
  - JSONL invalid JSON、无法 detect kind 都应走 400。
  - `Dataset.from_frame` 缺少 `payload` 也会 ValueError，若 transform 返回坏 frame 会暴露 400。
- **TS 目标**：`apps/api` bad request mapper；`packages/io` parse errors。
- **依赖**：IO/parser errors。
- **验收点**：上传不含 `messages/chosen+rejected/rollouts` 的 JSONL 行，返回 400 envelope。
- **备注/疑点**：需要区分用户坏输入和内部 bug，当前 Python 都按 400 暴露。

### ERR-06

- **功能ID**：`ERR-06`
- **名称**：TypeError 到 400
- **作用**：把 transform 参数数量/无参 transform 传参/返回类型不对映射成 bad request。
- **现位置**：Python `databench/service/errors.py:install_error_handlers._on_type`
- **端点**：主要 `API-10`
- **响应体形状**：HTTP 400，`{error:{code:"bad_request", message:str(exc)}}`
- **关键规则与边界**：
  - paramless transform 收到 params 时 message 类似 `transform 'dedup' takes no params but got: ['x']`。
  - transform 返回非 Dataset/Polars DataFrame 时 message 类似 `transform must return Dataset or polars.DataFrame, got ...`。
  - Python 函数签名参数数量错误也可能直接暴露。
- **TS 目标**：`apps/api` bad request mapper；`packages/ops` transform runner。
- **依赖**：`WS run`、`OPS Transform`
- **验收点**：`POST /v1/transforms/dedup/run` body 带非空 `params` 返回 400 envelope。
- **备注/疑点**：当前没有通用 `Exception` handler；未归类异常可能走框架默认 500，不保证 envelope。

## OpenAPI 导出清单

### CONTRACT-02

- **功能ID**：`CONTRACT-02`
- **名称**：确定性 OpenAPI 导出
- **作用**：从 FastAPI app 生成稳定 JSON artifact，供前端生成类型。
- **现位置**：Python `databench/scripts/export_openapi.py`
- **端点**：无；输出文件 `databench/openapi/openapi.json`
- **关键规则与边界**：
  - `REPO_ROOT = Path(__file__).resolve().parent.parent`，即 Python 包 repo 根。
  - `OUTPUT = REPO_ROOT / "openapi" / "openapi.json"`。
  - `render()` lazy import `databench.service.app.create_app`，调用 `create_app().openapi()`。
  - JSON 序列化：`indent=2`、`sort_keys=True`、`ensure_ascii=False`，末尾追加 newline。
  - 默认模式覆盖写文件，并自动创建 `openapi/` 目录。
  - `--check` 模式只比较当前文件和 render 结果；不同则 stderr 提示并 exit 1，相同打印 up to date。
  - 本次检查：`uv run python scripts/export_openapi.py --check` 返回 “OpenAPI schema is up to date.”。
- **TS 目标**：`tooling/openapi-export` 或 `apps/api` script；输出供 `apps/web` / openapi-typescript 使用。
- **依赖**：所有 route/schema 已注册。
- **验收点**：TS 导出在相同代码状态下 byte-for-byte deterministic；CI 能跑 `--check`。
- **备注/疑点**：当前 UI 使用的是 `databench-ui/schema/openapi.json`，它领先于后端，多出 vocabularies；不是 Python `databench/openapi/openapi.json` 的纯复制。

## 词表合同清单（D1 已实现）

最新旧后端已在 `feat/vocabulary` 合入词表域与 HTTP 路由；TS 迁移以这些文件和旧 UI 页面为参考：`databench/vocabulary.py`、`databench/workspace.py` vocab methods、`databench/service/routers/vocabularies.py`、`tests/test_vocabulary.py`、`databench-ui/src/pages/Vocabulary*.tsx`。

### CONTRACT-03

- **功能ID**：`CONTRACT-03`
- **名称**：列出 vocabularies
- **作用**：UI 期望分页列出 named vocabulary latest version。
- **现位置**：`databench/service/routers/vocabularies.py:list_vocabularies`、`databench-ui/src/api/client.ts:listVocabularies`
- **端点**：`GET /v1/vocabularies`
  - 查询参数：`limit: int = 20`，`1 <= limit <= 500`；`offset: int = 0`
  - 响应体：`VocabulariesPage {total, limit, offset, items: VocabularyInfo[]}`
- **关键规则与边界**：
  - `VocabularyInfo {id, name?, dimension, num_terms, status?}`。
  - Python 最新实现按 named vocabulary ref 分页返回 latest version 摘要。
- **TS 目标**：`apps/api` vocabulary route、`packages/schema`、store/catalog/workspace 词表域。
- **依赖**：vocabulary domain、catalog vocab refs、object-store vocabulary JSON。
- **验收点**：capabilities 返回 `vocabularies:true`；列表页不 404；返回 `name/id/dimension/num_terms/status`。
- **备注/疑点**：分页行为沿用 refs/transforms 的 `limit/offset` 上限。

### CONTRACT-04

- **功能ID**：`CONTRACT-04`
- **名称**：获取单个 vocabulary
- **作用**：UI 期望按 name 或 content id 获取词表详情。
- **现位置**：`databench/service/routers/vocabularies.py:get_vocabulary`、`databench-ui/src/api/client.ts:getVocabulary`
- **端点**：`GET /v1/vocabularies/{name}`
  - 路径参数：`name: string`
  - 响应体：`Vocabulary-Output`
- **关键规则与边界**：
  - 合同描述：name 或 content id 均可；未知 404。
  - `Vocabulary-Output {id readOnly required, name?, dimension required, terms?, status="curated", source?, meta?}`。
  - `Term {canonical required, aliases?, meta?}`。
- **TS 目标**：`apps/api` vocabulary get route；`packages/schema` Vocabulary schemas。
- **依赖**：vocabulary store/catalog。
- **验收点**：已保存词表可由 route name 和 id 获取；未知返回统一 envelope。
- **备注/疑点**：name/status 是 ref pointer state；按内容 id 获取时保留 blob 自身 name/status。

### CONTRACT-05

- **功能ID**：`CONTRACT-05`
- **名称**：保存 curated vocabulary
- **作用**：UI 期望提交手工整理的 vocabulary，生成新的内容寻址版本。
- **现位置**：`databench/service/routers/vocabularies.py:put_vocabulary`、`databench-ui/src/api/client.ts:putVocabulary`
- **端点**：`PUT /v1/vocabularies/{name}`
  - 路径参数：`name: string`
  - 请求体：`Vocabulary-Input`
  - 响应体：`Vocabulary-Output`
- **关键规则与边界**：
  - UI 文案声明服务端应强制 invariant：canonical 唯一、一个 alias 只能归一个 canonical、aliases 与 canonicals 不相交。
  - `Vocabulary-Input` 不含 read-only id；`dimension` required；`status` enum `draft|curated`，默认 `curated`。
- **TS 目标**：新增 vocabulary write route 和 schema invariant 校验。
- **依赖**：新的 vocabulary hash/content id、catalog latest pointer。
- **验收点**：提交合法词表返回含 id 的 output；冲突 alias/canonical 返回统一 validation envelope；保存 draft 会 promote 为 curated。
- **备注/疑点**：状态是 per-ref，不进入内容 id；同 terms promote 不改 id 但要更新 ref status。

### CONTRACT-06

- **功能ID**：`CONTRACT-06`
- **名称**：从 dataset 派生 draft vocabulary
- **作用**：UI 期望从样本标签中提取 raw/std label pair，持久化 draft vocabulary。
- **现位置**：`databench/service/routers/vocabularies.py:derive_vocabulary`、`databench-ui/src/api/client.ts:deriveVocabulary`
- **端点**：`POST /v1/vocabularies/{name}:derive`
  - 路径参数：`name: string`
  - 查询参数：`dataset: string` required，`dimension: string` required
  - 请求体：`Extractor|null` 可省略
  - 响应体：`Vocabulary-Output`
- **关键规则与边界**：
  - 合同描述：request body 提供 extractor 时使用它，否则按 `dimension` 查服务端 preset；都没有则 400。
  - `Extractor {source:"assistant_json" = default, raw_key: string, std_key: string}`。
  - UI 高级设置要求 raw/std key 必须同时填或同时不填。
- **TS 目标**：vocabulary derive route；dataset label extractor；vocabulary provenance。
- **依赖**：`API-06`/workspace get、vocabulary domain、label extractor presets。
- **验收点**：有 assistant JSON 标签的 dataset 可派生 draft；无 extractor/preset 时 400 envelope。
- **备注/疑点**：derive 会 deterministic 解决 noisy labels；`alias_conflicts` 进入 term meta 供 UI review。

### CONTRACT-07

- **功能ID**：`CONTRACT-07`
- **名称**：按 vocabulary 规范化 dataset 标签
- **作用**：UI 期望把样本标准标签重写为 canonical，产生新 dataset 和 lineage。
- **现位置**：`databench/service/routers/vocabularies.py:normalize_vocabulary`、`databench-ui/src/api/client.ts:normalizeVocabulary`
- **端点**：`POST /v1/vocabularies/{name}:normalize`
  - 路径参数：`name: string`
  - 查询参数：`dataset: string` required，`ref?: string|null`
  - 请求体：`Extractor|null` 可省略
  - 响应体：`Manifest`
- **关键规则与边界**：
  - 合同描述：extractor 从 body、vocab 的 `meta.extractor`、dimension preset 中解析；无 extractor 则 400。
  - 词表未知 404。
  - 成功产生内容寻址 dataset，并记录 lineage。
- **TS 目标**：vocabulary normalize route + transform/enrichment op。
- **依赖**：vocabulary domain、`WS run`/lineage、dataset serializer。
- **验收点**：应用后 refs 刷新；返回 Manifest；lineage 能追到 normalize op。
- **备注/疑点**：lineage op 为 `vocabulary:normalize`，inputs 为 source dataset version + vocabulary id。

### CONTRACT-08

- **功能ID**：`CONTRACT-08`
- **名称**：按 vocabulary 校验 dataset 标签
- **作用**：UI 期望标记 off-vocabulary 样本，并返回 summary 和持久化后的 dataset manifest。
- **现位置**：`databench/service/routers/vocabularies.py:validate_vocabulary`、`databench-ui/src/api/client.ts:validateVocabulary`
- **端点**：`POST /v1/vocabularies/{name}:validate`
  - 路径参数：`name: string`
  - 查询参数：`dataset: string` required，`ref?: string|null`
  - 请求体：`Extractor|null` 可省略
  - 响应体：`ValidateResponse {summary: ValidateSummary, dataset: Manifest}`
- **关键规则与边界**：
  - `ValidateSummary {checked: int, invalid: int, offending_values?: Record<string,int>}`。
  - 合同描述：给每个样本写入 `vocab_<dimension>_valid` signal，产生新 dataset 和 lineage。
  - 词表未知 404；无 extractor 400。
- **TS 目标**：vocabulary validate route + enrichment op。
- **依赖**：vocabulary domain、`WS run`/lineage、signals 写入。
- **验收点**：返回 summary 数量，dataset manifest 可读取，样本 signals 含 `vocab_{dimension}_valid`。
- **备注/疑点**：lineage op 为 `vocabulary:validate`；`offending_values` 在 UI 仍做空对象兜底。

## 契约 ↔ 实现对账

### UI OpenAPI 每个 path + method 对账

| UI path | method | Python 后端路由实现 | Python OpenAPI artifact | 结论 |
|---|---:|---|---|---|
| `/health` | GET | 有，`API-01` | 有 | 一致；schema 是开放字符串字典 |
| `/version` | GET | 有，`API-02` | 有 | 一致 |
| `/capabilities` | GET | 有，`API-03` | 有 | 一致；D1 后返回 `vocabularies:true` |
| `/v1/datasets` | POST | 有，`API-04` | 有 | 一致 |
| `/v1/datasets:ingest-jsonl` | POST | 有，`API-05` | 有 | 一致 |
| `/v1/datasets/{ref}` | GET | 有，`API-06` | 有 | 一致 |
| `/v1/datasets/{ref}/samples` | GET | 有，`API-07` | 有 | 一致 |
| `/v1/datasets/{ref}/export` | GET | 有，`API-08` | 有 | 路径一致；200 media type/schema 在 OpenAPI 中不准确 |
| `/v1/transforms` | GET | 有，`API-09` | 有 | 一致 |
| `/v1/transforms/{name}/run` | POST | 有，`API-10` | 有 | 一致 |
| `/v1/recipes:materialize` | POST | 有，`API-11` | 有 | 一致 |
| `/v1/refs` | GET | 有，`API-12` | 有 | 一致 |
| `/v1/refs/{name}` | GET | 有，`API-13` | 有 | 一致 |
| `/v1/lineage/{ref}` | GET | 有，`API-14` | 有 | 一致；响应是开放对象 |
| `/v1/vocabularies` | GET | 有，`CONTRACT-03` | 有 | D1 已实现 |
| `/v1/vocabularies/{name}` | GET | 有，`CONTRACT-04` | 有 | D1 已实现 |
| `/v1/vocabularies/{name}` | PUT | 有，`CONTRACT-05` | 有 | D1 已实现 |
| `/v1/vocabularies/{name}:derive` | POST | 有，`CONTRACT-06` | 有 | D1 已实现 |
| `/v1/vocabularies/{name}:normalize` | POST | 有，`CONTRACT-07` | 有 | D1 已实现 |
| `/v1/vocabularies/{name}:validate` | POST | 有，`CONTRACT-08` | 有 | D1 已实现 |

### D1 后新增实现

| path | method | 来源 | 影响 |
|---|---:|---|---|
| `/v1/vocabularies` | GET | 最新 Python backend + UI client/pages | 词表列表页可用 |
| `/v1/vocabularies/{name}` | GET | 同上 | 词表详情页可用 |
| `/v1/vocabularies/{name}` | PUT | 同上 | 手工创建/整理词表可用 |
| `/v1/vocabularies/{name}:derive` | POST | 同上 | 从 dataset 派生词表可用 |
| `/v1/vocabularies/{name}:normalize` | POST | 同上 | 词表应用 normalize 可用 |
| `/v1/vocabularies/{name}:validate` | POST | 同上 | 词表应用 validate 可用 |

结论：vocabularies 原本是 UI/pinned OpenAPI 领先于 Python 实现的风险项；D1 变更后，最新旧后端已补 `databench/service/routers/vocabularies.py` 和 `databench/vocabulary.py`，TS 迁移必须保留这些端点与能力位。

### 实现有、契约未暴露

业务 API 层没有发现“Python 实现有但 `databench-ui/schema/openapi.json` 没有”的 path+method。以下不计入业务合同差异：

- FastAPI 自动文档：`/openapi.json`、`/docs`、`/docs/oauth2-redirect`、`/redoc`
- CORS middleware 处理的 OPTIONS preflight

### 路径存在但合同细节不一致

| 范围 | 差异 | 迁移建议 |
|---|---|---|
| 错误响应 | 运行时统一 `{error:{code,message,detail?}}`，但 OpenAPI 422 仍声明 FastAPI 默认 `HTTPValidationError` | TS 迁移时用 OpenAPI 明确声明 ErrorResponse |
| `/v1/datasets/{ref}/export` | 运行时 `application/x-ndjson` streaming，OpenAPI 200 是 `application/json` schema `{}` | 修正 OpenAPI media type；前端当前用 `rawRequest` 下载 |
| `/health` | 实际固定返回 `status/workspace_root/version`，OpenAPI 只是开放 string map | 可保留开放字典或明确 schema |
| `/capabilities` | D1 后后端返回 `FEATURES.vocabularies:true` | TS 保持显式返回，前端按能力位显示/隐藏 |

## 行为基线：examples

| 来源 | 覆盖流程 | 对应功能ID / 端点 | 验收价值 |
|---|---|---|---|
| `examples/load_demo.py` | `Workspace.open` 打开 `examples/.bench-demo` | `SVC-03` | workspace root 初始化和持久化目录 |
| `examples/load_demo.py` | `add_jsonl` 分别 ingest `sft.jsonl`、`preference.jsonl`、`rl.jsonl` | `API-05` 的底层 `WS add_jsonl` | JSONL kind auto-detect 覆盖 sft/preference/rl |
| `examples/load_demo.py` | `enrich_length` 后 `dedup(ref="sft-clean")` | `API-10` | enrichment 不破坏样本身份、dedup 去重、ref 写入 |
| `examples/load_demo.py` | `lineage("sft-clean")` 打印 provenance DAG | `API-14` | lineage 必须显示 dedup -> enrich_length -> raw |
| `examples/load_demo.py` | `Recipe(name="demo-mix-v1", sources=[sft-clean weight 2, pref-raw weight 1], target_size=6, seed=7)` | `API-11` | recipe 权重、target_size、seed、可复现混合 |
| `examples/load_demo.py` | `export("train", "train.jsonl")` | `API-08` | export 行级 JSONL 格式 |

## 行为基线：tests

| 测试 | 断言行为 | 对应功能ID / 端点 |
|---|---|---|
| `test_core.py:test_sample_id_is_content_addressed` | 同内容不同 source 的 sample id 相同，source 不参与样本身份 | `CONTRACT-01`、`API-04/API-07` |
| `test_core.py:test_enrichment_does_not_change_id` | signals 变化不改变 sample id | `CONTRACT-01`、`API-10 enrich_length` |
| `test_core.py:test_kinds_roundtrip` | Dataset roundtrip 保留 sft/preference kind 和类型 | `CONTRACT-01`、`API-07` |
| `test_core.py:test_version_is_order_independent` | Dataset version 与样本顺序无关 | `API-04/API-05/API-10/API-11` |
| `test_core.py:test_enrichment_changes_version_not_identity` | signals 变化改变 dataset version，但样本 id 不变 | `API-10` |
| `test_core.py:test_store_roundtrip` | add_samples 后可通过 ref 读取同 version | `API-04`、`API-06`、`API-12/13` |
| `test_core.py:test_dedup` | dedup 按样本 id 去重，3 行变 2 行 | `API-10` |
| `test_core.py:test_transform_cache_hit` | 同 transform/inputs/params 第二次运行复用 cache，不新增 run | `API-10`、`API-14` |
| `test_core.py:test_enrich_and_filter` | enrich_length 写 `word_len`，filter_by_signal 可按 min 保留 1 行 | `API-10`、`SVC-05` |
| `test_core.py:test_lineage` | lineage 顶层 dedup，输入 enrich_length，再输入 raw version | `API-14` |
| `test_core.py:test_recipe_materialize_reproducible` | 同 recipe 重复 materialize version 一致；lineage op 为 `recipe:{name}` | `API-11`、`API-14` |
| `test_core.py:test_export_jsonl` | export JSONL 行数正确，sft 行含 messages，preference 行含 chosen | `API-08` |
| `test_io.py:test_detect_kind` | kind detect 覆盖 sft/preference/rl/trajectory；未知 shape 抛 ValueError | `API-05`、`ERR-05` |
| `test_io.py:test_preference_string_shorthand` | preference 字符串简写归一化为 user/assistant message | `API-05` |
| `test_io.py:test_rl_record` | rl prompt 字符串归一化，answer/rollouts 保留 | `API-05` |
| `test_io.py:test_source_tagging` | source 参数写入 sample.source | `API-05` |
| `test_io.py:test_read_demo_jsonl` | demo sft 5 行全 sft，preference 3 行全 preference | `API-05` |
| `test_io.py:test_add_jsonl_into_workspace` | add_jsonl 设置 ref，demo sft dedup 后 5 行变 4 行 | `API-05`、`API-10` |
| `test_service.py:test_health` | `/health` 200，`status == "ok"` | `API-01` |
| `test_service.py:test_version_handshake` | `/version` 200，api_version v1，字段集合严格 | `API-02` |
| `test_service.py:test_capabilities_handshake` | capabilities true/false flags 如当前实现 | `API-03` |
| `test_service.py:test_full_lifecycle` | HTTP 覆盖 JSON ingest、JSONL upload、get、samples pagination、list/run transforms、lineage、refs、recipe、export | `API-04` 到 `API-14` |
| `test_service.py:test_error_envelope` | missing dataset/unknown transform/bad sample/unknown ref 都用统一 envelope | `ERR-01` 到 `ERR-04` |
| `test_service.py:test_pagination_cap_enforced` | `limit=5000` 422；`limit=500` 200 | `API-07`、分页 routes |
| `test_service.py:test_legacy_unversioned_paths_removed` | `/datasets`、`/refs` 404 | `SVC-01`、`ERR-03` |
| `test_service.py:test_cors_allows_local_dev` | localhost/127.0.0.1:5173 preflight 和实际请求回显 Origin | `SVC-02` |
| `test_service.py:test_cors_rejects_unconfigured_origin` | evil/suffix Origin 不获得 CORS grant | `SVC-02` |
| `test_service.py:test_cors_env_override_allows_exact_origin` | `DATABENCH_CORS_ORIGINS` exact origin 生效，look-alike 拒绝 | `SVC-02` |
| `test_service.py:test_pna_preflight_sets_allow_private_network` | PNA preflight 返回 `access-control-allow-private-network: true` | `SVC-02` |
| `test_service.py:test_pna_header_absent_without_request` | 普通 preflight 不返回 PNA header | `SVC-02` |

## 行为基线：前端实际调用

| 前端 API | path/method | 使用场景 | 对应功能ID | 迁移优先级备注 |
|---|---|---|---|---|
| `api.health` | `GET /health` | 连接状态轮询 | `API-01` | 必需 |
| `api.version` | `GET /version` | compatibility check | `API-02` | 必需 |
| `api.capabilities` | `GET /capabilities` | feature visibility | `API-03` | 必需 |
| `api.listRefs` | `GET /v1/refs?limit&offset` | dataset 列表、recipe/vocab dataset 选择 | `API-12` | 必需 |
| `api.getRef` | `GET /v1/refs/{name}` | 单 ref 解析 | `API-13` | 当前 hooks 未直接大量使用，但合同存在 |
| `api.getDataset` | `GET /v1/datasets/{ref}` | dataset detail manifest | `API-06` | 必需 |
| `api.getSamples` | `GET /v1/datasets/{ref}/samples` | virtualized samples | `API-07` | 必需；避免全量加载 |
| `api.createDataset` | `POST /v1/datasets` | JSON samples create | `API-04` | 必需 |
| `api.ingestJsonl` | `POST /v1/datasets:ingest-jsonl` | 文件上传 | `API-05` | 必需；multipart field `file` |
| `api.listTransforms` | `GET /v1/transforms` | transforms page | `API-09` | 必需 |
| `api.runTransform` | `POST /v1/transforms/{name}/run` | run selected transform | `API-10` | 必需 |
| `api.materializeRecipe` | `POST /v1/recipes:materialize` | recipe page | `API-11` | 必需 |
| `api.getLineage` | `GET /v1/lineage/{ref}` | lineage page and links | `API-14` | 必需 |
| `api.exportResponse` | `GET /v1/datasets/{ref}/export?fmt` | authenticated streaming download | `API-08` | 必需；uses raw Response |
| `api.listVocabularies` | `GET /v1/vocabularies` | vocab list page | `CONTRACT-03` | D1 已实现 |
| `api.getVocabulary` | `GET /v1/vocabularies/{name}` | vocab detail page | `CONTRACT-04` | D1 已实现 |
| `api.putVocabulary` | `PUT /v1/vocabularies/{name}` | create/curate/promote | `CONTRACT-05` | D1 已实现 |
| `api.deriveVocabulary` | `POST /v1/vocabularies/{name}:derive` | derive draft | `CONTRACT-06` | D1 已实现 |
| `api.normalizeVocabulary` | `POST /v1/vocabularies/{name}:normalize` | apply normalize | `CONTRACT-07` | D1 已实现 |
| `api.validateVocabulary` | `POST /v1/vocabularies/{name}:validate` | apply validate | `CONTRACT-08` | D1 已实现 |

前端 HTTP 细节：

- `buildUrl` 只拼 origin 和 path；API base 不应包含 path。
- bearer token 放 `Authorization: Bearer ...` header；后端当前没有鉴权逻辑，但 CORS 声明“tokens go in headers”。
- JSON 请求设置 `Content-Type: application/json`；multipart 请求不手写 content-type。
- `request` 对非 2xx 解析统一 envelope，也兼容 legacy FastAPI `{detail}`。
- 2xx 但 content-type 非 JSON 会抛 `not_databench`，因此 JSON endpoints 必须返回 JSON content-type。
- export 下载走 `rawRequest`，不要求 JSON content-type。

## 可能遗漏 / 存疑

- `vocabularies` 是最大存疑：UI schema 和页面完整存在，但 Python 后端完全没有实现。迁移必须先决定“实现它”还是“从合同/UI 暂时移除或显式禁用”。
- OpenAPI 错误响应目前和运行时 envelope 不一致。TS 若按现有 `databench-ui/schema/openapi.json` 生成类型，会继续缺少 `ErrorResponse`。
- export 的 `fmt` 和 recipe 的 `target_format` 当前没有实质分支；`trl` 是合同/字段而非行为。迁移时不要误以为已实现 TRL。
- `GET /v1/lineage/{ref}` 对未知 ref 返回 `{version: ref}` 而不是 404，这和 dataset/ref endpoints 不同。
- samples response 是否要显式带 sample id：当前核心模型有 property `id`，但 OpenAPI/Pydantic dump 不把它作为字段。UI 只把它当 optional。
- transform output manifest name 与 `ref` 不同：内置 transforms 多数保留输入 dataset name；`ref` 只写 named pointer。
- recipe `target_size` 因 round 和 source cap，输出总行数可能不等于 target_size。
- CORS PNA header 在 Hono 里可能需要单独实现和测试。
- `uv run pytest` 在当前环境未能直接启动，因为 pytest 未安装；本文行为基线来自源码阅读，未在本次任务中完整跑测试。

## 最容易漏的 3 点

1. **vocabularies 合同领先于实现**：UI OpenAPI 多出 6 个词表端点，Python 后端没有 router/domain/capability flag。
2. **错误 envelope 是运行时合同，但不是 OpenAPI 合同**：迁移要把 `{error:{code,message,detail?}}` 和各异常映射写进 TS，并修正 OpenAPI。
3. **若干端点有非直觉边界**：export `fmt` 被忽略且运行时是 NDJSON；lineage 未知 ref 不 404；pagination cap 500；JSONL source 默认上传文件 stem；CORS PNA 只在请求 header 出现时返回。
