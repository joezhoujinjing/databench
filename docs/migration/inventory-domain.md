# 迁移功能清单 — 域与数据层(domain & data layer)

> 来源:`databench/databench/`(Python / M1)。本清单**逐功能穷尽**梳理 `schema.py`、`hashing.py`、`dataset.py`、`io.py`、`ops.py`、`transform.py`、`recipe.py`、`workspace.py`、`store.py`、`catalog.py` 的每一个行为/规则/隐藏约定,供 TS monorepo **逐条迁移**。
>
> TS 目标已对齐 ADR-0001(全 TS monorepo)、ADR-0003(Postgres 控制面 + 对象存储数据面)、`tech-stack.md`。库映射:dataframe→`nodejs-polars`(+DuckDB 兜底)、hash→`hash-wasm`(blake3)、schema→`zod v4`、catalog→Postgres + Prisma、store→对象存储(S3/R2/MinIO)。
>
> **阅读约定**:
> - **域前缀**:`CORE`(schema)/`HASH`/`DATASET`/`IO`/`OPS`/`XFORM`(transform 抽象)/`RECIPE`/`WS`(workspace)/`STORE`/`CATALOG`。
>   - 注:brief 给的前缀清单未给 `transform.py` 单独前缀,这里新增 **`XFORM`** 专门承载它,见结尾「存疑」。
> - 「易漏」项已在每条**关键规则与边界**里单列;最危险的几条另在结尾汇总。
> - 行号引用基于当前 HEAD 的源码。

---

## 全局贯穿不变式(先读,所有条目都依赖它)

这几条是整套内容寻址的地基,**任意一条搬错,所有 version/id 与缓存都会和 Python 对不上**:

1. **`id`(内容地址)= 内容的 canonical-JSON 的哈希**。两条独立代码路径必须产出**完全相同**的值:
   - `schema._SampleBase.id` = `hash_obj(content_dict())`
   - `dataset._build` 里 `sid = hash_text(payload_json)`,其中 `payload_json = canonical_json(content)`
   - 因为 `hash_obj(x) == hash_text(canonical_json(x))`,两者恒等。TS 迁移必须保证这条等式继续成立。
2. **`content_dict()` 不做 `exclude_none`**:所有可选字段即使为 `None` 也会以 `null` 进入 payload 并参与哈希(见 `CORE-06`)。这是最隐蔽的哈希输入。
3. **canonical_json 的四个开关**(见 `HASH-02`)`sort_keys=True / separators=(",",":") / ensure_ascii=False / default=str` 必须逐一复刻。
4. **哈希算法值不可互换**:blake3 与 blake2b 长度都是 64 hex,但**值不同**。Manifest 记录 `hash_algo`;**已核实 `bench/store` 既有对象的 `hash_algo` 全为 `blake3`、`.venv` 装了 `blake3 1.0.9`** → 迁移必须固定 blake3(`hash-wasm`)才能复用既有 store,blake2b 回退无需移植(见 `HASH-01`)。
5. **version 与时间戳解耦**:`version` 只由行内容(含 signals)决定,`created_at`/`updated_at` 不进哈希;但 store/catalog 都「首写为准」,时间戳取第一次写入(见 `STORE-04`/`CATALOG-02`)。

---

# CORE — `schema.py`(统一样本 schema)

### CORE-01 — `ToolCall` 模型
- **名称**:assistant 轮发起的一次工具调用。
- **作用**:描述一次 tool 调用的 id/名称/参数。
- **现位置**:`schema.py:ToolCall`(34–39)。
- **入口**:嵌套在 `Message.tool_calls`;经 `/v1/datasets`、`/v1/datasets/{ref}/samples` 序列化。
- **输入/输出**:`id: str|None=None`、`name: str`(必填)、`arguments: Any=None`。
- **关键规则与边界**:`arguments` 类型为 `Any`,**原样保留**(dict 或裸 JSON 字符串都行,schema 不解析也不归一化)。`id` 可空。
- **TS 目标**:`packages/schema`,`z.object({ id: z.string().nullish(), name: z.string(), arguments: z.unknown().nullish() })`。注意 `arguments` 用 `unknown` 保「原样」语义。
- **依赖**:无。
- **验收点**:把含 `arguments` 为字符串与为对象两种的 trajectory 样本过一遍 `id`,与 Python 对拍一致。
- **备注/疑点**:`arguments` 进入 payload 参与 identity,且不归一化 → dict vs 等价 JSON 字符串会算出不同 id。

### CORE-02 — `Message` 模型
- **名称**:一条聊天消息(SFT 与 trajectory 共用)。
- **作用**:承载 role/content 及工具相关字段。
- **现位置**:`schema.py:Message`(42–49)。
- **输入/输出**:`role: Literal["system","user","assistant","tool"]`(必填)、`content: str|None=None`、`name: str|None=None`、`tool_calls: list[ToolCall]|None=None`、`tool_call_id: str|None=None`。
- **关键规则与边界**:`role` 是封闭枚举(4 个值)。**`content` 可为 None**(纯 tool_call 轮)。这些 `None` 字段在 identity payload 里会显式变成 `null`(因 `content_dict` 不 exclude_none)。
- **TS 目标**:`packages/schema`,`z.enum([...])` + 其余 `nullish()`;`tool_calls: z.array(ToolCall).nullish()`。
- **依赖**:CORE-01。
- **验收点**:同内容、不同字段顺序的 message dict 应得同一 id(键排序消除顺序差)。
- **备注/疑点**:`detect_kind` 用 `tool_calls`/`role=="tool"`/`tool_call_id` 区分 trajectory(见 IO-01)。

### CORE-03 — `Rollout` 模型
- **名称**:RL 提示的一次采样补全 + 奖励。
- **作用**:RL 样本里一条 rollout。
- **现位置**:`schema.py:Rollout`(52–57)。
- **输入/输出**:`text: str`(必填)、`reward: float|None=None`、`meta: dict[str,Any]=Field(default_factory=dict)`。
- **关键规则与边界(易漏)**:**Rollout 自带的 `meta` 是 identity 的一部分**(它嵌在 `rollouts` 里、属于 payload),与**顶层** `Sample.meta` 的「排除出 identity」语义**相反**。改 rollout.meta 会改 id。
- **TS 目标**:`packages/schema`,`z.object({ text: z.string(), reward: z.number().nullish(), meta: z.record(z.unknown()).default({}) })`。
- **依赖**:无。
- **验收点**:对同一 RL 样本,改顶层 `meta` 不改 id;改 `rollouts[i].meta` 改 id。
- **备注/疑点**:`default_factory=dict` → 缺省空 dict;TS 用 `.default({})`。

### CORE-04 — `Candidate` 模型
- **名称**:带排名的补全(>2 选项的 preference)。
- **作用**:preference 样本的可选候选列表项。
- **现位置**:`schema.py:Candidate`(60–65)。
- **输入/输出**:`completion: Message | list[Message]`、`rank: int|None=None`、`score: float|None=None`。
- **关键规则与边界(易漏)**:`candidates` 整体属于 PreferenceSample 的 payload → `rank`/`score`/`completion` **都参与 identity**。`completion` 是 `Union[Message, list[Message]]`(单条或多条)。
- **TS 目标**:`packages/schema`,`completion: z.union([Message, z.array(Message)])`。
- **依赖**:CORE-02。
- **验收点**:含 candidates 的 preference 样本与 Python id 对拍。
- **备注/疑点**:`candidates` 默认 `None`,会以 `null` 进 payload(见 CORE-06/CORE-08)。

### CORE-05 — `_SampleBase`:provenance 字段 + identity 排除集
- **名称**:所有样本的公共基类与「身份排除」声明。
- **作用**:定义 `source`/`meta`/`signals` 三个非身份字段,以及它们被排除出 identity 的规则。
- **现位置**:`schema.py:_SampleBase`(68–83)。
- **输入/输出**:`source: str|None=None`、`meta: dict=Field(default_factory=dict)`、`signals: dict=Field(default_factory=dict)`;类变量 `IDENTITY_EXCLUDE: ClassVar[set] = {"source","meta","signals"}`。
- **关键规则与边界(最重要)**:
  - identity **只**排除这三个**顶层**字段;嵌套的 meta(如 `Rollout.meta`)**不**被排除(见 CORE-03)。
  - `meta`/`signals` 是开放 dict,transform 只追加、schema 永不覆盖(非破坏式 enrichment)。
- **TS 目标**:`packages/schema`,在序列化为内容字典时显式 `omit({source:true, meta:true, signals:true})`;`signals`/`meta` 用 `z.record(z.unknown()).default({})`。
- **依赖**:无。
- **验收点**:`test_sample_id_is_content_addressed`(同内容不同 source → 同 id)、`test_enrichment_does_not_change_id`(加 signal 不改 id)。
- **备注/疑点**:排除集是**字段名常量**,迁移时不要漏掉将来新增的 provenance 字段。

### CORE-06 — `content_dict()`:身份载荷生成
- **名称**:产出参与 identity 的 JSON-ready dict。
- **作用**:`model_dump(mode="json", exclude=IDENTITY_EXCLUDE)`。
- **现位置**:`schema.py:_SampleBase.content_dict`(76–79)。
- **入口**:被 `id` 属性、`Dataset.from_samples` 调用。
- **输入/输出**:输入 self;输出 dict(含 `kind` 及该 kind 的任务字段)。
- **关键规则与边界(最危险之一)**:
  - **不 `exclude_none`**:所有为 `None` 的可选字段会以 `null` 出现在 payload 里,**参与哈希**。例:PreferenceSample 的 `candidates:null`、RLSample 的 `answer:null`/`verifier:null`、Message 的 `name:null`/`tool_calls:null`/`tool_call_id:null` 等。
  - `mode="json"` 决定枚举/浮点/嵌套模型的 JSON 表示。
- **TS 目标**:`packages/schema`。zod 没有原生 `model_dump`;需写一个**确定性序列化器**:omit 三字段、**保留 null 字段**、数字/枚举按 JSON 表示。建议作为独立函数 `toContent(sample)`,并配 golden test。
- **依赖**:CORE-05。
- **验收点**:逐 kind 打印 `content_dict` 与 Python 对拍**逐字节**一致(尤其 null 字段的存在与否)。
- **备注/疑点**:这是迁移最容易翻车的点——JS 习惯丢 `undefined`/不写 null。必须显式写出 null。

### CORE-07 — `id` 属性(内容地址)
- **名称**:样本内容哈希身份。
- **作用**:`hash_obj(content_dict())`。
- **现位置**:`schema.py:_SampleBase.id`(81–83)。
- **输入/输出**:→ 64-hex 字符串。
- **关键规则与边界**:见全局不变式 #1;必须与 `dataset._build` 的 `sid` 等值。
- **TS 目标**:`packages/schema`(调用 `packages/hashing`)。
- **依赖**:CORE-06、HASH-04。
- **验收点**:`a.id == b.id`(同内容不同 source);并与 dataset 行 `id` 列一致。

### CORE-08 — 四个判别子类型 + 判别联合 `Sample`
- **名称**:`SFTSample`/`PreferenceSample`/`RLSample`/`TrajectorySample` 与 `Annotated[Union[...], Field(discriminator="kind")]`。
- **作用**:按 `kind` 字面量判别的统一样本类型。
- **现位置**:`schema.py`(86–115)。
- **输入/输出**(各自的 payload 字段):
  - `SFTSample`:`kind="sft"`,`messages: list[Message]`(必填)。
  - `PreferenceSample`:`kind="preference"`,`prompt: list[Message]=[]`,`chosen: Message|list[Message]`(必填),`rejected: Message|list[Message]`(必填),`candidates: list[Candidate]|None=None`。
  - `RLSample`:`kind="rl"`,`prompt: list[Message]=[]`,`answer: str|None=None`,`verifier: str|None=None`,`rollouts: list[Rollout]=[]`。
  - `TrajectorySample`:`kind="trajectory"`,`messages: list[Message]`(必填)。
