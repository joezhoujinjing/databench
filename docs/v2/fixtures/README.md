# v2 Fixture 约定

机器可读索引是 [index.json](index.json)。它列出 V1-V16必须建立的 fixed vectors、goldens、
integration fixtures与 E2E场景；实现 Step不得只增加测试而不更新索引状态。

## 命名

- 稳定 ID 使用 kebab-case，例如 `dataset-empty-2-0-0`；一旦进入 accepted profile不得重命名；
- JSON输入/期望值使用 `<id>.input.json`、`<id>.expected.json`；
- 精确 UTF-8/hash preimage使用 `<id>.input.utf8`、`<id>.expected.hex`；
- Parquet固定 bytes使用 `<id>.expected.parquet`，不得用只比较“重复运行相同”代替；
- browser/API场景使用 `<id>.fixture.json`，测试源码仍放所属 app/package的 `test`目录；
- fixture禁止包含 credential、signed URL、record生产数据或本地绝对路径。

## 落点

```text
packages/<owner>/test/golden/fixtures/v2/
apps/<owner>/test/golden/fixtures/v2/
```

跨 package场景由最上层 owner持有，不复制多份 expected。`docs/v2/fixtures/index.json`中的
`path` 是未来/当前 fixture主文件；配套文件使用相同 ID前缀。

## 状态

- `planned`: V0只登记需求，尚未实现；
- `active`: 对应 Step正在实现，expected值尚未过 gate；
- `verified`: 对应 Step gate已经直接断言固定 bytes/value并通过。

Step完成时，该 Step的全部 index entries必须是 `verified`。若 expected值变化，必须先说明
identity profile、record schema、layout或 converter版本迁移；禁止直接更新 snapshot掩盖 drift。
