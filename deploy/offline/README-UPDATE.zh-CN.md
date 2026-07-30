# Databench 离线增量升级包

这是绑定指定基线版本的增量升级包，只包含发生变化的应用镜像。

它不能用于空机器首次安装，也不能代替对应的完整离线安装包。目标机器必须已经通过完整包或
上一份增量包安装了 `update-manifest.json` 声明的精确 `base_version`，并且安装记录中的发布包
SHA-256 必须与本包声明的基线一致。

## 升级

先把 `.tar.gz` 和同名 `.sha256` 放在同一目录：

```bash
sha256sum -c databench-offline-update-<base>-to-<target>-linux-amd64.tar.gz.sha256
tar -xzf databench-offline-update-<base>-to-<target>-linux-amd64.tar.gz
cd databench-offline-update-<base>-to-<target>-linux-amd64
sudo ./upgrade.sh
```

操作入口与完整包升级一致，仍然执行维护停写、一致性备份、migration、健康检查、生命周期
smoke 和失败自动恢复。区别只是 `docker load` 仅导入 `changed-images.lock` 中列出的变化镜像。

## 版本与恢复

- 增量包只能从声明的精确基线升级，不能跨版本跳装。
- 升级成功后，`databenchctl status` 显示目标版本。
- 普通回滚仍使用 `sudo databenchctl rollback <base-version>`。
- 灾难恢复或新机器重装必须同时保留最近的完整离线包，以及从该完整版本到目标版本的全部
  增量包；先安装完整包，再按版本顺序执行每份增量包的 `upgrade.sh`。
- 如果 Compose、基础镜像、安装器、持久化布局或离线运行契约发生变化，应发布新的完整包，
  不应使用增量包。
