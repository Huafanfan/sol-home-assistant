# Sol 文档入口

这是每个新 session 和每项非 T0 变更的第一份必读文档。它只维护当前状态和阅读路径；具体事实由它链接到各自的权威文档。

项目级执行约束见 [`../AGENTS.md`](../AGENTS.md)。该文件要求先完成规格，再修改实现。

## 当前基线

- 产品边界：单房间、单已授权用户、无现实世界副作用的 MVP。
- 中心主机：现有 Apple Silicon Mac mini；容器运行时为 OrbStack Docker Engine 与 Docker Compose。
- 语音链路：本地唤醒/VAD → 腾讯云实时 ASR/TTS → Gateway → 可替换的文本深度推理适配器。
- 当前阶段：VOICE-002 文本适配器和 VOICE-003 腾讯云实时语音适配器均已完成真实验收；VOICE-004 已实现 Swift/AVFoundation macOS Voice Satellite、同机二进制协议和手动轮次编排，离线测试、真实子进程协议及真实麦克风→云端→扬声器中文单轮、启动前零调用、播放中手动打断、工作区无落盘和控制台用量复核均已通过。真实设备切换/断开与拒绝/受限权限路径由用户暂缓，故状态保持 `implemented`。VOICE-005 的本地唤醒与自动 VAD 第一片及 ADR 已接受，尚未开始实现；AEC、降噪、语音驱动打断、免手连续对话和常驻恢复仍由后续规格负责。

VOICE-004 的权威状态和暂缓项见 [VOICE-004：macOS Voice Satellite 本机音频闭环](features/VOICE-004-macos-voice-satellite.md)：未取得设备变化与拒绝权限的真实证据前，不把它标记为 `verified`。下一实现入口是已接受的 [VOICE-005：本地唤醒与自动 VAD（第一片）](features/VOICE-005-local-wake-vad.md)；真实模型依赖、监听和云端调用仍须单独授权。

## 按工作类型阅读

| 计划变更 | 必读文档 |
| --- | --- |
| 任意 T1/T2/T3 功能 | 本文档、相关 `docs/features/` 规格、[`architecture.md`](architecture.md)、关联 ADR |
| 语音会话、打断、唤醒、ASR/TTS | [`architecture.md`](architecture.md)、[`mvp-plan.md`](mvp-plan.md)、[ADR-0002](decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[`providers/tencent-cloud.md`](providers/tencent-cloud.md) |
| 会话、记忆、数据保留或审计 | [`architecture.md`](architecture.md)、[`mvp-plan.md`](mvp-plan.md)、[ADR-0001](decisions/ADR-0001-first-mvp-boundary.md) 与相关功能规格 |
| Mac mini、原生音频、OrbStack、Compose、备份或迁移 | [`deployment/macos-orbstack.md`](deployment/macos-orbstack.md)、[ADR-0003](decisions/ADR-0003-mac-mini-orbstack-deployment.md)、[ADR-0005](decisions/ADR-0005-native-macos-voice-satellite.md)、[`architecture.md`](architecture.md) |
| 开发流程或文档规范 | [`../AGENTS.md`](../AGENTS.md)、[ADR-0004](decisions/ADR-0004-documentation-driven-development.md)、[`templates/feature-spec.md`](templates/feature-spec.md) |

## 文档事实来源

| 主题 | 权威位置 | 何时更新 |
| --- | --- | --- |
| 当前范围、阶段和验收顺序 | [`mvp-plan.md`](mvp-plan.md) | MVP 阶段或验收目标变化时 |
| 系统边界、数据流、状态机、安全约束 | [`architecture.md`](architecture.md) | 跨组件行为或安全模型变化时 |
| 不易逆转的选择与后果 | [`decisions/`](decisions/) | T2/T3 的新决定或既有决定被替代时 |
| 单项功能/模块的具体设计与验收 | [`features/`](features/) 下的 `<feature>.md` | T1/T2/T3 工作的整个生命周期 |
| 腾讯云或文本上游边界、价格核验与验收 | [`providers/tencent-cloud.md`](providers/tencent-cloud.md) | 提供方、计费、能力或探测结论变化时 |
| Mac mini、OrbStack 与部署恢复边界 | [`deployment/macos-orbstack.md`](deployment/macos-orbstack.md) | 运行时、网络、备份或迁移方案变化时 |

不要在两处维护相同的价格、接口或隐私规则；应回链到上述权威位置。

## 每次功能迭代的最小清单

1. 在开始前判定 T0–T3，并记录需要阅读的文档。
2. 对 T1/T2/T3，创建或更新功能规格，填完目标、边界、数据/权限、失败语义和验收项。
3. 对 T2/T3，创建或更新 ADR，并在需要时取得用户确认。
4. 将规格置为 `accepted`，再开始实现；默认先提交仅文档变更。
5. 实现后更新规格的实现路径、验收证据和状态；复核受影响的其他文档。
6. 只有真实证据满足验收项时，标记 `verified`。

## 已接受的架构决策

- [ADR-0001：单房间、单用户、无副作用边界](decisions/ADR-0001-first-mvp-boundary.md)
- [ADR-0002：腾讯云语音层与文本深度推理适配器](decisions/ADR-0002-tencent-voice-and-text-reasoner.md)
- [ADR-0003：Mac mini 和 OrbStack 容器化中心](decisions/ADR-0003-mac-mini-orbstack-deployment.md)
- [ADR-0004：文档驱动的规格先行开发](decisions/ADR-0004-documentation-driven-development.md)
- [ADR-0005：原生 macOS Voice Satellite](decisions/ADR-0005-native-macos-voice-satellite.md)
- [ADR-0006：本地唤醒与自动 VAD 的 Satellite 边界](decisions/ADR-0006-local-wake-vad-boundary.md)

## 当前功能规格

| 规格 | 状态 | 下一步 |
| --- | --- | --- |
| [VOICE-001：开发机语音会话编排核心](features/VOICE-001-development-voice-session-core.md) | `implemented` | VOICE-002/003/004 已离线接入；随 VOICE-004 完成真实本机音频与端到端验收 |
| [VOICE-002：文本深度推理适配器准备与探测](features/VOICE-002-text-reasoner-readiness.md) | `verified` | 已完成安全适配、0600 本机 `.env`、mock 与真实 Probe 验收；默认 `gpt-5.6-terra` |
| [VOICE-003：腾讯云实时 ASR/TTS 适配器与安全探测](features/VOICE-003-tencent-realtime-voice-adapters.md) | `verified` | 31/31 自动化、真实 TTS→ASR 指标、独立取消和控制台用量复核均已通过 |
| [VOICE-004：macOS Voice Satellite 本机音频闭环](features/VOICE-004-macos-voice-satellite.md) | `implemented` | 离线、真实子进程、中文单轮、零调用、手动打断和用量/无落盘复核通过；设备变化与拒绝权限由用户暂缓 |
| [VOICE-005：本地唤醒与自动 VAD（第一片）](features/VOICE-005-local-wake-vad.md) | `accepted` | 先实现本地监听、唤醒、自动 VAD、能力协商与离线替身；真实引擎/监听/云端调用需另行授权 |
