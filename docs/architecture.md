# Sol 的架构边界

## 目标架构

~~~text
┌───────────────────┐  认证 LAN  ┌────────────────────────────────────────────┐
│ Voice Satellite   │◄──────────►│               Voice Gateway                │
│ 本地唤醒/VAD/     │             │ 会话、路由、权限、取消、工具与审计           │
│ 麦克风/扬声器/    │             └──────┬───────────┬───────────┬───────────┘
│ 静音按钮/状态灯    │                    │           │           │
└───────────────────┘          ┌─────────▼───┐ ┌─────▼─────┐ ┌──▼─────────────────┐
                               │ Memory      │ │ 腾讯云语音 │ │ Text Deep Reasoner │
                               │ Service     │ │ ASR / TTS │ │ 可替换文本适配器     │
                               │ 会话/摘要/  │ │ 仅唤醒后音频│ │ CLIProxyAPI 候选    │
                               │ 记忆/审计   │ └───────────┘ └────────────────────┘
                               └─────────────┘
~~~

声音入口、会话与记忆、云端语音服务、文本深度推理必须保持独立。首版不依赖 OpenAI Realtime API，也不把任何文本代理当作完整的语音代理。

## 组件职责

### Voice Satellite

负责本地激活、唤醒/VAD、音频采集/播放、物理静音按钮和本地状态。未激活音频不离开设备。它只与 Gateway 连接，不应承载腾讯云、文本推理提供方或数据库凭据，也不应拥有跨房间权限。

首版按 [ADR-0005](decisions/ADR-0005-native-macos-voice-satellite.md) 在开发机上以 Swift/AVFoundation 实现原生 macOS 宿主进程。VOICE-004 先通过版本化的同机进程协议完成手动激活、麦克风采集、扬声器播放和手动打断；唤醒、自动 VAD、AEC/降噪和认证 LAN Satellite 协议由后续规格实现。实际硬件需通过真实房间的唤醒、噪声和回声测试后再选型。

### Voice Gateway

唯一允许建立会话、调用腾讯云语音服务、调用文本推理适配器、执行工具调用和建立访问记录的服务。它把可短暂存在的实时会话与可长期保留的记忆管理分开，并在每次调用前检查权限。

Gateway 维护对外连接、请求超时与取消：用户打断时必须停止本地播放和未完成的 TTS；若深度推理仍无可播放结果，也应取消或忽略其后续输出。Satellite 只获得短时、可撤销的本地连接授权。

### 腾讯云语音适配器

腾讯云只承担两件事：

- 实时 ASR：将唤醒后的输入音频流转换为部分/最终文本；
- 实时 TTS：将 Gateway 已批准的回答文本流转换为可立即播放的音频。

腾讯云凭据只存在于 Gateway。ASR 不应收到未唤醒音频；TTS 不应收到原始用户音频、长期记忆或工具凭据。标准实时 ASR 与大模型 2.0 ASR、精品音色与大模型音色均通过同一适配器评测，代码不得写死价格、引擎名或音色 ID。

### Text Deep Reasoner

处理耗时、需要较深推理的文本请求。首个候选是本地 CLIProxyAPI 提供的 OpenAI-compatible 上游，但它只被当作文本适配器：

- 只接收最终转写、最小化的会话摘要和已获准的结构化工具结果；
- 不接收原始音频、完整转录、完整长期记忆或腾讯云凭据；
- 部署前探测实际模型名、流式响应、超时和工具调用能力；
- 不假定支持 Realtime、Responses API、音频或联网搜索。

常规、低风险请求可由确定性规则或后续的本地/低成本文本路由处理；只有需要的请求才进入深度推理。

### Memory Service

管理以下分层数据：

- 会话元数据与原始转录：按保留策略、可删除、可导出；
- 短期摘要：帮助同一会话/近期会话连续；
- 长期记忆：仅保存经过 Memory Policy 允许的偏好、持续状态、明确请求和项目事实；
- 审计记录：说明一条记忆为何被新增、修改或删除。

禁止把“允许检索”与“允许写入”混为一谈。每条新增或变更的长期记忆应记录来源会话、置信度、时间范围和可撤销性。

## 首版部署与可迁移性

~~~text
Mac mini（macOS，持续运行）
├── 宿主机进程
│   └── 首台 Voice Satellite：Swift/AVFoundation 音频、手动控制；后续唤醒/VAD/AEC
└── OrbStack Docker Engine
    └── Docker Compose（服务出现后）
        ├── Voice Gateway
        ├── Memory Service / 数据库
        └── 未来的低风险基础服务
~~~

首版中心主机是现有的 Apple Silicon Mac mini。OrbStack 只负责 Linux 容器运行时；它不是语音硬件抽象层。因此 Satellite 的音频设备、权限、手动打断以及后续唤醒/VAD/AEC 保留在 Swift/AVFoundation macOS 宿主进程，而 Gateway、Memory 与供应商适配逻辑从首次实现起按可容器化服务设计。VOICE-004 只使用同机进程协议，不提前开放家庭 LAN 监听端口。

