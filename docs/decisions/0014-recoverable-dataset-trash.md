# ADR 0014 — 可恢复的数据集回收站

- **状态:** Accepted——owner 于 2026-07-25 确认采用“删除到回收站，可恢复”
- **日期:** 2026-07-25
- **决策者:** owner
- **依赖:** [ADR 0013](0013-v2-product-cutover-and-v1-retirement.md)、
  [v2 技术方案](../v2/TECHNICAL-DESIGN.md)
- **下游设计:** [数据集回收站技术方案](../v2/DATASET-TRASH-TECHNICAL-DESIGN.md)

## 背景

当前产品中的“数据集名称”是指向 immutable dataset snapshot 的 Ref。直接删除 Ref 行虽然不会
删除已登记 snapshot、layout、artifact 或 lineage，但会让没有保存 exact version 的用户无法在
产品中重新发现该版本。它不是对象存储 orphan，却会成为产品层面的 detached snapshot。

另一方面，在普通产品请求中级联删除 snapshot、run、revision locator、lineage 与对象存储内容，
会违反现有 immutable、`ON DELETE RESTRICT`、精确对象 key 和显式 maintenance 边界。

## 决策

1. 产品“删除数据集”定义为把 Ref 移入回收站，不删除 Ref 行或底层 immutable 数据。
2. `refs_v2` 增加 nullable `deleted_at`；`NULL` 表示 active，非 `NULL` 表示 trashed。
3. 删除和恢复都绑定 `expected_version` 并使用原子 CAS：并发移动不得被误删或误恢复。
4. 正常 Ref list/get/resolve 只返回 active Ref；回收站使用独立的可分页读取面。
5. 回收站保留 name 唯一性；删除后同名 Ref 不能被隐式新建，必须先恢复。
6. 重复删除同一版本返回 `already_deleted`；重复恢复同一版本返回 `already_active`。
7. 不设置自动过期，不增加常驻 GC，不删除 manifest/artifact，不改变 snapshot/lineage identity。
8. 永久清除若未来需要，必须通过独立 ADR 与显式 maintenance 流程设计依赖检查、locator
   repoint、精确 key manifest 和 operator confirmation。

## 后果

- 用户可以从正常列表移除数据集，并在回收站重新发现和恢复它。
- exact version、transform inputs/outputs、record lineage 和 audit 继续有效。
- 删除不会释放 Postgres 或对象存储空间；UI 必须明确这一点。
- 所有既有 Ref 在 additive migration 后保持 active。