- **关键规则与边界**:
  - 判别键是 `kind`(默认值即字面量)。`prompt`/`rollouts` 默认空 list(`default_factory`)。
  - SFT 与 trajectory **payload 形状相同**(都只有 `messages`),区别仅在 `kind` 字面量 → 二者 id **不同**(payload 含 kind)。
- **TS 目标**:`packages/schema`,`z.discriminatedUnion("kind", [SFT, Preference, RL, Trajectory])`。注意默认值用 `.default([])`,且保留 null(CORE-06)。
- **依赖**:CORE-02/03/04。
- **验收点**:`test_kinds_roundtrip`;以及 SFT 与 trajectory 同 messages 但 id 不同。
- **备注/疑点**:`chosen`/`rejected` 均为 `Union[Message,list[Message]]`,from-wire 时由 IO 归一化(IO-03)。

### CORE-09 — `parse_sample` / `_ADAPTER`
- **名称**:dict→正确子类型的校验入口。
- **作用**:`TypeAdapter(Sample).validate_python(obj)`。
- **现位置**:`schema.py:parse_sample`(117–123)。
- **入口**:被 `dataset.to_samples`、`io.record_to_sample` 调用;HTTP body 经 `IngestSamplesRequest.samples: list[Sample]` 校验。
- **输入/输出**:任意 dict/model → `Sample`。
- **关键规则与边界**:按 `kind` 判别路由;缺/错 `kind` → pydantic ValidationError。
- **TS 目标**:`packages/schema`,`SampleSchema.parse(obj)`(zod discriminatedUnion);错误用 zod issue 映射成 HTTP 422(对齐 service 错误信封)。
- **依赖**:CORE-08。
- **验收点**:非法 kind/缺字段抛校验错;合法各 kind 正确实例化。

### CORE-10 — 常量 `SCHEMA_VERSION` / `Kind`
- **名称**:schema 版本与 kind 字面量集合。
- **作用**:`SCHEMA_VERSION="1"`;`Kind = Literal["sft","preference","rl","trajectory"]`。
- **现位置**:`schema.py`(29、31)。
- **入口**:`Manifest.schema_version` 默认值、service `meta.SCHEMA_VERSION`(注意 service 里另有一份同值常量,见备注)。
- **TS 目标**:`packages/schema` 导出常量与 union 类型。
- **依赖**:无。
- **备注/疑点**:`SCHEMA_VERSION` 在 `schema.py` 与 `service/meta.py` 各存一份字符串 `"1"` → 迁移要保证单一来源(zod 包导出,service 引用),否则会漂移。

---

# HASH — `hashing.py`(内容哈希原语)

### HASH-01 — 哈希算法选择与回退
- **名称**:blake3 优先,blake2b(32 字节)回退。
- **作用**:`try: from blake3 import blake3` 成功 → `HASH_ALGO="blake3"`,`_digest=blake3(data).hexdigest()`;否则 `hashlib.blake2b(data, digest_size=32).hexdigest()`,`HASH_ALGO="blake2b"`。
- **现位置**:`hashing.py`(17–30)。
- **入口**:`HASH_ALGO` 进 `Manifest.hash_algo`;所有哈希走 `_digest`。
- **输入/输出**:`bytes → 64-hex`。
- **关键规则与边界(最危险之一)**:
  - 两算法**输出长度同(64 hex / 32 字节)但值不同**。同一份内容在 blake3 与 blake2b 下 id/version 完全不同。
  - 回退是「导入不硬失败」的容错;一旦回退,跨机器/跨实现的 version 就不可比。
- **TS 目标**:`packages/hashing`,用 `hash-wasm` 的 blake3,`digestSize/输出 = 32 字节 hex`。**固定 blake3,不实现 blake2b 回退**(已核实既有 store 全为 blake3,见验收)。
- **依赖**:无。
- **验收点**:**已核实**——`bench/store/objects/00/0021…b44.manifest.json` 等现存 manifest 的 `hash_algo` 字段全为 `"blake3"`,`.venv` 装有 `blake3 1.0.9`。再用 TS blake3 对同 payload 复算 id,与文件名/manifest version 对拍即可。
- **备注/疑点**:`pyproject.toml` 把 `blake3>=0.4` 列为硬依赖 → 实际总是 blake3 路径;blake2b 仅在 import 失败时(本仓库不会触发)。

### HASH-02 — `canonical_json`(确定性 JSON 编码)
- **名称**:所有结构化哈希的统一编码。
- **作用**:`json.dumps(obj, sort_keys=True, separators=(",",":"), ensure_ascii=False, default=str)`。
- **现位置**:`hashing.py:canonical_json`(33–46)。
- **入口**:`hash_obj`、`dataset._build`(payload/meta/signals 落盘前的规范化)。
- **输入/输出**:任意 JSON-able → 紧凑、键排序的字符串。
- **关键规则与边界(逐一复刻)**:
  - `sort_keys=True`:对象键按字典序;**递归**到嵌套对象。
  - `separators=(",",":")`:无空格。
  - `ensure_ascii=False`:非 ASCII **保留原字符**(不转 `\uXXXX`)。
  - `default=str`:不可序列化对象(datetime、set、自定义类等)走 `str()`。
  - 浮点:沿用 Python `repr`/`json` 的浮点格式(如 `1.0`)——与 JS 数字字符串化差异需校验。
- **TS 目标**:`packages/hashing`,手写 `canonicalJson`:递归排序键、`JSON.stringify` 风格但**键排序 + 无空格 + 保留 unicode + 对非常规类型回退 String()**。**不能直接用 `JSON.stringify`**(它不排序键、对 `undefined` 丢键、对 `Date` 走 `toJSON`、对 `BigInt` 抛错)。
- **依赖**:无。
- **验收点**:对含中文、嵌套乱序键、浮点、null 的对象,TS 输出与 Python `canonical_json` **逐字节**一致。
- **备注/疑点**:`default=str` 对 datetime 的字符串形式(`str(datetime)` 非 ISO 的 `T` 分隔)与 JS 不同;不过正常 payload 不含 datetime,主要风险在浮点与 unicode。

### HASH-03 — `hash_bytes` / `hash_text`
- **名称**:字节/文本哈希。
- **作用**:`hash_bytes(data)= _digest(data)`;`hash_text(text)= _digest(text.encode("utf-8"))`。
- **现位置**:`hashing.py`(49–54)。
- **入口**:`hash_text` 用于 `dataset` 的 `sid`/`row_digest`/空集 version。
- **输入/输出**:`bytes|str → 64-hex`。
- **关键规则与边界**:文本一律 **UTF-8** 编码后哈希。
- **TS 目标**:`packages/hashing`,`hashBytes(Uint8Array)`、`hashText(s)=hashBytes(utf8(s))`。
- **依赖**:HASH-01。
- **验收点**:`hash_text("empty")` 等固定串与 Python 对拍。