Dockerfile 与 compose.yaml 是跨主机契约，而非 macOS 专属实现：当前镜像首先支持 linux/arm64；迁移到 N100/Linux 前，应验证 linux/amd64 或发布双架构镜像。服务之间使用 Compose 网络和显式端口映射，不依赖 host network、Docker Desktop 特性或 macOS 路径。Voice Satellite 只知道 Gateway 的认证 LAN 地址，不需要、也不得接触 Docker API。

数据库、会话记录和记忆数据必须置于明确的持久化卷或由 SOL_DATA_DIR 指向的宿主机目录；容器可随时重建，数据不可随容器生命周期消失。真实凭据只保存在本机未提交的配置中。不得向容器挂载 Docker Socket，也不得把 Docker TCP API 暴露至局域网。

“24 小时可用”尚不是已经验证的承诺。在宣布常驻部署完成前，必须实测 Mac 的睡眠策略、断电恢复、用户登录后的 OrbStack/Compose 恢复、服务 restart policy、数据备份恢复和局域网连接。上述运行保障应独立于语音功能验收。

## 语音会话状态机

~~~text
IDLE
  └─ 本地唤醒词 ─► AWAKE
AWAKE
  └─ 获得局域网授权并连接 ─► ASR_STREAMING
ASR_STREAMING
  ├─ 部分转写 ─► ASR_STREAMING
  ├─ 最终转写 / 判停 ─► ROUTING
  ├─ 超时 / 取消 ─► CLOSING
  └─ 用户继续说话 ─► ASR_STREAMING
ROUTING
  ├─ 直接回答 / 只读工具 ─► TTS_STREAMING
  └─ 需要深度推理 ─► DEEP_REASONING
DEEP_REASONING
  ├─ 首段文本 ─► TTS_STREAMING
  ├─ 提供方错误 / 超时 ─► FALLBACK
  └─ 取消 ─► CLOSING
TTS_STREAMING
  ├─ 音频包 ─► SPEAKING
  ├─ 用户打断 ─► ASR_STREAMING
  └─ 输出完成 ─► LISTENING
SPEAKING
  ├─ 用户打断 ─► ASR_STREAMING
  └─ 当前片段结束 ─► TTS_STREAMING / LISTENING
FALLBACK
  └─ 本地短提示 ─► CLOSING
CLOSING
  └─ 生成会话摘要、执行 Memory Policy ─► IDLE
~~~

LISTENING 表示等待同一已唤醒会话的下一轮语音；只有 ASR_STREAMING 能把音频发往云端。回答文本一旦可用即可启动 TTS，不必等待整段深度推理完成。

## 数据与安全边界

| 外部目标 | 可以收到 | 不得收到 |
| --- | --- | --- |
| 腾讯云 ASR | 唤醒后的当前轮音频与必要会话标识 | 未唤醒音频、长期记忆、文本代理凭据 |
| 腾讯云 TTS | 已批准的回答文本和音色配置 | 用户原始音频、完整会话记录、长期记忆 |
| 文本深度推理适配器 | 最终转写、最小化摘要、已批准工具结果 | 原始音频、完整转录、完整长期记忆、腾讯云凭据 |

首版只允许以下低风险能力：

- memory_search：检索当前用户允许的记忆；
- memory_propose：提出待确认或策略允许的记忆写入；
- ask_deep_reasoner：无副作用的复杂文本推理；
- get_session_context：获取当前会话的短期上下文。

MVP 不提供 web_search。任何具有现实世界副作用的能力（Home Assistant 写操作、门锁、转账、摄像头、外部消息）或未来搜索能力，都应单独定义权限、确认机制、来源/成本和审计日志，不能复用上述默认授权。

## 当前技术验证

腾讯云文档提供实时 ASR 与实时 TTS 的独立流式接口；实时 TTS 使用 WebSocket，可边合成边播放。腾讯云的免费额度与价格会变动，因此部署前应重新核验控制台、后付费开关和资源包状态：

- [腾讯云实时 ASR 与计费](https://cloud.tencent.com/document/product/1093/35686)
- [腾讯云实时 TTS](https://cloud.tencent.com/document/api/1073/94308)
- [腾讯云 TTS 计费](https://cloud.tencent.com/document/product/1073/34112)
- [CLIProxyAPI 能力说明](https://github.com/router-for-me/CLIProxyAPI)

## 尚未做出的决策

1. 唤醒引擎：先评测 openWakeWord；如果误唤醒或训练需求不达标，再评估 Porcupine。
2. ASR：用同一组真实房间样本比较标准实时 ASR 与大模型 2.0 ASR，再决定默认档位。
3. TTS：以精品音色完成 POC，再根据首音频延迟、清晰度和主观自然度选择是否升级到大模型音色。
4. 文本推理代理：以启动探测验证可用模型、流式、限流、超时和工具能力；无能力时必须有本地降级提示。
5. 记忆数据库：先定义迁移模型和删除语义，确认检索需求后再引入 pgvector。
6. 本地声学：AEC、降噪和远场麦克风效果必须以实际房间测试为准，不能只从硬件宣传页推断。
7. 运行保障：在真实 Mac mini 上验证睡眠、断电、重启、OrbStack 恢复、数据备份和家庭网络变化后的行为，再定义常驻服务等级。
