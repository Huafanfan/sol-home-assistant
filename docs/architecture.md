# Sol 的架构边界

## 目标架构

~~~text
┌───────────────────┐          ┌────────────────────────────────────┐
│ Voice Satellite   │  加密 LAN │            Voice Gateway           │
│ 本地唤醒/麦克风/   ├──────────►  会话、Realtime、权限、工具调度      │
│ 扬声器/静音按钮    │          └───────┬──────────────┬─────────────┘
└───────────────────┘                  │              │
                                        │              │
                              ┌─────────▼───────┐ ┌────▼─────────────┐
                              │ Memory Service  │ │ Deep Reasoner    │
                              │ 会话/摘要/记忆  │ │ Responses API    │
                              └─────────────────┘ └──────────────────┘
~~~

## 组件职责

### Voice Satellite

负责本地唤醒、音频采集/播放、物理静音按钮和本地状态灯。它只与家庭局域网中的 Gateway 连接，不应承载云端 API 密钥、数据库凭据或跨房间权限。

首版在开发机上实现一个等价的“单房间卫星”；实际硬件需通过真实房间的唤醒、噪声和回声测试后再选型。

### Voice Gateway

唯一允许发起 OpenAI 会话、执行工具调用和建立访问记录的服务。它把可短暂存在的实时会话与可长期保留的记忆管理分开，并在每次调用前检查权限。

为避免把主密钥发到房间设备，Satellite 应仅获得短时、可撤销的本地连接授权；Gateway 再代表它连接 OpenAI Realtime API。

### Memory Service

管理以下分层数据：

- 会话元数据与原始转录：按保留策略、可删除、可导出；
- 短期摘要：帮助同一会话/近期会话连续；
- 长期记忆：仅保存经过 Memory Policy 允许的偏好、持续状态、明确请求和项目事实；
- 审计记录：说明一条记忆为何被新增、修改或删除。

禁止把“允许检索”与“允许写入”混为一谈。每条新增或变更的长期记忆应记录来源会话、置信度、时间范围和可撤销性。

### Deep Reasoner

处理耗时、需要较深推理的请求。Realtime 模型负责自然对话、转场与工具编排；复杂回答可以由深度模型生成，再由实时会话以语音形式呈现。

## 语音会话状态机

~~~text
IDLE
  └─ 本地唤醒词 ─► AWAKE
AWAKE
  └─ 获得局域网授权并连接 ─► LISTENING
LISTENING
  ├─ 用户说话结束 ─► THINKING
  ├─ 超时 / 取消 ─► CLOSING
  └─ 用户新说话 ─► LISTENING
THINKING
  ├─ 需要工具 / 深度推理 ─► TOOL_CALL
  └─ 生成语音 ─► SPEAKING
TOOL_CALL
  └─ 结果返回 ─► SPEAKING
SPEAKING
  ├─ 用户打断 ─► LISTENING
  └─ 输出完成 ─► LISTENING
CLOSING
  └─ 生成会话摘要、执行 Memory Policy ─► IDLE
~~~

## 公开接口与安全边界

首版只允许以下低风险能力：

- memory_search：检索当前用户允许的记忆；
- memory_propose：提出待确认或策略允许的记忆写入；
- ask_deep_reasoner：无副作用的复杂推理；
- get_session_context：获取当前会话的短期上下文。

任何具有现实世界副作用的能力（Home Assistant 写操作、门锁、转账、摄像头、外部消息）应单独定义权限、确认机制和审计日志，不能复用上述默认授权。

## 当前技术验证

官方文档当前说明 gpt-realtime-2.1 支持实时语音输入/输出、工具调用、可配置推理、WebRTC/WebSocket/SIP 连接，以及用于语音代理的 VAD/会话功能。模型选择和价格会变化，因此每次部署前应重新核验：

- [GPT-Realtime-2.1 模型页](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [Realtime API 参考](https://platform.openai.com/docs/api-reference/realtime)

## 尚未做出的决策

1. 唤醒引擎：先评测 openWakeWord；如果误唤醒或训练需求不达标，再评估 Porcupine。
2. 语音传输：开发机阶段可直接验证 Realtime；房间设备阶段优先由 Gateway 代理/授权，而不是让设备持有云端凭据。
3. 记忆数据库：先定义迁移模型和删除语义，确认检索需求后再引入 pgvector。
4. 本地声学：AEC、降噪和远场麦克风效果必须以实际房间测试为准，不能只从硬件宣传页推断。
