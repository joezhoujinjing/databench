# Swift Studio GPU 离线运行指南

离线包包含固定版本的 ms-swift v4.4.2、完整原生 Gradio UI、CUDA/PyTorch 运行时和 Databench
Dataset/Session/LoRA Artifact/EvalScope 桥接。Swift GPU 服务默认关闭，只有 NVIDIA 机器显式启用。

## 1. 目标机前置条件

- Ubuntu 22.04 amd64；
- NVIDIA 驱动可用，`nvidia-smi -L` 能列出目标 GPU；
- 已安装并配置 NVIDIA Container Toolkit，`docker run --gpus` 可用；
- GPU 显存和数据盘空间满足实际模型与训练参数；
- 基础模型已通过离线介质预置。发布包包含运行时，不包含第三方模型权重。

## 2. 预置离线模型

把模型的完整本地目录复制到目标机，例如：

```bash
sudo install -d -o root -g root -m 0755 /srv/databench/swift-models
sudo cp -a Qwen2.5-0.5B-Instruct /srv/databench/swift-models/
sudo find /srv/databench/swift-models/Qwen2.5-0.5B-Instruct -type d -exec chmod 0755 {} +
sudo find /srv/databench/swift-models/Qwen2.5-0.5B-Instruct -type f -exec chmod 0644 {} +
```

容器内对应路径为：

```text
/opt/databench-models/Qwen2.5-0.5B-Instruct
```

建议同时保存模型来源、精确 revision 和文件校验值。示例小模型可以使用
`Qwen/Qwen2.5-0.5B-Instruct`，revision
`7ae557604adf67be50417f59c2c2f167def9a775`；现场也可以预置其他与 ms-swift v4.4.2
兼容的模型。

## 3. 安装时一次启用 GPU

默认使用宿主机 GPU `0`：

```bash
sudo env \
  DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api \
  DATABENCH_ENABLE_SWIFT_GPU=true \
  ./install.sh
```

选择另一张卡：

```bash
sudo env \
  DATABENCH_MCP_PUBLIC_BASE_URL=http://<稳定内网IP或DNS>/api \
  DATABENCH_ENABLE_SWIFT_GPU=true \
  DATABENCH_SWIFT_GPU_DEVICE_ID=1 \
  ./install.sh
```

安装器会执行一次快速 CUDA 可用性检查，然后启动 Swift Studio、API、EvalScope 和 Web。它不会运行
LoRA 训练或下载模型；启用时还会拒绝空的 `/srv/databench/swift-models`，避免安装成功后才发现没有
任何离线模型。启用状态和双向 Provider credential 写入
`/etc/databench/swift.env`，后续重启和正常升级自动复用。

## 4. 安装后检查

```bash
sudo databenchctl status
sudo databenchctl doctor
sudo databenchctl logs swift-studio
```

`doctor` 的 Swift 结果应为：

```json
{"swift":{"gpu":true,"ok":true}}
```

浏览器访问：

```text
http://<服务器地址>/training
```

页面不可用时依次检查 `nvidia-smi`、NVIDIA Container Toolkit、`swift-studio` 日志和
`/srv/databench/swift-studio` 的 owner 是否为 UID/GID `10002:10002`。

## 5. 最小训练闭环

1. 在 `/training` 选择 Databench Dataset Ref 和 exact version；
2. 检查 `ms-swift@1.0.0` 导出数量及 fidelity，创建 Studio Session；
3. Gradio 打开后，Dataset、`output_dir` 和 logging 目录已经预填；
4. 在 Model 字段填写本地模型绝对路径，例如
   `/opt/databench-models/Qwen2.5-0.5B-Instruct`；
5. 在原生 Train 页面选择 SFT + LoRA 并启动；训练状态、日志和 Stop 仍由原生 Runtime Tab 管理；
6. 训练完成后回到 Databench 外层的产物区域，发现 checkpoint 并导入 LoRA Artifact；
7. Artifact 导入后不再依赖可变的 Session output，可继续注册 Deployment 和发起 EvalScope 评测。

Studio Session 只表示数据和工作目录已经准备好，不等同于 Databench Training Run。原生 Gradio
中的全部页面仍保留，但未经真实现场验证的模型/CUDA/DeepSpeed/Megatron/量化组合不自动获得支持声明。

## 6. 推理部署与 EvalScope

可以在原生 Infer/Deploy 页面使用同一个本地基础模型和 LoRA output。若在 Swift Studio 容器内启动
OpenAI-compatible 服务并监听 `8000`，Databench Deployment 注册地址使用：

```text
http://swift-studio:8000/v1
```

安装器在启用 Swift 时自动允许 EvalScope 访问 Docker 私网的 `8000` 端口。注册、探活和停用
Deployment 需要 operator token，可由管理员只读获取：

```bash
sudo sed -n 's/^DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN=//p' \
  /etc/databench/databench.env
```

将该值临时填入浏览器的后端连接 Token；不要把 token 复制进模型参数、日志或共享文档。

## 7. 维护、备份与模型保留

升级、回滚、重启和备份前，必须先在 Gradio Runtime Tab 停止训练、推理和部署任务。维护脚本检测到
原生 Swift 任务时会拒绝停止容器，避免直接杀掉训练进程。脚本先停止 Web admission，再检查原生任务，
所以检查与停机之间不能从页面新启动任务。若升级会关闭 Swift、移除 Swift 或更换 Swift image digest，
还必须先在 Databench 外层关闭 active Studio Session，避免旧 Session 被新镜像继续运行而破坏 lineage。

Swift 启用时，一致性备份包含 Swift Session workspace、input、output、logs、Artifact import 状态和加密的
`swift.env`。以下两类大文件不会进入普通 Databench 备份：

- `/srv/databench/swift-studio/cache` 模型缓存；
- `/srv/databench/swift-models` operator 预置模型。

它们不会被升级、回滚或恢复脚本删除，但必须由管理员使用独立介质备份并保存校验值。恢复会保留
`cache` 和 `home`，并把其余 Session workspace 精确恢复成备份镜像；恢复前当前
`DATABENCH_SWIFT_ENABLED` 必须与 backup manifest 的 `swift_enabled` 完全一致。
