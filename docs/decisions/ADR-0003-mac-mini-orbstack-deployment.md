# ADR-0003：首版以 Mac mini 和 OrbStack 承载容器化中心

## 状态

已接受（2026-08-16）

## 背景

当前已有一台持续运行的 Apple Silicon Mac mini，因此首版无需购买 N100 小主机。与此同时，家庭助手的长期方向包含独立卫星、持久化记忆和迁移到 Linux 主机，不能把核心服务绑定到 macOS 专属实现。

语音设备在 macOS 上需要直接处理麦克风、扬声器、唤醒词和打断；把这些硬件路径强行置于容器中会增加虚拟化和音频设备的不确定性。

## 决策

- 首版中心运行于现有 Mac mini；OrbStack 提供 Docker Engine 和 Docker Compose 运行时。
- Voice Satellite 的第一版为 macOS 宿主机进程。它不容器化，不保存云端凭据，也不接触 Docker API。
- Voice Gateway、Memory 和后续基础服务按 Dockerfile 与 compose.yaml 交付。Compose 是跨平台部署契约，而不是只适用于 OrbStack 的配置。
- 当前镜像目标为 linux/arm64；迁移到 N100/Linux 前必须验证 linux/amd64 或发布双架构镜像。
- 数据使用显式持久化卷或宿主机数据目录；不得依赖容器可写层保存会话或记忆。
- 不向 Sol 服务挂载 Docker Socket，不启用 Docker TCP API，也不将数据库直接开放给家庭 LAN。

## 后果

可以在不增加硬件的前提下启动 MVP，同时保留迁移到 N100/Linux 的路径。代价是首版需要维护“宿主机语音卫星 + 容器化中心”两个运行边界，并实际验证 Mac 睡眠、断电恢复、登录恢复、OrbStack 恢复、数据备份和家庭网络变化。

安装 OrbStack 不等于已经满足常驻运行条件；上述恢复测试完成前，系统只能视为开发/POC 环境。