### HASH-04 — `hash_obj`(对象哈希)
- **名称**:经 canonical 编码后哈希任意对象。
- **作用**:`_digest(canonical_json(obj).encode("utf-8"))`。
- **现位置**:`hashing.py:hash_obj`(57–60)。
- **入口**:`Sample.id`、`Workspace.run` 的 cache_key、`Workspace.materialize` 的 cache_key、`Recipe.fingerprint`。
- **输入/输出**:对象 → 64-hex。
- **关键规则与边界**:`hash_obj(x) == hash_text(canonical_json(x))`(全局不变式 #1 的来源)。
- **TS 目标**:`packages/hashing`,`hashObj(x)=hashText(canonicalJson(x))`。
- **依赖**:HASH-02、HASH-03。
- **验收点**:cache_key/fingerprint 与 Python 对拍。

### HASH-05 — `hash_unordered`(顺序无关合并)
- **名称**:把多个哈希合并成一个、与顺序无关。
- **作用**:`_digest("\n".join(sorted(hexes)).encode("utf-8"))`。
- **现位置**:`hashing.py:hash_unordered`(63–71)。
- **入口**:`dataset._build` 计算 `version`。
- **输入/输出**:`Iterable[str] → 64-hex`。
- **关键规则与边界(易漏)**:
  - 先 `sorted` 再用 **`\n`** 连接再哈希 → 行重排不改结果。
  - **空集合**:`hash_unordered([])` = 哈希空串 `""`。但 dataset **不**走这条:它在调用点用 `hash_unordered(digests) if digests else hash_text("empty")` 单独处理空数据集(见 DATASET-04)。即「空集的 version」语义在 dataset 层,不在这里。
  - 重复 hex **不去重**(排序后保留重复行)→ 两条 row_digest 相同的行会出现两次相同 hex。
- **TS 目标**:`packages/hashing`,`hashUnordered(hexes)=hashText(hexes.slice().sort().join("\n"))`。排序用默认字典序(hex 字符串,等价 Python `sorted`)。
- **依赖**:HASH-01/03。
- **验收点**:`test_version_is_order_independent`;两顺序的同集合 version 相等。
- **备注/疑点**:排序是**字符串字典序**;hex 全小写 → JS `Array.sort()` 默认即可,无需 locale。

---

# DATASET — `dataset.py`(不可变、内容寻址数据集)

### DATASET-01 — 列布局 `COLUMNS`(全 Utf8)
- **名称**:数据集物理列布局。
- **作用**:`COLUMNS = ["id","row_digest","kind","source","payload","meta","signals"]`,frame schema 全部 `pl.Utf8`。
- **现位置**:`dataset.py`(34)、`_build`(94–105)。
- **关键规则与边界**:
  - **每列都是字符串**;`payload`/`meta`/`signals` 存的是 **canonical-JSON 字符串**(不是结构化列)。
  - 列顺序固定(`recipe.mix` 用 `f.select(COLUMNS)` 依赖它)。
- **TS 目标**:`packages/engine`(nodejs-polars),建 DataFrame 时显式给全 Utf8 schema、列顺序一致。Parquet 落盘列与类型必须匹配以便跨实现读。
- **依赖**:无。
- **验收点**:写出的 parquet 用 Python `pl.read_parquet` 能读、列名/类型一致。

### DATASET-02 — `Manifest` 模型
- **名称**:数据集版本的轻量可序列化描述。
- **作用**:落盘旁文件 + HTTP `response_model`。
- **现位置**:`dataset.py:Manifest`(37–47)。
- **入口**:几乎所有 `/v1/datasets*`、`/transforms/{name}/run`、`/recipes:materialize` 都返回 `Manifest`。
- **输入/输出**:`name: str|None`、`version: str`、`schema_version=SCHEMA_VERSION`、`hash_algo=HASH_ALGO`、`num_rows: int`、`kinds: dict[str,int]`、`columns=COLUMNS`、`created_at: datetime`。
- **关键规则与边界**:
  - `hash_algo`/`schema_version`/`columns` 有默认值(运行时常量)。
  - `created_at = datetime.now(timezone.utc)`(UTC,在 `_build` 里赋值)→ **不进 version**;但 store 幂等使其「首写为准」(STORE-04)。
  - `kinds` 是 `{kind: 计数}` 直方图。
- **TS 目标**:`packages/schema`/`packages/store`,zod 模型;`created_at` 用 ISO8601 UTC;`columns`/`hash_algo`/`schema_version` 作为可省默认。
- **依赖**:CORE-10、HASH-01、DATASET-01。
- **验收点**:`Manifest` JSON 序列化结构与 Python `model_dump_json(indent=2)` 字段一致(store 旁文件能互读)。
- **备注/疑点**:`columns` 字段用 mutable 默认(`= COLUMNS`)——pydantic 会拷贝,TS 别共享引用。

### DATASET-03 — `_row_digest`(单行摘要)
- **名称**:一行的内容摘要(含 provenance)。
- **作用**:`hash_text("\x00".join([payload_json, source or "", meta_json, signals_json]))`。
- **现位置**:`dataset.py:_row_digest`(50–53)。
- **入口**:`_build` 内每行计算;digest 进 `version`。
- **输入/输出**:四个 canonical-JSON 字符串(source 可为 None)→ 64-hex。
- **关键规则与边界(易漏)**:
  - 连接顺序固定:`payload \x00 source \x00 meta \x00 signals`。
  - **`source or ""`**:None 与空串等价。
  - 用 **NUL(`\x00`)** 作分隔避免字段边界碰撞。
  - row_digest **包含 signals/meta/source** → enrichment 改 signal 会改 digest → 改 version(但不改 id,见 DATASET-05)。
- **TS 目标**:`packages/engine`,逐字节复刻连接与分隔符;`source ?? ""`。
- **依赖**:HASH-03、HASH-02。
- **验收点**:对单行四元组复算 digest 与 Python 对拍。

### DATASET-04 — `_build`(统一构建路径)
- **名称**:raw rows → 规范 frame + manifest 的唯一构建函数。
- **作用**:为每行计算 `id`、`row_digest`、`kind`,规范化 payload/meta/signals,组装 frame 与 manifest,算 version。
- **现位置**:`dataset.py:_build`(56–115)。
- **入口**:`from_samples`、`from_frame` 共用(保证 digest 处处一致)。
- **输入/输出**:`Iterable[{content, source?, meta?, signals?}]` + name → `Dataset`。
- **关键规则与边界(多条易漏)**:
  - 每行:`payload_json=canonical_json(content)`、`meta_json=canonical_json(meta)`、`signals_json=canonical_json(sig)`;`meta=row.get("meta") or {}`、`sig=row.get("signals") or {}`(None→{})。
  - `sid = hash_text(payload_json)`(= id);`kind = content.get("kind","unknown")`(缺 kind → 字符串 `"unknown"`)。
  - **version**:`hash_unordered(digests) if digests else hash_text("empty")`——**空数据集 version = `hash_text("empty")`**(固定常量),不是空串哈希。
  - `kinds = dict(Counter(kinds))`(直方图)。
  - `created_at = datetime.now(timezone.utc)`。
- **TS 目标**:`packages/engine`,单一 `build(rows, name)`;空集走 `hashText("empty")`;`content.kind ?? "unknown"`。
- **依赖**:DATASET-03、HASH-02/03/05、CORE-10。
- **验收点**:空数据集 version == TS `hashText("empty")`;非空 version 与 Python 对拍;`kinds` 直方图一致。
- **备注/疑点**:`Counter` 顺序不影响 dict 相等;但 `kinds_json` 落 catalog 时是 `json.dumps`(非 canonical),键顺序按插入序——见 CATALOG 注。

### DATASET-05 — `Dataset.from_samples`
- **名称**:由 `Sample` 列表构建数据集。
- **作用**:把每个样本拆成 `{content_dict, source, meta, signals}` 喂给 `_build`。
- **现位置**:`dataset.py:from_samples`(125–137)。
- **入口**:`Workspace.add_samples`、`ops.enrich_length`。
- **输入/输出**:`Iterable[Sample]` → `Dataset`。
- **关键规则与边界**:content 来自 `s.content_dict()`(CORE-06 的所有 null 规则在此生效)。
- **TS 目标**:`packages/engine`,`Dataset.fromSamples(samples, name?)`。
- **依赖**:CORE-06、DATASET-04。
- **验收点**:`test_kinds_roundtrip`、`test_enrichment_changes_version_not_identity`。

### DATASET-06 — `Dataset.from_frame`
- **名称**:由(可能被 transform 改过的)Polars frame 重建规范数据集。
- **作用**:从 frame 读 `payload`(必需)及可选 `source`/`meta`/`signals`,**重算** id/row_digest/version。
- **现位置**:`dataset.py:from_frame`(139–165)。
- **入口**:几乎所有 transform 的返回路径、`_coerce`、`recipe.mix`、`ops.dedup/filter/sample`。
- **输入/输出**:`pl.DataFrame`(至少含 `payload`)→ `Dataset`。
- **关键规则与边界(易漏)**:
  - 缺 `payload` 列 → `ValueError(f"frame is missing required columns: {missing}")`。
  - **输入 frame 的 `id`/`row_digest`/`kind` 列被忽略并重算**(只用 payload + 可选 meta/signals)。所以 transform 改了 payload 但留了旧 id 也没关系。
  - `source`:`r["source"] if "source" in cols else None`(只看列是否存在,不看真假)。
  - `meta`/`signals`:`_loads(r[...]) if 列存在 and r[...] else {}`(列存在**且**值真才解析,空串/None→{})。
- **TS 目标**:`packages/engine`,`Dataset.fromFrame(frame, name?)`;严格复刻「忽略并重算 id/digest」。
- **依赖**:DATASET-04、DATASET-10(`_loads`)。
- **验收点**:把一个改了 payload、留了 stale id 的 frame 过 from_frame,id 被纠正;缺 payload 抛错。

### DATASET-07 — 访问器:`version`/`name`/`__len__`/`__repr__`/`polars`/`arrow`
- **名称**:数据集只读访问面。
- **作用**:`version`/`name` 取自 manifest;`__len__=manifest.num_rows`;`polars()` 返回 `self._frame.clone()`(**可安全 mutate**);`arrow()` 返回 `to_arrow()`。
- **现位置**:`dataset.py`(169–189)。
- **入口**:`Workspace`/`recipe.mix`/router 预览导出 全程使用 `polars()`。
- **关键规则与边界**:
  - `polars()` **每次返回 clone**——调用方拿到的是副本,改它不影响数据集(transform 依赖此隔离)。
  - `__len__` 来自 manifest 而非 frame 实际行数(正常一致;若手工构造不一致则以 manifest 为准)。
  - `__repr__` 截断 version 到 12 字符。
- **TS 目标**:`packages/engine`,`version`/`name` getter;`toPolars()` 返回 clone(nodejs-polars 的 `.clone()`);`toArrow()`。
- **依赖**:DATASET-02。
- **验收点**:`polars()` 返回值被 mutate 后,原 `Dataset.polars()` 仍干净。

### DATASET-08 — `to_samples`(行 → 样本反序列化)
- **名称**:把规范 frame 还原成 `Sample` 流。
- **作用**:对每行 `obj=_loads(payload)`;`obj["source"]=r["source"]`;`obj["meta"]=_loads(meta) if meta else {}`;`obj["signals"]=_loads(signals) if signals else {}`;`parse_sample(obj)`。
- **现位置**:`dataset.py:to_samples`(191–197)。
- **入口**:`Workspace.export`、router `preview_samples`/`export_dataset`、`ops.enrich_length`、`Dataset.head`。
- **输入/输出**:→ `Iterator[Sample]`。
- **关键规则与边界**:把 provenance 三字段重新注入 payload 再 `parse_sample`;空串 meta/signals → {}。`source` 直接注入(可能是 None)。
- **TS 目标**:`packages/engine`,生成器/迭代器返回解析后的样本。
- **依赖**:CORE-09、DATASET-10。
- **验收点**:`to_samples` 后再 `from_samples`,version 不变(round-trip 稳定)。

### DATASET-09 — `Dataset.head(n=5)`
- **名称**:取前 n 个样本。
- **作用**:遍历 `to_samples`,取前 n。
- **现位置**:`dataset.py:head`(199–205)。
- **输入/输出**:`n:int=5` → `list[Sample]`。
- **关键规则与边界**:基于迭代提前 break;n 超出则返回全部。
- **TS 目标**:`packages/engine`,`head(n=5)`。
- **依赖**:DATASET-08。
- **验收点**:行为对拍(便利函数,低风险)。

### DATASET-10 — `_loads`(空容忍 JSON 解析)
- **名称**:JSON 字符串 → dict,空串容错。
- **作用**:`json.loads(s) if s else {}`。
- **现位置**:`dataset.py:_loads`(208–209)。
- **关键规则与边界**:空串/None/falsy → `{}`(不抛错)。
- **TS 目标**:`packages/engine`,`s ? JSON.parse(s) : {}`。
- **依赖**:无。
- **验收点**:空串 payload?(实际 payload 非空)主要用于 meta/signals。

---

# IO — `io.py`(导入适配:JSONL → Sample)

### IO-01 — `detect_kind`(kind 自动判定)
- **名称**:从原始 record 形状推断 post-training 形态。
- **作用**:按固定**判定顺序**返回 `Kind`。
- **现位置**:`io.py:detect_kind`(18–36)。
- **入口**:`record_to_sample`(kind 未显式给出时)、`/datasets:ingest-jsonl`、`/v1` 导入路径。
- **输入/输出**:`dict → Kind`,否则 `ValueError`。
- **关键规则与边界(顺序最重要)**:
  1. `"chosen" in record and "rejected" in record` → `preference`(**最先**)。
  2. `"rollouts" in record` → `rl`。
  3. `"messages" in record` → 看是否有任一 message(仅 dict 计入)带 `tool_calls` **或** `role=="tool"` **或** `tool_call_id` → 有则 `trajectory`,否则 `sft`。
  4. 都不满足 → `ValueError`(信息含期望键名)。
- **隐藏含义**:同时含 `chosen/rejected` 与 `messages` → 判 preference;同时含 `rollouts` 与 `messages` → 判 rl。`messages` 为空/None 时 `is_trajectory=False` → sft。非 dict 的 message 元素在 trajectory 检测中被跳过。
- **TS 目标**:`packages/io`,严格按此**短路顺序**;`messages ?? []`;`m && typeof m==="object"` 守卫。
- **依赖**:CORE-10。
- **验收点**:`test_detect_kind`(四种 + ValueError);加测「chosen+messages → preference」「rollouts+messages → rl」。

### IO-02 — `_as_messages`(消息归一化)
- **名称**:把多形态 prompt 值归一成 message dict 列表。
- **作用**:None→`[]`;str→`[{role:default_role, content:str}]`;dict→`[dict]`(单条裹成列表);其它→`list(value)`。
- **现位置**:`io.py:_as_messages`(39–46)。
- **入口**:`_normalize` 处理 preference/rl 的 `prompt`。
- **输入/输出**:`(value, default_role) → list[dict]`。
- **关键规则与边界**:`default_role` 由调用方给(prompt 用 `"user"`)。dict 被当**单条消息**裹列表(不是当 kwargs)。
- **TS 目标**:`packages/io`,同分支;`Array.isArray` 守卫顺序与 Python 一致(先 None、再 string、再 object、否则展开为数组)。
- **依赖**:无。
- **验收点**:str/单 dict/列表三态归一与 Python 对拍。

### IO-03 — `_as_completion`(补全归一化)
- **名称**:把单字符串补全裹成 assistant 消息。
- **作用**:str→`{role:"assistant", content:str}`;其它原样返回。
- **现位置**:`io.py:_as_completion`(49–53)。
- **入口**:`_normalize` 处理 preference 的 `chosen`/`rejected`。
- **关键规则与边界**:**只**处理纯字符串;dict/list 原样透传(交给 schema 校验)。
- **TS 目标**:`packages/io`,`typeof v==="string" ? {role:"assistant",content:v} : v`。
- **依赖**:无。
- **验收点**:`test_preference_string_shorthand`。

### IO-04 — `_normalize`(按 kind 归一记录)
- **名称**:根据 kind 改写记录里的简写字段。
- **作用**:复制 record;`preference` → `prompt`=`_as_messages(...,"user")`、`chosen/rejected`=`_as_completion`;`rl` → `prompt`=`_as_messages(...,"user")`;`sft`/`trajectory` → 不动(`messages` 视为已是 message dict 列表)。
- **现位置**:`io.py:_normalize`(56–65)。
- **关键规则与边界(易漏)**:
  - `r=dict(record)`(浅拷贝)。
  - preference 用 `r["chosen"]`/`r["rejected"]` **直接下标**(若 kind 被强制为 preference 但缺 chosen/rejected → KeyError;正常 detect 路径不会缺)。
  - sft/trajectory 的 messages **不**归一化(不裹、不补 role)。
- **TS 目标**:`packages/io`,同分支;注意 preference 缺键时抛错语义。
- **依赖**:IO-02、IO-03。
- **验收点**:三类记录归一后字段形状与 Python 对拍。

### IO-05 — `record_to_sample`
- **名称**:单条原始记录 → 类型化 `Sample`。
- **作用**:`kind = kind or detect_kind(record)`;`data=_normalize`;`data["kind"]=kind`;若传了 `source` 且 record 自身无 source 则 `data["source"]=source`;`parse_sample(data)`。
- **现位置**:`io.py:record_to_sample`(68–78)。
- **入口**:`read_jsonl` 每行、`/datasets`(经 schema 校验后非此路径)。
- **输入/输出**:`(record, kind?, source?) → Sample`。
- **关键规则与边界(易漏)**:
  - source 注入条件:`source is not None and not data.get("source")` → **记录自带 source 优先**,外部 source 只在缺省时补。
  - `data["kind"]=kind` 强制写入(即使 record 已有 kind 也覆盖为判定值)。
- **TS 目标**:`packages/io`,`recordToSample(record, {kind?, source?})`。
- **依赖**:IO-01/04、CORE-09。
- **验收点**:`test_rl_record`、`test_source_tagging`。

### IO-06 — `read_jsonl`(流式 JSONL 解析)
- **名称**:从 JSONL 文件流式产出样本。
- **作用**:逐行读取、strip、跳空行、`json.loads`,逐行 `record_to_sample(record, kind=kind, source=source or path.stem)`。
- **现位置**:`io.py:read_jsonl`(81–100)。
- **入口**:`Workspace.add_jsonl`;`/datasets:ingest-jsonl`(经临时文件)。
- **输入/输出**:`(path, kind?, source?) → Iterator[Sample]`。
- **关键规则与边界(易漏)**:
  - **空行跳过**(strip 后为空 `continue`)。
  - JSON 解析失败 → `ValueError(f"{path}:{lineno}: invalid JSON: {exc}")`(1-based 行号)。
  - **source 默认 = `path.stem`**(文件名去扩展名);调用方传了 source 则优先。
  - UTF-8 打开。
- **TS 目标**:`packages/io`,用 Web Streams 逐行;行号 1-based;解析错信息格式对齐;source 默认取文件名 stem。service 上传场景(IO 经 Hono `parseBody`)需复刻 `datasets.py` 里「source 默认取上传文件名 stem」的逻辑(WS/router 域)。
- **依赖**:IO-05。
- **验收点**:`test_read_demo_jsonl`(sft=5、preference=3);坏行报 `path:lineno`;空行被跳过。

---

# XFORM — `transform.py`(transform 抽象)

> brief 未给本文件专属前缀,这里用 `XFORM`。

### XFORM-01 — `Transform` 数据类
- **名称**:承载 fn/name/version/params_model 的 transform 句柄。
- **作用**:把纯函数 + 元数据打包;**不**执行、不碰存储。
- **现位置**:`transform.py:Transform`(25–48)。
- **入口**:`ops` 里的装饰结果;`service/registry.build_registry` 反射收集;`Workspace.run`。
- **输入/输出**:字段 `fn`、`name`、`version`、`params_model: type[BaseModel]|None`。
- **关键规则与边界**:`name`/`version`(代码版本)都进 cache_key(WS-05)。`__repr__` 含 name/version。
- **TS 目标**:`packages/engine`,`type Transform = { fn, name, version, paramsModel? }`(paramsModel 用 zod schema)。
- **依赖**:无。
- **验收点**:registry 能反射出全部内置 transform 名集合一致。

### XFORM-02 — `Transform.build_params`(参数校验 + canonical 化)
- **名称**:kwargs → `(params_obj, canonical_params_dict)`。
- **作用**:无 params_model 时,若给了 kwargs → `TypeError(f"transform {name!r} takes no params but got: {sorted(kwargs)}")`,否则返回 `(None, {})`;有 model 时 `obj=model(**kwargs)`,返回 `(obj, obj.model_dump(mode="json"))`。
- **现位置**:`transform.py:build_params`(32–45)。
- **入口**:`Workspace.run`。
- **输入/输出**:`dict → (BaseModel|None, dict)`。
- **关键规则与边界(易漏)**:
  - 第二个返回值(canonical dict)是 **cache_key 的输入**,必须确定性 → 用 `model_dump(mode="json")`(含默认值填充,如 `sample_n` 的 `seed=0`)。
  - 无 params 的 transform 传了参数会**显式报错**(不是静默忽略);错误里 `sorted(kwargs)`。
- **TS 目标**:`packages/engine`,zod `parse(kwargs)` 后取 `.parse` 结果(默认值已填)作为 cache 输入;无 schema 但有参数 → 抛同义错误。
- **依赖**:XFORM-01。
- **验收点**:`sample_n` 不传 seed 时 params_dict 仍含 `seed:0`(默认值进 cache_key)。

### XFORM-03 — `@transform` 装饰器
- **名称**:把函数注册为 transform。
- **作用**:`Transform(fn=fn, name=name or fn.__name__, version=version, params_model=params)`。
- **现位置**:`transform.py:transform`(51–71)。
- **入口**:`ops.py` 全部内置 transform。
- **输入/输出**:`(name?, version="1", params?) → 装饰器`。
- **关键规则与边界**:`name` 默认取函数名;`version` 默认 `"1"`;纯函数约定((Dataset,...)→Dataset|frame),装饰器不执行。
- **TS 目标**:`packages/engine`,工厂函数 `defineTransform({name?, version="1", params?}, fn)` 或等价;name 默认取传入标识。TS 无 `fn.__name__` 反射习惯 → 建议**显式传 name**。
- **依赖**:XFORM-01。
- **验收点**:装饰后 `.name`/`.version`/`.params_model` 正确。
- **备注/疑点**:Python 靠 `fn.__name__` 自动命名;TS 迁移须显式命名,否则 registry/cache_key 的 op 名漂移。

---

# OPS — `ops.py`(内置 transform 库)

### OPS-01 — `dedup`
- **名称**:按内容 id 去重,保留首次出现。
- **作用**:`ds.polars().unique(subset=["id"], keep="first", maintain_order=True)` → `Dataset.from_frame`。
- **现位置**:`ops.py:dedup`(21–26);`version="1"`,无 params。
- **入口**:`Workspace.run(ops.dedup, ...)`;`/transforms/dedup/run`。
- **输入/输出**:`Dataset → Dataset`(子集)。
- **关键规则与边界(易漏)**:
  - 去重键是 **`id` 列**(内容地址),不是整行;`keep="first"` + `maintain_order=True` → 保留**首个**且**保持原顺序**(确定性)。
  - 名字保留 `ds.name`。
- **TS 目标**:`packages/ops`,nodejs-polars `df.unique({subset:["id"], keep:"first", maintainOrder:true})`。
- **依赖**:DATASET-06/07。
- **验收点**:`test_dedup`(3→2)、`test_add_jsonl_into_workspace`(5→4);保序性对拍。

### OPS-02 — `filter_by_signal`
- **名称**:按数值 signal 区间过滤。
- **作用**:取 `signals[key]`(JSON 路径),转 Float64,保留落在 `[min,max]` 的行。
- **现位置**:`ops.py:filter_by_signal`(29–46);`version="1"`,params=`SignalFilterParams{key:str, min:float|None=None, max:float|None=None}`。
- **入口**:`Workspace.run(ops.filter_by_signal, ds, key=..., min=..., max=...)`;`/transforms/filter_by_signal/run`。
- **输入/输出**:`Dataset → Dataset`(过滤后)。
- **关键规则与边界(多条易漏)**:
  - 取值表达式:`pl.col("signals").str.json_path_match("$." + key).cast(pl.Float64, strict=False)`。
  - **路径是 `"$." + key` 字面拼接**——key 含点/特殊字符会改变 JSONPath 语义(无转义)。
  - `cast(strict=False)`:非数值/缺失 → **null**。
  - cond 初值 `pl.lit(True)`;`min` 给定 → `& (value>=min)`;`max` 给定 → `& (value<=max)`。
  - **null 与比较 → null → 该行被过滤掉**(当 min 或 max 至少给一个时)。**两者都 None → cond 恒 True → 全保留**(连没有该 signal 的行也留)。
- **TS 目标**:`packages/ops`,nodejs-polars `col("signals").str.jsonPathMatch("$."+key).cast(Float64, false)`;条件累乘逻辑一致(注意 null 传播与 polars 一致)。
- **依赖**:DATASET-06/07。
- **验收点**:`test_enrich_and_filter`(word_len>=5 → 1 条);加测「无该 signal 的行在设了 min 时被剔除」「min/max 都不给时全保留」。

### OPS-03 — `sample_n`
- **名称**:随机下采样到 n 行(已小于则不动)。
- **作用**:`if p.n < height: frame.sample(n=p.n, seed=p.seed)`;否则原样。
- **现位置**:`ops.py:sample_n`(49–61);`version="1"`,params=`SampleNParams{n:int, seed:int=0}`。
- **入口**:`Workspace.run(ops.sample_n, ds, n=..., seed=...)`;`/transforms/sample_n/run`。
- **输入/输出**:`Dataset → Dataset`。
- **关键规则与边界(易漏)**:
  - `n >= height` → **完全不采样、不打乱**(保持原序原集)。
  - `n < height` → `frame.sample(n=n, seed=seed)`(**无放回**;polars 默认 `with_replacement=False, shuffle=False`)。
  - **确定性来自 seed**;但 seed 的具体 RNG 实现是 polars 内部 → 跨实现需用同一引擎(nodejs-polars 同 Rust 核)才能 bit-级一致。
- **TS 目标**:`packages/ops`,nodejs-polars `df.sample({n, seed})`。**跨实现采样一致性是 ADR-0001 点名要 golden test 的项**(seeded-sampling determinism)。
- **依赖**:DATASET-06/07、XFORM-02(seed 默认进 cache_key)。
- **验收点**:同 seed 同 n 两次结果一致;**nodejs-polars 与 Python polars 同 seed 是否选出同一子集** → 必须实测(若不一致,需固定到 DuckDB 或自实现确定性采样)。
- **备注/疑点**:这是「确定性」最大风险点之一——seed 语义跨语言不保证一致。

### OPS-04 — `enrich_length`
- **名称**:附加字符/词长度 signal(非破坏式)。
- **作用**:对每个样本算文本,`s.signals = {**s.signals, "char_len": len(text), "word_len": len(text.split())}`,`Dataset.from_samples`。
- **现位置**:`ops.py:enrich_length`(64–73);`version="1"`,无 params。
- **入口**:`Workspace.run(ops.enrich_length, ...)`;`/transforms/enrich_length/run`。
- **输入/输出**:`Dataset → Dataset`(version 变,id 不变)。
- **关键规则与边界(易漏)**:
  - **非破坏式合并**:`{**existing, ...}` → 已有 signal 保留,只覆盖 `char_len`/`word_len`。
  - 走 `to_samples → from_samples` round-trip(因此 version 改变)。
  - `word_len = len(text.split())`(Python `str.split()` 按**任意空白**切分并丢弃空串)→ 与 JS `text.split(/\s+/)` 不完全等价(JS 对前导空白会产生空串)。
- **TS 目标**:`packages/ops`,逐样本 enrich;**`word_len` 必须复刻 Python `split()` 语义**(`text.trim().split(/\s+/).filter(Boolean).length`,空串文本 → 0)。
- **依赖**:OPS-05、DATASET-05/08。
- **验收点**:`test_enrich_and_filter`;对含多空格/前后空格/空文本的样本,`word_len` 与 Python 对拍。

### OPS-05 — 文本抽取辅助 `_message_text` / `_sample_text`
- **名称**:样本 → 纯文本(length 类 signal 用)。
- **作用**:
  - `_message_text(messages)= " ".join(m.content for m in messages if m.content)`(跳过 None/空 content)。
  - `_sample_text`:`sft`/`trajectory` → messages 文本;`preference` → `prompt + (chosen 当列表)` 文本(**不含 rejected**);`rl` → **仅 prompt** 文本(**不含 rollouts**);其它 → `""`。
- **现位置**:`ops.py`(76–91)。
- **关键规则与边界(易漏)**:
  - preference 文本 **只用 chosen,忽略 rejected**;chosen 是单条则裹成列表。
  - rl 文本 **只用 prompt,忽略 answer/rollouts**。
  - 用单空格连接;`if m.content` 跳过空/None。
- **TS 目标**:`packages/ops`,同分支;`messages.filter(m=>m.content).map(m=>m.content).join(" ")`。
- **依赖**:CORE-08。
- **验收点**:四 kind 的 `_sample_text` 输出与 Python 对拍(尤其 preference 忽略 rejected、rl 忽略 rollouts)。

---

# RECIPE — `recipe.py`(可复现数据混合)

### RECIPE-01 — `RecipeSource` 模型
- **名称**:一个混合来源声明。
- **作用**:`dataset: str`(ref 名或具体 version)、`weight: float|None=None`、`max_samples: int|None=None`。
- **现位置**:`recipe.py:RecipeSource`(23–26)。
- **入口**:`Recipe.sources`;`/recipes:materialize` 请求体。
- **TS 目标**:`packages/schema`/`packages/workspace`,zod 模型。
- **依赖**:无。
- **验收点**:序列化进 fingerprint/lineage params 与 Python 一致。

### RECIPE-02 — `Recipe` 模型
- **名称**:训练面的可复现数据配方。
- **作用**:`name`、`sources: list[RecipeSource]`、`target_format: Literal["messages-jsonl","trl"]="messages-jsonl"`、`target_size: int|None=None`、`seed: int=0`。
- **现位置**:`recipe.py:Recipe`(29–37)。
- **入口**:`Workspace.materialize`;`/recipes:materialize`。
- **关键规则与边界**:`target_size` 是**总行数**,按 weight 在 sources 间拆分;`target_format` 目前仅声明,**导出时未被使用**(见 WS-10、存疑)。
- **TS 目标**:`packages/schema`,zod;`target_format` 枚举沿用。
- **依赖**:RECIPE-01。
- **验收点**:`test_recipe_materialize_reproducible`。

### RECIPE-03 — `Recipe.fingerprint`
- **名称**:配方 + 解析后版本 → 指纹。
- **作用**:`hash_obj({"recipe": self.model_dump(mode="json"), "resolved": resolved_versions})`。
- **现位置**:`recipe.py:fingerprint`(36–37)。
- **入口**:`Workspace.materialize` 算 cache_key。
- **输入/输出**:`dict[ref→version] → 64-hex`。
- **关键规则与边界(易漏)**:
  - 指纹包含**整个 recipe**(含 seed/weight/target_*)与 `resolved_versions`(ref→具体 version 的映射)。
  - `resolved_versions` 是 dict,经 canonical_json 键排序 → 顺序无关。
- **TS 目标**:`packages/workspace`,`hashObj({recipe: recipeJson, resolved})`;recipe 的 JSON 表示需与 zod 序列化对齐(默认值是否出现要一致)。
- **依赖**:HASH-04、RECIPE-02。
- **验收点**:同 recipe + 同 resolved → 同 fingerprint;与 Python 对拍。
- **备注/疑点**:`model_dump(mode="json")` 会**输出全部字段含默认值**(如 `seed:0`、`target_format:"messages-jsonl"`)→ TS 序列化也必须包含,否则指纹漂移。

### RECIPE-04 — `_source_count`(单源基数)
- **名称**:某源的基础取样数(受 max_samples 限)。
- **作用**:`n=height; if max_samples is not None: n=min(n, max_samples); return n`。
- **现位置**:`recipe.py:_source_count`(40–44)。
- **关键规则与边界**:只受 `max_samples` 上限约束,不涉及 weight。
- **TS 目标**:`packages/workspace`,纯函数。
- **依赖**:RECIPE-01。
- **验收点**:max_samples 大于/小于 height 两种。

### RECIPE-05 — `mix`(混合核心)
- **名称**:把各源 frame 按配方合成一个数据集。
- **作用**:算每源行数 → 各源 `select(COLUMNS)` 并按需 `sample` → `pl.concat` → `Dataset.from_frame(name=recipe.name)`。
- **现位置**:`recipe.py:mix`(47–69)。
- **入口**:`Workspace.materialize`。
- **输入/输出**:`(Recipe, list[(RecipeSource, frame)]) → Dataset`。
- **关键规则与边界(多条易漏)**:
  - `base_counts = [_source_count(f.height, src) ...]`。
  - **有 `target_size`**:`total_weight = sum(weight or 1.0)`;每源 `share=(weight or 1.0)/total_weight`,`count=min(base, round(share*target_size))`。
    - **`weight or 1.0`**:weight 为 None **或 0** 都退化为 1.0(`0 or 1.0 == 1.0`)——0 权重不会得 0!易漏。
    - **`round()` 是 Python 银行家舍入(half-to-even)**:`round(0.5)=0`、`round(2.5)=2`。JS `Math.round` 是 half-up → **必须复刻 banker's rounding**。
    - count 受 base 上限钳制 → 总数可能 < target_size(当 max_samples/height 不够)。
  - **无 `target_size`**:`counts=base_counts`。
  - 每源:`sub=f.select(COLUMNS)`;`if count < height: sub=sub.sample(n=count, seed=recipe.seed)`(**所有源共用 recipe.seed**;count>=height 时不采样、保序)。
  - `combined = pl.concat(parts) if parts else 空 frame(全 Utf8 schema)`。
  - **不跨源去重**:同一样本出现在两源 → 结果有重复行。
- **TS 目标**:`packages/workspace`(+`packages/engine`),nodejs-polars `select/sample/concat`;**自实现 banker's rounding**;`weight ?? 1.0` 后再 `|| 1.0` 等价语义需谨慎(JS `0 || 1.0` 也得 1.0,与 Python 一致——但 `weight ?? 1.0` 不行,要用 `(weight || 1.0)`)。
- **依赖**:RECIPE-04、DATASET-01/06。
- **验收点**:`test_recipe_materialize_reproducible`(m1.version==m2.version);构造 `round` 半值用例(如 share*target_size=2.5)验证 banker's rounding;0 权重源验证退化为 1.0。
- **备注/疑点**:`weight or 1.0` 对 0 的处理是真实坑;`round` 舍入差异会让某些 count 与 Python 差 1 → version 不一致。

---

# WS — `workspace.py`(用户唯一句柄:数据面 + 控制面)

### WS-01 — `Workspace.open`
- **名称**:在目录上打开/初始化工作区。
- **作用**:`root.mkdir(parents=True, exist_ok=True)`;`store=LocalBlobStore(root/"store")`;`catalog=SQLiteCatalog(str(root/"catalog.db"))`。
- **现位置**:`workspace.py:open`(45–51)。
- **入口**:`service/deps.get_workspace`(按 `DATABENCH_ROOT` 缓存单例,默认 `./bench`)。
- **关键规则与边界**:store 在 `root/store`,catalog 在 `root/catalog.db`。
- **TS 目标**:`packages/workspace`。**ADR-0003 改变拓扑**:不再是本地目录;store→对象存储 bucket/prefix,catalog→Postgres 连接。`open` 的语义变为「绑定到一组已配置的后端」,而非建目录。
- **依赖**:STORE-01、CATALOG-01。
- **验收点**:打开后能 add/get round-trip(`test_store_roundtrip`)。
- **备注/疑点**:Python 是 local-first 单节点;TS 是多副本无状态服务(行为等价但实现完全不同)。

### WS-02 — `add_samples`
- **名称**:把样本列表落为新数据集(可命名)。
- **作用**:`Dataset.from_samples(samples,name)` → `_persist(ds)` → 若 `name` 则 `catalog.set_ref(name, version, message)`;返回 ds。
- **现位置**:`workspace.py:add_samples`(55–62)。
- **入口**:`/v1/datasets`(`ingest_samples`)。
- **输入/输出**:`(samples, name?, message?) → Dataset`。
- **关键规则与边界**:命名是可选的;无 name 则只持久化、不建 ref。`message` 仅在建 ref 时使用。
- **TS 目标**:`packages/workspace`。
- **依赖**:DATASET-05、WS-11、CATALOG-08。
- **验收点**:`test_store_roundtrip`。

### WS-03 — `add_jsonl`
- **名称**:摄取 JSONL 文件为新数据集。
- **作用**:`list(read_jsonl(path, kind, source))` → `add_samples`。
- **现位置**:`workspace.py:add_jsonl`(64–75)。
- **入口**:`/v1/datasets:ingest-jsonl`(经临时文件;source 默认取上传文件名 stem,见 datasets.py 47–48)。
- **输入/输出**:`(path, name?, kind?, source?, message?) → Dataset`。
- **关键规则与边界**:**一次性 `list(...)` 物化**(非流式落盘)。
- **TS 目标**:`packages/workspace`/`packages/io`,可流式;但摄取后仍要整体算 version(内容寻址需要全量)。
- **依赖**:IO-06、WS-02。
- **验收点**:`test_add_jsonl_into_workspace`(5 行;dedup→4)。

### WS-04 — `add` / `get`
- **名称**:登记已有 Dataset / 解析取回数据集。
- **作用**:
  - `add(ds, name?, message?)`:`_persist(ds)`,若 name 则 set_ref。
  - `get(ref_or_version)`:若已是 Dataset 直接返回;否则 `version=catalog.resolve(x)` → `store.read(version)`。
- **现位置**:`workspace.py`(77–87)。
- **入口**:`get` 被 `run`/`materialize`/`export`/所有 `/datasets/{ref}*` router 使用。
- **关键规则与边界(易漏)**:`get` 接受 Dataset|str;str 先经 `catalog.resolve`(ref→version,或原样返回未注册 version),再 `store.read`(不存在 → KeyError)。
- **TS 目标**:`packages/workspace`,`get` 同三态。
- **依赖**:CATALOG-11、STORE-05。
- **验收点**:`ws.get("raw").version == ds.version`。

### WS-05 — `run`(执行 transform + 缓存 + lineage)
- **名称**:在 1+ 输入数据集上跑 transform。
- **作用**:解析输入 → 建 params → 算 cache_key → 命中则复用、未命中则执行并记账。
- **现位置**:`workspace.py:run`(91–122)。
- **入口**:`/v1/transforms/{name}/run`。
- **输入/输出**:`(transform, *inputs, ref?, **params) → Dataset`。
- **关键规则与边界(多条最重要)**:
  - `input_ds=[self.get(i) for i in inputs]`;`params_obj, params_dict = transform.build_params(params)`。
  - **cache_key** = `hash_obj({"op": name, "op_version": version, "inputs": [d.version for d in input_ds], "params": params_dict})`。键顺序固定(canonical 排序)。
  - 命中条件:`cached = catalog.find_run(cache_key)` **且** `store.exists(cached)`(双重校验:catalog 有记录且 blob 真在)。命中 → `store.read(cached)`,**不**重记 run。
  - 未命中:`result = fn(*input_ds, params_obj) if params_obj is not None else fn(*input_ds)`(**params 作为最后一个位置参数**)→ `_coerce(result, name=ref)` → `_persist` → `record_run(cache_key, name, version, params_dict, input_versions, out.version)`。
  - **无论命中与否**,若给 `ref` 都 `catalog.set_ref(ref, out.version)`(ref 可指向缓存命中的旧 version)。
- **TS 目标**:`packages/workspace`,cache_key 用 `hashObj`(键集与顺序逐字一致);`runs` 表查命中 + 对象存储 `exists` 双校验;params 传参约定(位置/对象)按 TS transform 形态定,但 **cache_key 内容必须等价**。
- **依赖**:XFORM-02、HASH-04、CATALOG-05/06、STORE-04/05、WS-11、WS-12。
- **验收点**:`test_transform_cache_hit`(同输入第二次不新增 run 行、version 相同);`test_lineage`(op 链)。
- **备注/疑点**:双校验意味着 catalog 有记录但 blob 丢失会**重算并 REPLACE run 行**(record_run 用 INSERT OR REPLACE)。

### WS-06 — `materialize`(配方物化 + 缓存 + lineage)
- **名称**:解析配方 sources、产出单一混合数据集。
- **作用**:`resolved={src.dataset: catalog.resolve(src.dataset)}` → `frames=[(src, get(resolved[...]).polars())]` → fingerprint → cache_key → 命中复用 / 否则 `mix` 并记账。
- **现位置**:`workspace.py:materialize`(126–150)。
- **入口**:`/v1/recipes:materialize`。
- **输入/输出**:`(Recipe, ref?) → Dataset`。
- **关键规则与边界(多条易漏)**:
  - `cache_key = hash_obj({"op": f"recipe:{recipe.name}", "fingerprint": fingerprint})`(只含 name + fingerprint;fingerprint 内已含 recipe 全量与 resolved)。
  - 命中:`find_run && store.exists` → read。
  - 未命中:`mix(recipe, frames)` → `_persist` → `record_run(cache_key, f"recipe:{name}", "1", recipe.model_dump(mode="json"), sorted(set(resolved.values())), out.version)`。
    - **op_version 写死 `"1"`**;op 名是 `recipe:<name>`。
    - **inputs = `sorted(set(resolved.values()))`**:对解析出的 version **去重 + 排序**(若两 source 解析到同一 version,lineage 输入只记一次)。
  - 给 ref 则 set_ref(无论是否命中)。
- **TS 目标**:`packages/workspace`,同结构;lineage `inputs` 的「set+sort」语义务必复刻(影响 lineage 图与对拍)。
- **依赖**:RECIPE-03/05、CATALOG-11/05、STORE-04/05、WS-11。
- **验收点**:`test_recipe_materialize_reproducible`;lineage op == `recipe:mix-v1`;inputs 去重排序行为对拍。

### WS-07 — `lineage`(对外:解析后走 DAG)
- **名称**:从 ref/version/Dataset 起,向上回溯 provenance DAG。
- **作用**:解析出 version → `_lineage(version, seen=set())`。
- **现位置**:`workspace.py:lineage`(154–158)。
- **入口**:`/v1/lineage/{ref}`。
- **输入/输出**:`DatasetLike → dict(DAG)`。
- **TS 目标**:`packages/workspace`/`packages/catalog`。**ADR-0003 建议改用 SQL `WITH RECURSIVE`** 在 Postgres 里一次回溯(替代递归 Python 走表),但**输出结构必须与下方 `_lineage` 完全一致**。
- **依赖**:CATALOG-11、WS-08。
- **验收点**:`test_lineage`、`test_recipe_materialize_reproducible` 的 lineage 段。

### WS-08 — `_lineage`(递归 DAG 构建)
- **名称**:递归构造 provenance 节点。
- **作用**:`node={"version":v}`;查 `get_dataset(v)` 补 `name`/`num_rows`;环检测;查 `runs_producing(v)`,取 `producers[0]` 写 `produced_by={op,op_version,params}` 与递归 `inputs`。
- **现位置**:`workspace.py:_lineage`(160–180)。
- **关键规则与边界(多条易漏)**:
  - 节点字段:总有 `version`;若 dataset 已登记则有 `name`、`num_rows`;有 producer 则有 `produced_by`(含 `op`/`op_version`/`params`)与 `inputs`(子节点列表)。
  - **环检测**:`if version in seen: node["cycle"]=True; return`(先判后加;命中环只标记不再递归)。`seen = seen | {version}`(不可变并集,每条路径独立)。
  - **`producers[0]`**:假设内容寻址下「一个 version 只有一个规范 producer」。但 `runs_producing` 的 SQL **无 ORDER BY** → 若同 version 有多 producer,取哪条**不确定**。
  - 未登记的 version 节点只有 `version` 字段(无 name/num_rows)。
- **TS 目标**:`packages/workspace`/`packages/catalog`;若用 `WITH RECURSIVE` 需自己实现环检测(`cycle` 列)与「取一个 producer」的确定化(**建议加 `ORDER BY created_at`/version 消除不确定性**——见存疑)。
- **依赖**:CATALOG-04/07。
- **验收点**:`test_lineage`(dedup←enrich_length←raw 三层、叶子 version==raw.version);构造环验证 `cycle:true`。

### WS-09 — `export`(写 JSONL)
- **名称**:把数据集导出为训练就绪 JSONL 文件。
- **作用**:`get(ds)`;逐样本 `fh.write(json.dumps(_export_record(sample, fmt), ensure_ascii=False)+"\n")`;返回 path。
- **现位置**:`workspace.py:export`(184–190)。
- **入口**:`/v1/datasets/{ref}/export`(router 内**复用 `_export_record`** 走 StreamingResponse;见 datasets.py 80–99)。
- **输入/输出**:`(ds, path, fmt="messages-jsonl") → Path`。
- **关键规则与边界**:`ensure_ascii=False`(保留 unicode);每行一个 JSON + `\n`;`fmt` 透传给 `_export_record`(但其实未生效,见 WS-10)。
- **TS 目标**:`packages/workspace`,Web Streams NDJSON;`JSON.stringify` 保留 unicode(JS 默认即不转义)。
- **依赖**:WS-10、DATASET-08。
- **验收点**:`test_export_jsonl`(2 行;含 messages 与 chosen)。

### WS-10 — `_export_record`(按 kind 整形导出记录)
- **名称**:样本 → 导出 dict。
- **作用**:
  - `sft`/`trajectory` → `{"messages": [m.model_dump(exclude_none=True) for m in messages]}`。
  - `preference` → `model_dump(mode="json", include={"prompt","chosen","rejected"}, exclude_none=True)`。
  - `rl` → `model_dump(mode="json", include={"prompt","answer","verifier","rollouts"}, exclude_none=True)`。
  - 其它 → `model_dump(mode="json", exclude_none=True)`。
- **现位置**:`workspace.py:_export_record`(207–215)。
- **入口**:`export` 与 `/datasets/{ref}/export`。
- **关键规则与边界(易漏)**:
  - **导出用 `exclude_none=True`**(与 identity 的 `content_dict` **相反**——后者保留 null)。
  - **`fmt` 参数被完全忽略**:`messages-jsonl` 与 `trl` 产出**相同**结构;recipe 的 `target_format` 也未参与导出。
  - sft/trajectory 只导出 `messages`(丢弃 source/meta/signals/kind)。preference/rl 只导出指定子集(同样丢 provenance)。
- **TS 目标**:`packages/workspace`,逐 kind 整形;**`exclude_none` 语义**(丢 null/缺省字段)需复刻。是否实现真正的 `trl` 格式 = 产品决策(见存疑)。
- **依赖**:CORE-08。
- **验收点**:`test_export_jsonl`;对比 fmt=trl 与 messages-jsonl 输出当前应一致。
- **备注/疑点**:这是个明显的「声明了但没实现」点(target_format/fmt 无效),迁移时要决定是补齐还是照搬。

### WS-11 — `_persist`
- **名称**:把数据集同时落到数据面与控制面。
- **作用**:`store.write(ds)`;`catalog.register_dataset(version, name, len, kinds)`。
- **现位置**:`workspace.py:_persist`(194–196)。
- **关键规则与边界**:**先写 store 再登记 catalog**;两者各自幂等(store 内容寻址、catalog INSERT OR IGNORE)。
- **TS 目标**:`packages/workspace`,顺序一致;注意分布式下「store 成功 catalog 失败」的补偿(Python 无事务,TS 也只能靠幂等重试)。
- **依赖**:STORE-04、CATALOG-02。
- **验收点**:persist 后 `store.exists` 与 `catalog.get_dataset` 都为真。

### WS-12 — `_coerce`(transform 返回值规整)
- **名称**:把 transform 返回值规整成 Dataset。
- **作用**:`Dataset`→原样;`pl.DataFrame`→`Dataset.from_frame(name=name)`;否则 `TypeError(...)`。
- **现位置**:`workspace.py:_coerce`(199–204)。
- **入口**:`run`。
- **关键规则与边界**:transform 允许返回 Dataset 或裸 frame(后者补 name=ref)。其它类型报错。
- **TS 目标**:`packages/workspace`,联合类型分支。
- **依赖**:DATASET-06。
- **验收点**:返回 frame 与返回 Dataset 都能跑通;返回非法类型报错。

### WS-13 — 类型别名 `DatasetLike`
- **名称**:`Union[Dataset, str]`。
- **作用**:`get`/`lineage`/`export` 入参类型。
- **现位置**:`workspace.py`(36)。
- **TS 目标**:`packages/workspace`,`type DatasetLike = Dataset | string`。
- **依赖**:无。
- **验收点**:N/A(类型)。

---

# STORE — `store.py`(内容寻址 blob 存储 / 数据面)

### STORE-01 — `LocalBlobStore` 初始化与目录布局
- **名称**:文件系统内容寻址存储。
- **作用**:`__init__(root)` → `(root/"objects").mkdir(parents=True, exist_ok=True)`。
- **现位置**:`store.py:LocalBlobStore`(21–24)。
- **关键规则与边界**:对象根目录 `root/objects`。
- **TS 目标**:`packages/store`,**接口 `Store`**;实现为对象存储(S3/R2/MinIO),保留可选 `fs` 实现给测试(ADR-0003)。
- **依赖**:无。
- **验收点**:初始化后目录/前缀存在。

### STORE-02 — 目录分片与路径函数
- **名称**:按 version 前 2 字符分片。
- **作用**:`_dir(v)= root/objects/v[:2]`;`_parquet(v)= dir/f"{v}.parquet"`;`_manifest(v)= dir/f"{v}.manifest.json"`。
- **现位置**:`store.py`(26–33)。
- **关键规则与边界(易漏)**:
  - **分片键 = version 前 2 hex 字符**(256 路分片)。
  - parquet 与 manifest **同目录、同主名、不同后缀**(`.parquet` / `.manifest.json`)。
- **TS 目标**:`packages/store`,对象 key = `objects/<version[:2]>/<version>.parquet` 与 `.../<version>.manifest.json`(ADR-0003 明确此布局)。
- **依赖**:无。
- **验收点**:与 `bench/store/objects/<2hex>/<hex>.parquet` 既有布局一致。

### STORE-03 — `exists`
- **名称**:版本是否完整存在。
- **作用**:`_parquet(v).exists() and _manifest(v).exists()`(**两者都在才算存在**)。
- **现位置**:`store.py:exists`(35–36)。
- **入口**:`write` 幂等判断、`run`/`materialize` 缓存双校验。
- **关键规则与边界(易漏)**:**必须 parquet 与 manifest 同时存在**;只写了一个不算存在(配合原子写避免半成品)。
- **TS 目标**:`packages/store`,两个对象都 HEAD 成功才算存在。
- **依赖**:STORE-02。
- **验收点**:缺 manifest 时 `exists`=false → 触发重写/重算。

### STORE-04 — `write`(原子 + 幂等)
- **名称**:持久化数据集(写一次、按哈希寻址)。
- **作用**:`version=ds.version`;`if exists(version): return version`(幂等 no-op);否则建目录,parquet 先写 `*.parquet.tmp` 再 `os.replace` 到正式名;manifest 先写 `*.json.tmp`(`model_dump_json(indent=2)`)再 `os.replace`;返回 version。
- **现位置**:`store.py:write`(38–55)。
- **入口**:`Workspace._persist`。
- **关键规则与边界(多条最重要)**:
  - **幂等**:相同 version 已存在 → 直接返回,不重写 → **首次写入的 manifest(含 created_at)永久固化**。
  - **原子写**:tmp + `os.replace`(同文件系统原子重命名)→ 崩溃不会留半成品「看起来存在」。
  - 写顺序:**先 parquet 后 manifest**(配合 `exists` 双文件判定 → manifest 是「完成标记」)。
  - manifest JSON 用 `indent=2`(人类可读,非 canonical)。
- **TS 目标**:`packages/store`。对象存储下 **`PUT` 本身按对象原子**、key 是内容哈希 → 天然 write-once、无需 rename(ADR-0003 明确)。但需保留「manifest 作为完成标记、最后写」的顺序,使 `exists` 双校验仍成立。
- **依赖**:STORE-02/03、DATASET-02/07。
- **验收点**:重复 write 同内容是 no-op 且 version 不变;崩溃中断(模拟只写 parquet)→ `exists`=false。
- **备注/疑点**:`Path.with_suffix(".parquet.tmp")`/`(".json.tmp")` 依赖 version 无点号(64-hex 成立);TS 直接拼接 key 即可。

### STORE-05 — `read`
- **名称**:按版本读回数据集。
- **作用**:`if not exists: KeyError(f"dataset version not found in store: {version}")`;`frame=pl.read_parquet(parquet)`;`manifest=Manifest.model_validate_json(manifest_text)`;`Dataset(frame, manifest)`。
- **现位置**:`store.py:read`(57–62)。
- **入口**:`Workspace.get`、`run`/`materialize` 缓存命中。
- **关键规则与边界(易漏)**:
  - 不存在 → **`KeyError`**(注意是 KeyError 不是 ValueError;router 层需映射成 404)。
  - **读回不重新校验** frame 的内容哈希是否等于目录 version(信任文件系统)。
- **TS 目标**:`packages/store`,缺失 → 抛领域错误(映射 404);可选地在读后校验 version(Python 没做,迁移可加固但需注明差异)。
- **依赖**:STORE-03、DATASET-02。
- **验收点**:`test_store_roundtrip`;读不存在 version 抛错。

---

# CATALOG — `catalog.py`(SQLite 控制面 / 元数据大脑)

### CATALOG-01 — 表结构与初始化(WAL)
- **名称**:三表 schema + WAL 初始化。
- **作用**:`__init__` 连接后 `PRAGMA journal_mode=WAL`,`executescript(_SCHEMA)`。
- **现位置**:`catalog.py`(23–67)。
- **表结构**:
  - `datasets(version TEXT PK, name TEXT, num_rows INTEGER NOT NULL, kinds_json TEXT NOT NULL, created_at TEXT NOT NULL)`。
  - `runs(cache_key TEXT PK, op TEXT NOT NULL, op_version TEXT NOT NULL, params_json TEXT NOT NULL, inputs_json TEXT NOT NULL, output_version TEXT NOT NULL, created_at TEXT NOT NULL)`。
  - `refs(name TEXT PK, version TEXT NOT NULL, message TEXT, updated_at TEXT NOT NULL)`。
  - 索引:`idx_runs_output ON runs(output_version)`。
- **关键规则与边界(易漏)**:
  - **cache_key 是 runs 主键**(缓存语义来自 PK 唯一)。
  - **output_version 上有非唯一索引**(支撑 `runs_producing` 与 lineage 回溯)。
  - 时间戳列都是 **TEXT(ISO8601)**(见 CATALOG-12)。
  - `kinds_json`/`params_json`/`inputs_json` 是 `json.dumps` 的**普通 JSON**(非 canonical;不参与哈希,仅存储/展示)。
- **TS 目标**:`packages/catalog`,**Postgres + Prisma**(ADR-0003)。映射:PK/索引同构;`*_json` 用 `jsonb`(或 text 保持逐字一致——见验收);时间戳用 `timestamptz`。WAL/PRAGMA 不适用 Postgres,由连接池 + 隔离级别替代。
- **依赖**:无。
- **验收点**:表/列/索引/约束与原结构等价;`runs_producing` 走索引。
- **备注/疑点**:若 lineage 的 `params` 要与 Python 字节级对拍,需注意 `json.dumps`(普通 JSON,空格 `, ` `: `)与 jsonb 规范化不同;建议对拍**解析后的对象**而非原始串。

### CATALOG-02 — `register_dataset`(INSERT OR IGNORE)
- **名称**:登记数据集版本与摘要。
- **作用**:`INSERT OR IGNORE INTO datasets (...) VALUES (...)`,`created_at=_now()`,`kinds_json=json.dumps(kinds)`。
- **现位置**:`catalog.py:register_dataset`(87–92)。
- **入口**:`Workspace._persist`。
- **关键规则与边界(易漏)**:**INSERT OR IGNORE** → 同 version 重复登记是 no-op,**首次 created_at 固化**(与 store 幂等一致)。
- **TS 目标**:`packages/catalog`,Postgres `INSERT ... ON CONFLICT (version) DO NOTHING`。
- **依赖**:CATALOG-01。
- **验收点**:重复 register 不改 created_at;num_rows/kinds 以首次为准。

### CATALOG-03 — `get_dataset`
- **名称**:按 version 取数据集元数据。
- **作用**:`SELECT * FROM datasets WHERE version=?` → `_row_to_dataset`(含 `kinds=json.loads(kinds_json)`)。
- **现位置**:`catalog.py:get_dataset`(94–97)。
- **入口**:`_lineage`、`resolve`(判断是否为已知 version)。
- **输出**:`{version, name, num_rows, kinds, created_at}` 或 None。
- **TS 目标**:`packages/catalog`,Prisma 查询;`kinds` 解析回对象。
- **依赖**:CATALOG-01、CATALOG-09。
- **验收点**:命中返回结构一致;未命中 None。

### CATALOG-04 — `record_run`(INSERT OR REPLACE)
- **名称**:记录一次 transform/recipe 执行(= lineage 边 + 缓存项)。
- **作用**:`INSERT OR REPLACE INTO runs (...) VALUES (...)`,`params_json=json.dumps(params)`、`inputs_json=json.dumps(inputs)`、`created_at=_now()`。
- **现位置**:`catalog.py:record_run`(101–115)。
- **入口**:`Workspace.run`、`Workspace.materialize`。
- **关键规则与边界(易漏)**:**INSERT OR REPLACE**(按 cache_key 主键)→ 同 cache_key 再次记录会**替换旧行并刷新 created_at/output_version**(与 datasets 的 IGNORE、refs 的 DO UPDATE **三种策略各不相同**)。
- **TS 目标**:`packages/catalog`,Postgres `INSERT ... ON CONFLICT (cache_key) DO UPDATE SET ...`(等价 REPLACE 语义:覆盖所有列)。
- **依赖**:CATALOG-01。
- **验收点**:同 cache_key 二次 record 覆盖且只一行;output_version 更新。
- **备注/疑点**:正常缓存命中路径**不会**重 record(WS-05);REPLACE 主要发生在 blob 丢失后的重算。

### CATALOG-05 — `find_run`(缓存查询)
- **名称**:按 cache_key 取缓存输出 version。
- **作用**:`SELECT output_version FROM runs WHERE cache_key=?` → 值或 None。
- **现位置**:`catalog.py:find_run`(117–122)。
- **入口**:`run`/`materialize` 缓存判断(配合 `store.exists`)。
- **TS 目标**:`packages/catalog`,Prisma 查询(按主键)。
- **依赖**:CATALOG-01。
- **验收点**:`test_transform_cache_hit`。

### CATALOG-06 — `runs_producing`
- **名称**:查某 version 的所有 producer run。
- **作用**:`SELECT * FROM runs WHERE output_version=?`(用 `idx_runs_output`)→ `[_row_to_run(...)]`。
- **现位置**:`catalog.py:runs_producing`(124–127)。
- **入口**:`_lineage`(取 `[0]`)、`test_transform_cache_hit`。
- **关键规则与边界(易漏)**:**无 ORDER BY** → 多 producer 时返回顺序不确定(影响 lineage `producers[0]`,见 WS-08 存疑)。
- **TS 目标**:`packages/catalog`,**建议加确定性 ORDER BY**(如 `created_at, cache_key`)以消除 lineage 不确定性(行为加固,需注明与 Python 的差异)。
- **依赖**:CATALOG-01、CATALOG-10。
- **验收点**:产出含 op/op_version/params/inputs/output_version。

### CATALOG-07 — `set_ref`(UPSERT)
- **名称**:建/更新命名指针(git-tag 风格)。
- **作用**:`INSERT INTO refs (...) VALUES (...) ON CONFLICT(name) DO UPDATE SET version=excluded.version, message=excluded.message, updated_at=excluded.updated_at`。
- **现位置**:`catalog.py:set_ref`(131–137)。
- **入口**:`add_samples`/`add`/`run`/`materialize`(给了 name/ref 时)。
- **关键规则与边界(易漏)**:**ON CONFLICT DO UPDATE**(真正的 upsert)→ 同名 ref 重新指向新 version、覆盖 message 与 updated_at(可移动指针;与 datasets/runs 的策略不同)。
- **TS 目标**:`packages/catalog`,Postgres 同写法(`ON CONFLICT (name) DO UPDATE`)。
- **依赖**:CATALOG-01、CATALOG-12。
- **验收点**:同名 ref 二次 set 移动到新 version;message/updated_at 更新。

### CATALOG-08 — `get_ref` / `list_refs`
- **名称**:取单个 ref / 列出全部 ref。
- **作用**:`get_ref(name)`= `SELECT version WHERE name=?`;`list_refs()`= `SELECT name,version ORDER BY name` → dict。
- **现位置**:`catalog.py`(139–147)。
- **入口**:`/v1/refs`(list)、`/v1/refs/{name}`(get;未命中 → 404)、`resolve`。
- **关键规则与边界**:`list_refs` **按 name 排序**;返回 `{name: version}`。
- **TS 目标**:`packages/catalog`,Prisma;list 保持 name 排序。
- **依赖**:CATALOG-01。
- **验收点**:list 顺序与数量;get 未命中 None(router → 404)。

### CATALOG-09 — `resolve`(名/版本 → 具体 version)
- **名称**:把 ref 名或 version 串解析成具体 version。
- **作用**:`if get_dataset(x) is not None: return x`(它已是已知 version);`elif (ref:=get_ref(x)) is not None: return ref`;`else: return x`(可能是尚未登记的 version,原样返回)。
- **现位置**:`catalog.py:resolve`(149–158)。
- **入口**:`Workspace.get`/`materialize`。
- **关键规则与边界(易漏)**:
  - **先查 datasets 表(version 优先),再查 refs,最后原样返回**。
  - 「原样返回」分支让「别处摄取、本地未登记的 version」也能被 `store.read` 尝试(找不到则 STORE-05 抛 KeyError)。
  - 理论上 ref 名与某 version 串相同会被当 version(极小概率)。
- **TS 目标**:`packages/catalog`,同三段优先级。
- **依赖**:CATALOG-03、CATALOG-08。
- **验收点**:传 version 串返回自身;传 ref 名返回其 version;传未知串原样返回。

### CATALOG-10 — 连接管理 / 并发(WAL + busy_timeout)
- **名称**:每操作短连接 + 并发设置。
- **作用**:`_connect` 上下文管理器:`sqlite3.connect(db, check_same_thread=False, timeout=30)`、`row_factory=Row`、`PRAGMA busy_timeout=5000`、yield 后 `commit`、finally `close`;`journal_mode=WAL` 在 `__init__` 设一次。
- **现位置**:`catalog.py`(63–83)。
- **关键规则与边界(易漏)**:
  - **每个操作一条短连接**(不跨线程共享)→ 适配 uvicorn 多线程/多 worker。
  - **WAL**:并发读 + 单写;**busy_timeout=5000ms**:写锁竞争时等待重试而非立刻报 "database is locked";connect `timeout=30`(秒)是另一层锁等待。
  - 正常退出自动 `commit`;异常会跳过 commit(由 finally close 回滚未提交)。
  - `close()` 方法是 no-op(保留 API 兼容)。
- **TS 目标**:`packages/catalog`,**Postgres 无这些 PRAGMA**:用连接池(`pg`/`postgres.js`)、事务、合适的 `statement_timeout`/`lock_timeout` 替代 busy_timeout 语义;多副本天然支持并发写(这正是 ADR-0003 弃 SQLite 的原因)。
- **依赖**:CATALOG-01。
- **验收点**:并发读写不丢数据(Postgres 下用连接池压测)。

### CATALOG-11 — 行转换器 `_row_to_dataset` / `_row_to_run`
- **名称**:sqlite Row → dict。
- **作用**:解 `kinds_json`/`params_json`/`inputs_json`(json.loads),组装结构化 dict。
- **现位置**:`catalog.py`(161–180)。
- **输出**:dataset = `{version,name,num_rows,kinds,created_at}`;run = `{cache_key,op,op_version,params,inputs,output_version,created_at}`。
- **TS 目标**:`packages/catalog`,Prisma 行映射 + jsonb 自动反序列化。
- **依赖**:无。
- **验收点**:字段名/类型与下游(`_lineage`/router)期望一致。

### CATALOG-12 — `_now`(时间戳格式)
- **名称**:统一时间戳。
- **作用**:`datetime.now(timezone.utc).isoformat()`(带 `+00:00` 偏移的 ISO8601)。
- **现位置**:`catalog.py:_now`(50–51)。
- **关键规则与边界**:所有 catalog 时间戳列用此格式;**不进任何哈希**(仅审计/展示)。
- **TS 目标**:`packages/catalog`,`timestamptz` 由 DB 生成或 `new Date().toISOString()`;格式差异无碍(不参与对拍哈希)。
- **依赖**:无。
- **验收点**:N/A(非哈希输入)。

---

## 跨域:与 service / OpenAPI 的接触点(影响迁移,非本域实现)

- **`model_json_schema` 实际用法**:brief 把它列在 `schema.py`,但代码里只在 `service/routers/transforms.py:32` 对 **transform 的 params_model** 调用(`t.params_model.model_json_schema()`),用于 `/v1/transforms` 返回参数 schema。`Sample` 的 JSON schema 由 FastAPI 的 OpenAPI(`app.openapi()` → `openapi/openapi.json`)间接产出。**TS 对应**:zod schema → `@hono/zod-openapi` 单一来源(tech-stack.md),params schema 直接由 zod 生成。
- **分页上限**:`service/meta.py` 的 `MAX_PAGE_LIMIT=500`、`DEFAULT_PAGE_LIMIT=20`;预览/列表端点强制截断,「拉全量」只能走 `/datasets/{ref}/export` 流式。迁移 router 时保留。
- **错误映射**:`store.read` 抛 `KeyError`、`detect_kind`/JSON 解析抛 `ValueError`、未知 transform/ref router 抛 404 → TS 需统一映射到错误信封。

---

## 覆盖矩阵(文件 → 功能ID)

| 文件 | 功能ID | 条数 |
|---|---|---|
| `schema.py` | CORE-01 … CORE-10 | 10 |
| `hashing.py` | HASH-01 … HASH-05 | 5 |
| `dataset.py` | DATASET-01 … DATASET-10 | 10 |
| `io.py` | IO-01 … IO-06 | 6 |
| `transform.py` | XFORM-01 … XFORM-03 | 3 |
| `ops.py` | OPS-01 … OPS-05 | 5 |
| `recipe.py` | RECIPE-01 … RECIPE-05 | 5 |
| `workspace.py` | WS-01 … WS-13 | 13 |
| `store.py` | STORE-01 … STORE-05 | 5 |
| `catalog.py` | CATALOG-01 … CATALOG-12 | 12 |
| **合计** | | **74** |

---

## 可能遗漏 / 存疑(宁可多列)

1. **哈希算法的真实落地 ✅ 已核实**:`bench/store` 既有 manifest 的 `hash_algo` 全为 `blake3`,`.venv` 装有 `blake3 1.0.9`。结论:TS 固定 blake3(`hash-wasm`)即可复用既有数据,**无需移植 blake2b 回退**。两算法值不互通这一风险因此被排除(仅当未来在缺 blake3 的环境重写数据才会触发回退)。
2. **`content_dict` 不 `exclude_none`**:所有 None 字段以 `null` 进 payload 参与哈希。这是迁移最易翻车点(JS 习惯丢 undefined)。需要逐 kind golden test。已在 CORE-06 标注,但风险高,单列重申。
3. **seeded 采样跨实现一致性**(OPS-03、RECIPE-05):polars 的 `sample(seed=...)` RNG 实现细节决定能否 bit 级复现。nodejs-polars 同 Rust 核**理论一致但未证实**——ADR-0001 已把它列为首要 golden test。若不一致,需退到 DuckDB 或自实现确定性采样。
4. **`round()` 银行家舍入**(RECIPE-05):Python `round` half-to-even vs JS `Math.round` half-up,会让混合 count 差 1 → version 不一致。必须自实现。
5. **`weight or 1.0` 对 0 的处理**(RECIPE-05):权重 0 会退化为 1.0(不是 0 行)。这是真实坑,TS 要用 `weight || 1.0` 而非 `weight ?? 1.0`。
6. **`fmt`/`target_format` 无效**(WS-10、RECIPE-02):export 完全忽略 fmt,`trl` 与 `messages-jsonl` 当前产出相同。迁移要决策:照搬(保持等价)还是补齐 trl 格式(产品决定)。
7. **lineage `producers[0]` 不确定性**(WS-08、CATALOG-06):`runs_producing` 无 ORDER BY。内容寻址下通常单 producer,但 INSERT OR REPLACE/多 cache_key 指向同 output_version 时可能多行。迁移到 `WITH RECURSIVE` 时建议加确定性排序(行为加固,需注明与 Python 差异)。
8. **catalog 三种写入策略不同**:datasets=`INSERT OR IGNORE`(首写为准)、runs=`INSERT OR REPLACE`(覆盖)、refs=`ON CONFLICT DO UPDATE`(移动指针)。务必逐表复刻到 Postgres 的对应 `ON CONFLICT` 行为,别统一成一种。
9. **`json.dumps` vs canonical**:catalog 里 `kinds_json`/`params_json`/`inputs_json` 用普通 `json.dumps`(非 canonical,带空格)。它们不参与哈希,但若做 lineage 字段对拍,应比对**解析后的对象**而非原始串(jsonb 会重新规范化)。
10. **store.read 不校验内容**:读回不重算 version 验证完整性(STORE-05)。迁移可选择加固(读后校验哈希),但要标注这是**新增行为**,可能影响「损坏对象」场景的表现。
11. **`_persist` 非事务**(WS-11):先 store 后 catalog,无原子保证;分布式下「store 成功、catalog 失败」只能靠双幂等重试收敛。需要在 TS 设计里明确这一点。
12. **空数据集 version = `hash_text("empty")`**(DATASET-04):固定常量,不是空串哈希。容易在 TS 用 `hashUnordered([])`(=空串哈希)而搞错。
13. **`word_len` 的 split 语义**(OPS-04):Python `str.split()` 折叠任意空白且丢空串;JS 必须复刻(`trim().split(/\s+/).filter(Boolean)`,空文本→0),否则 word_len 不一致 → signal 值变 → 该数据集 version 变。
14. **SFT 与 trajectory payload 同形仅 kind 不同**:二者 id 不同(payload 含 kind)。`detect_kind` 用 tool 相关字段区分;若一条 trajectory 误判为 sft(无 tool 痕迹),id/version 都会变。属数据语义边界,迁移逻辑须 1:1。
15. **`Recipe.model_dump(mode="json")` 含默认值**(RECIPE-03):fingerprint 输入包含 seed/target_format 等默认字段。TS zod 序列化必须同样**显式包含默认值**,否则指纹漂移。
16. **service 层另有一份 `SCHEMA_VERSION="1"`**(CORE-10):与 schema.py 重复定义。迁移要单一来源,避免漂移。
17. **未纳入本域但相邻**:`service/*`(app/deps/errors/registry/meta/routers)、`scripts/export_openapi.py`、`bench/`(既有 catalog.db + store,可作 golden 对拍源)。这些属 service/工具域(brief B?),本清单仅在「接触点」一节点到。
18. **DuckDB 作为兜底引擎**:ADR 把 DuckDB 设为每个 op 的 drop-in fallback。本清单按 nodejs-polars 给 TS 目标;若某 op(尤其采样)对拍失败,迁移路径是「换引擎不换设计」,验收点已按此预留。
