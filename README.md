# Sol Home Assistant

一个以隐私、持续记忆和自然语音交互为中心的家庭 AI 助手。

## 当前目标

第一阶段只验证“一个房间、一个使用者”的完整闭环：

> 本地检测 “Hi Sol” → 语音连续对话 → 可以打断 → 会话被安全保存 → 只有经政策允许的信息进入长期记忆。

这不是一个把麦克风直接连到云端的智能音箱；本项目将声音入口、会话大脑、长期记忆和家庭工具分为独立边界。

## 已确认的工程原则

- 唤醒词检测必须在本地完成；未唤醒状态的音频不离开设备。
- Voice Satellite 不保存腾讯云、文本推理提供方或数据库凭据，也不直接拥有外部工具权限。
- Voice Gateway 是会话、模型调用与权限校验的唯一入口。
- 长期记忆不是原始转录的备份；写入、更新、删除均须通过可审计的 Memory Policy。
- 首版只支持单用户、单房间、只读能力；智能家居写操作、多人识别和跨设备同步均后置。
- 每个设备应有物理静音开关与明确的录音/连接状态提示。
- 只有唤醒后的输入音频可以发送给腾讯云；文本推理代理只接收最小化、脱敏后的文本上下文。

## 当前技术基线

- 服务端：Node.js + TypeScript
- 本地语音入口：唤醒词、VAD、采集/播放和物理静音均在 Satellite 完成
- 实时语音：腾讯云实时 ASR 与实时 TTS；首版不依赖 OpenAI Realtime API 或官方 OpenAI API 密钥
- 深度推理：可替换的 OpenAI-compatible 文本适配器；首个候选为本地部署的 CLIProxyAPI，实际模型、流式能力和工具能力均须通过启动探测验证
- 联网搜索：不在 MVP 内；将来必须作为独立、可追溯来源的 Search Provider 接入，不能假定文本模型天然联网
- 记忆：先采用可迁移的关系数据模型；PostgreSQL/pgvector 在需要语义检索时引入
- 部署中心：首版使用当前持续运行的 Apple Silicon Mac mini；Voice Satellite 的音频路径首先以 macOS 宿主机进程运行
- 服务运行时：OrbStack 的 Docker Engine + Docker Compose；Gateway、Memory 和未来基础服务容器化，Dockerfile 与 compose.yaml 保持 Linux arm64/amd64 可迁移，N100/Linux 是后续主机选择而非首版前提

请从 [文档入口](docs/START-HERE.md) 开始，再查看 [架构说明](docs/architecture.md)、[Mac mini / OrbStack 部署基线](docs/deployment/macos-orbstack.md)、[腾讯云语音层说明](docs/providers/tencent-cloud.md)、[MVP 路线图](docs/mvp-plan.md) 和 [架构决策记录](docs/decisions/)。任何 T1 及以上功能都必须先有已接受的功能规格，具体执行规则见 [AGENTS.md](AGENTS.md)。

## 当前范围外

- 在未完成隐私与权限设计前接入摄像头、门锁、报警器或其他高风险设备
- 自动把全部历史对话写入长期记忆
- 直接修改 ChatGPT 产品自己的 Memory
- 将原始音频、完整转录或完整长期记忆直接转发给文本推理代理
- 在未测试实际房间声学环境前承诺某个唤醒词或 AEC 方案的准确率
- 将 Docker Socket 挂载给 Sol 服务，或把 Docker API 暴露到局域网

## 目录

~~~text
AGENTS.md             跨 session 的文档优先与验收约束
docs/                 架构、分阶段计划与决策记录
docs/START-HERE.md    当前状态、文档导航与 session 启动入口
docs/decisions/       影响未来实现的可追溯决策
docs/deployment/      Mac mini、Docker 与迁移边界
docs/features/        按功能/模块建立的可实现规格
docs/providers/       外部语音与推理提供方的边界、成本与验收说明
docs/templates/       功能规格模板
.env.example          仅变量名，绝不包含真实密钥
~~~

## 下一步

VOICE-001 已交付可离线验证的会话编排核心。下一步是在保持同一文档门槛下，为真实腾讯云、文本上游和 macOS 音频适配器补充规格与运行验收；完整目标与验收顺序见 [MVP 路线图](docs/mvp-plan.md)。

## 当前可运行的开发者诊断

[VOICE-001](docs/features/VOICE-001-development-voice-session-core.md) 已实现会话状态机、取消传播、最小化文本边界和确定性适配器；它不是已验证的真实语音助手，也不读取任何云端凭据。

~~~bash
npm install
npm run check
npm run demo
~~~

`npm run demo` 只运行本地模拟的 ASR、文本推理、TTS 和播放，并输出脱敏状态/指标。真实腾讯云、文本上游、麦克风、扬声器、唤醒词和 VAD 的接入与验收仍是后续工作。
