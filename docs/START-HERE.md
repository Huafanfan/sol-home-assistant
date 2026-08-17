# Sol 文档入口

这是每个新 session 和每项非 T0 变更的第一份必读文档。它只维护当前状态和阅读路径；具体事实由它链接到各自的权威文档。

项目级执行约束见 [`../AGENTS.md`](../AGENTS.md)。该文件要求先完成规格，再修改实现。

## 当前基线

- 产品边界：单房间、单已授权用户、无现实世界副作用的 MVP。
- 中心主机：现有 Apple Silicon Mac mini；容器运行时为 OrbStack Docker Engine 与 Docker Compose。
- 语音链路：本地唤醒/VAD → 腾讯云实时 ASR/TTS → Gateway → 可替换的文本深度推理适配器。
- 当前阶段：架构、提供方和部署基线已接受；VOICE-001 会话核心和 VOICE-003 腾讯云实时语音适配器已实现并通过自动化测试，VOICE-002 文本适配器已完成真实探测；VOICE-003 最终真实 Probe 已通过成功路径、延迟/用量指标和独立取消边界，只等待用户核对腾讯云控制台用量后标记 `verified`。

当前实现入口是 [VOICE-003：腾讯云实时 ASR/TTS 适配器与安全探测](features/VOICE-003-tencent-realtime-voice-adapters.md)。后续新功能仍须从 [`templates/feature-spec.md`](templates/feature-spec.md) 创建 `docs/features/<feature>.md`，并将其推进到 `accepted`。

## 按工作类型阅读

| 计划变更 | 必读文档 |
| --- | --- |
| 任意 T1/T2/T3 功能 | 本文档、相关 `docs/features/` 规格、[`architecture.md`](architecture.md)、关联 ADR |
| 语音会话、打断、唤醒、ASR/TTS | [`architecture.md`](architecture.md)、[`mvp-plan.md`](mvp-plan.md)、[ADR-0002](decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[`providers/tencent-cloud.md`](providers/tencent-cloud.md) |
| 会话、记忆、数据保留或审计 | [`architecture.md`](architecture.md)、[`mvp-plan.md`](mvp-plan.md)、[ADR-0001](decisions/ADR-0001-first-mvp-boundary.md) 与相关功能规格 |
| Mac mini、OrbStack、Compose、备份或迁移 | [`deployment/macos-orbstack.md`](deployment/macos-orbstack.md)、[ADR-0003](decisions/ADR-0003-mac-mini-orbstack-deployment.md)、[`architecture.md`](architecture.md) |
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

## 当前功能规格

| 规格 | 状态 | 下一步 |
| --- | --- | --- |
| [VOICE-001：开发机语音会话编排核心](features/VOICE-001-development-voice-session-core.md) | `implemented` | 由 VOICE-003 接入腾讯云语音适配器；后续由独立规格接入 macOS 音频 |
| [VOICE-002：文本深度推理适配器准备与探测](features/VOICE-002-text-reasoner-readiness.md) | `verified` | 已完成安全适配、0600 本机 `.env`、mock 与真实 Probe 验收；默认 `gpt-5.6-terra` |
| [VOICE-003：腾讯云实时 ASR/TTS 适配器与安全探测](features/VOICE-003-tencent-realtime-voice-adapters.md) | `implemented` | 31/31 自动化、真实 TTS→ASR 指标和独立取消均已通过；用户核对控制台用量后判定 `verified` |
