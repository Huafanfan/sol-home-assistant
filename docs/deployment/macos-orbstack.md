# Mac mini + OrbStack 部署基线

## 已接受的范围

首版家庭中心运行在现有持续运行的 Apple Silicon Mac mini。OrbStack 是本机的 Docker Engine 与 Docker Compose 运行时；它提供容器服务所需的标准 Docker 接口，但不负责麦克风、扬声器、唤醒词或记忆策略。

当前机器已完成 Docker Engine、Docker Compose 和临时 arm64 容器的最小可用性验证。项目尚未创建业务 Dockerfile 或 compose.yaml，因此不存在已部署的 Sol 服务。

## 服务边界

| 位置 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| macOS 宿主机 | Swift/AVFoundation 首台 Voice Satellite 的权限、本地音频、手动控制，以及后续唤醒/VAD/AEC | 腾讯云凭据、文本推理凭据、数据库访问 |
| OrbStack / Docker Compose | Voice Gateway、Memory、数据库和未来基础服务 | 直接控制卫星麦克风或扬声器 |
| 未来家庭 LAN | 后续远程 Satellite 到 Gateway 的已认证连接；VOICE-004 不开放监听端口 | Docker 管理、数据库直连、未认证访问 |

## 交付与迁移标准

- 每项容器服务提供 Dockerfile 与 compose.yaml 配置；不使用只在 OrbStack 中有效的启动方式。
- 当前以 linux/arm64 运行；在 N100/Linux 迁移前，构建或验证 linux/amd64，并优先发布双架构镜像。
- 服务通信使用 Compose 网络和明确的端口发布；数据库默认只在内部网络可达。
- 会话、记忆和数据库数据必须位于持久化卷或 SOL_DATA_DIR，不保存在可重建的容器可写层。
- 本机 .env、备份和密钥管理文件绝不提交；服务不挂载 Docker Socket，不开放 2375 等 Docker 管理端口。

## 常驻运行验收

以下项目尚待真实环境验证，不能因为安装成功而自动视为完成：

1. Mac 防止自动睡眠、断电后恢复和登录恢复策略；
2. OrbStack 与 Compose 在重启后的恢复，以及服务的 healthcheck 和 restart policy；
3. 备份一份持久化数据后，在干净环境恢复并验证记忆可用；
4. 家庭 LAN、VPN 或路由变化后 Satellite 到 Gateway 的连通性；
5. 容器异常、腾讯云错误或文本适配器超时时，语音卫星不会持续录音或无限重试。

## 迁移到 N100/Linux

迁移不是重写：在 Linux 主机安装 Docker、取得相同架构的镜像、恢复持久化数据、启动同一 compose.yaml，并把 Satellite 的 Gateway 地址切换到新主机。语音卫星协议、腾讯云边界和 Memory Policy 都不随主机迁移而改变。

## 参考

- [OrbStack Docker 与 Compose](https://docs.orbstack.dev/docker/)
- [Docker Compose 文档](https://docs.docker.com/compose/)
