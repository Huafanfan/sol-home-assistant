# 功能规格：VOICE-005 本地唤醒与自动 VAD（第一片）

> 本规格在 VOICE-004 已验证的手动本机闭环之前增加一层前台、本地、隐私优先的激活边界：唤醒词和 VAD 都在 macOS Voice Satellite 内完成，只有用户已唤醒并开始说话后的音频才能进入既有 Gateway 与腾讯云链路。

## 元数据

| 字段 | 内容 |
| --- | --- |
| 状态 | `accepted` |
| 变更等级 | `T2` |
| 创建日期 | 2026-08-20 |
| 最后文档复核 | 2026-08-20 |
| 设计依据 | 用户确认先实现本地唤醒词与自动 VAD；AEC、降噪、真正免手连续对话和 24 小时常驻留给后续规格 |
| 关联 ADR | [ADR-0001](../decisions/ADR-0001-first-mvp-boundary.md)、[ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[ADR-0003](../decisions/ADR-0003-mac-mini-orbstack-deployment.md)、[ADR-0004](../decisions/ADR-0004-documentation-driven-development.md)、[ADR-0005](../decisions/ADR-0005-native-macos-voice-satellite.md)、[ADR-0006](../decisions/ADR-0006-local-wake-vad-boundary.md) |
| 预期实现路径 | `apps/voice-satellite-macos/`（本地监听、唤醒/VAD 与协议）、`apps/voice-gateway/src/satellite/`（能力协商与会话桥接）、`packages/voice-session/`（激活契约）、对应 Swift/TypeScript 测试与开发 CLI |
| 验收负责人 | Codex：规格、ADR、离线状态机/协议/隐私测试和安全诊断；用户：真实本地监听授权、房间唤醒/VAD 体验、任何真实云端单轮授权 |

## 1. 目标与非目标

### 目标

- 在用户显式启动的前台 `LOCAL_LISTENING` 模式中，本地处理麦克风帧并检测唤醒词；未唤醒音频绝不离开 Satellite。
- 仅在本地 `speech_started` 事件后创建 VOICE-001 会话并把后续 16kHz、单声道、16-bit PCM 交给腾讯云 ASR；`speech_ended` 自动关闭该输入。
- 复用 VOICE-004 的有界时长、设备失败、手动停止、取消、播放和安全指标语义；误唤醒但未说话时零 ASR 调用。
- 为可替换的本地唤醒/VAD 引擎定义可注入契约、版本化协议能力和确定性测试替身；先完成 openWakeWord 的本地评测，再决定是否需要 Porcupine 评测。
- 只记录脱敏事件类型、计数、持续时间、状态和安全错误码；不记录原始音频、唤醒词内容、检测分数、完整转写、设备名称或凭据。

### 非目标

- 本第一片不实现 AEC、降噪、波束成形、远场麦克风调优、声纹识别或音色/关键词训练。
- 不实现语音驱动的播放打断、同一上下文的免手连续对话、自动重开 ASR、后台守护、24 小时常驻、登录恢复、远程/LAN Satellite 或多房间。
- 不新增云供应商、账户、可计费资源、公开端口、录音文件、长期转写或长期记忆写入。
- 不把 openWakeWord、Porcupine 或任何模型的安装成功描述为实际房间准确率、功耗或隐私验证。

## 2. 用户场景与状态流

用户在本机前台界面或开发 CLI 明确启动本地监听；看到 `LOCAL_LISTENING` 后，麦克风帧只供本地检测器使用。唤醒命中后，Satellite 显示已唤醒但仍不连接 ASR；用户开始说话才打开既有会话。用户停顿到 VAD 结束条件后，后续流程沿用 VOICE-004 的 ASR → Gateway → 文本推理 → TTS → 本机播放。用户可在任意阶段显式停止，播放结束后仅回到已启用的本地监听，不保留同一会话的免手连续上下文。

~~~text
STOPPED
  └─ 用户显式开始本地监听 ─► LOCAL_LISTENING
LOCAL_LISTENING
  ├─ 本地唤醒命中 ─► AWAKE_LOCAL
  ├─ 用户停止 / 权限或设备失败 ─► STOPPED
  └─ 未命中 ─► LOCAL_LISTENING
AWAKE_LOCAL
  ├─ 本地 speech_started ─► ASR_STREAMING
  ├─ 无语音超时 / 误唤醒 ─► LOCAL_LISTENING
  └─ 用户停止 / 设备失败 ─► STOPPED
ASR_STREAMING
  ├─ 本地 speech_ended / 时长上限 ─► ROUTING
  └─ 超时 / 取消 / 提供方失败 ─► CLOSING
ROUTING / DEEP_REASONING / TTS_STREAMING / SPEAKING
  └─ 完成或显式手动打断 ─► CLOSING
CLOSING
  └─ 清理完成 ─► LOCAL_LISTENING（仍由用户启用）/ STOPPED
~~~

`AWAKE_LOCAL`、误唤醒和 VAD 等待都不能创建腾讯云连接。首轮不因为用户在播放时说话而自动转入 `ASR_STREAMING`；那是后续语音驱动打断规格的责任。

## 3. 模块边界与契约

| 模块 | 输入 | 输出 | 不负责什么 |
| --- | --- | --- | --- |
| Satellite 本地监听 | 显式启动、TCC 权限、默认输入、取消 | 有界本地 PCM 帧、`LOCAL_LISTENING` 状态 | 云端 ASR/TTS、长期录音、自动常驻 |
| `WakeDetector` | 仅本地 PCM 帧、取消 | `wake_detected` / 本地失败 | 联网、上传帧、写磁盘、Gateway 凭据 |
| `SpeechBoundaryDetector` | 唤醒后的本地 PCM 帧、取消 | `speech_started` / `speech_ended` / 本地失败 | 决定文本内容、调用 ASR、自动重试 |
| Satellite 协议 | 版本/能力、监听控制、本地状态、获准后 PCM、取消 | 有界事件流和安全错误 | 继承 stdout、任意 JSON、云端密钥、LAN 监听 |
| TypeScript Satellite 适配器 | 本地状态/获准 PCM | 仅在 `speech_started` 后创建/驱动 VOICE-001 | Core Audio、模型加载、检测分数解释 |
| VOICE-001/Gateway | 已激活且已开始说话后的 PCM、取消 | 既有 ASR → 路由 → TTS 会话结果 | 处理未唤醒帧、选择本地检测器、绕过 Satellite 权限 |

核心契约：

- SOL1 v1 手动采集消息不能被含糊扩展；实现必须以显式版本或能力协商区分本地监听、唤醒、语音开始、语音结束、停止和失败。
- `WakeDetector` 与 `SpeechBoundaryDetector` 必须可注入，测试可在不加载真实模型、不访问麦克风和不联网时驱动所有状态。
- 只有 `speech_started` 后的后续 PCM 可被交给 Gateway；不得把唤醒前、唤醒词或未开始说话的帧作为 ASR 预滚数据发送。
- 后台模型退出、未知事件、越界帧、设备变化、权限撤销或取消都必须停止本地监听、清空本地缓冲，并在联网前或继续处理前安全失败。

## 4. 数据、隐私与权限

- 本地检测器的滚动内存窗口必须有固定上限，并在唤醒失败、无语音超时、停止、设备变化、权限撤销和进程退出时立即清空；不得生成录音、缓存文件或模型调试转储。
- 唤醒前和唤醒词音频不得进入 Gateway、腾讯云、文本推理、指标、stderr 或数据库。Gateway 只可见脱敏的本地状态事件和唤醒后 `speech_started` 之后的 PCM。
- 首次进入 `LOCAL_LISTENING` 前按 macOS TCC 流程获得麦克风权限。拒绝、受限或撤销时不加载活跃监听、不创建 ASR 会话，并给出可观察的本地状态。
- 指标只允许监听启动/停止、唤醒/误唤醒计数、VAD 阶段、时长、帧/字节量、错误类别和取消后交付量；禁止序列化音频、检测分数、唤醒短语、完整/部分转写、设备名称、路径或凭据。
- 本规格不授权保留语音内容或新增记忆；任何未来用于模型评测的真实房间样本都必须单独说明来源、保存、删除和用户同意。

## 5. 提供方、成本与运行影响

- 腾讯云、文本推理与现有 `.env` 不变；本地唤醒/VAD 不得新增云端请求、遥测或账户。提供方价格、余额与单轮调用授权仍以现有 Provider 文档和 VOICE-003 的安全门为准。
- 误唤醒但未 `speech_started`、本地监听停止、权限/设备失败和 VAD 本地失败时，腾讯云 ASR 调用数必须为零。唤醒后实际说话才沿用既有单轮费用上限与无自动重试规则。
- openWakeWord 是首个离线评测候选，不是已验证的默认运行时；其模型、运行时、CPU/内存和许可必须在真实依赖安装前单独审计。若评测不达标，再评估 Porcupine，不自动切换。
- 本第一片只能作为用户启动的前台本机流程运行，不创建 LaunchAgent、容器、登录项或其他常驻系统服务；功耗、睡眠恢复和 24 小时稳定性留给后续运行保障规格。

## 6. 失败、取消与降级

| 情形 | 期望行为 | 用户可见反馈 | 审计/指标 |
| --- | --- | --- | --- |
| 麦克风权限拒绝/受限/撤销 | 停止本地监听，不创建 ASR | “需要麦克风权限” | `permission_denied` / `permission_restricted` |
| 本地模型缺失、加载或推理失败 | 停止监听，不替换未知引擎，不联网 | “本地唤醒不可用” | `wake_engine_error` |
| 误唤醒或唤醒后无语音 | 清空本地等待缓冲并回到监听 | “未检测到说话”或静默状态变化 | `false_wake` / `speech_start_timeout`，ASR 调用数 0 |
| VAD 失败、输入格式错误或缓冲上限 | 关闭当前本地输入和会话 | “无法处理本地语音” | `vad_error` / `capture_format_error` |
| 默认设备变化/断开 | 停止监听与当前轮，清空缓冲 | “音频设备已变化，请重试” | `device_changed`、清理完成 |
| 手动停止或手动打断 | 广播既有取消，停止监听/播放，丢弃后续数据 | “已停止” | `interrupted`、停止延迟、取消后交付量 |
| 腾讯云或文本提供方失败 | 沿用 VOICE-001/003 关闭语义；不得重新打开监听以掩盖失败 | 安全本地提示 | 既有阶段/错误码 |

所有路径必须回到 `LOCAL_LISTENING`（仅当用户仍显式启用）或 `STOPPED`；不得持续占用麦克风、自动重新联网或处理关闭后的本地/云端数据。

## 7. 验收标准

自动化与离线验收：

- [ ] 本地监听、唤醒、无语音、VAD 开始/结束、手动停止、设备失败和取消状态机有确定性替身测试。
- [ ] 任意未唤醒帧、唤醒词帧和无语音误唤醒都不会创建 VOICE-001/Gateway/ASR 工作；测试断言 ASR 调用数为零。
- [ ] `speech_started` 后才交付获准 PCM；VAD `speech_ended`、现有时长上限和取消均按一次会话关闭，且没有自动重试。
- [ ] 新协议/能力协商覆盖版本、未知能力、顺序、帧上限、进程退出和取消；拒绝载荷不进入日志。
- [ ] 日志/指标快照不含 PCM、检测分数、唤醒词、转写、设备名称、路径或凭据；本地滚动窗口可证明有界并在所有关闭路径清空。
- [ ] 现有 Node/Swift 检查继续通过；新增测试无需真实模型、麦克风、腾讯云凭据或联网。

真实 macOS 验收（每次云端调用须另获明确授权）：

- [ ] 用户启动前台本地监听后，真实唤醒词可触发一轮中文对话；仅在本地 VAD 检测到开始说话后才出现 ASR 调用。
- [ ] 未唤醒、误唤醒后无语音和本地监听停止时，安全指标与腾讯云控制台均证明零 ASR 调用/上传。
- [ ] 本地 VAD 能自动结束一次正常说话的输入，输出体验可理解；手动停止/打断仍优先且没有尾部音频或文本。
- [ ] 本轮日志、工作目录和 Git 状态证明没有录音、检测缓存、完整转写、回答或凭据文件；控制台用量符合单轮上限。
- [ ] 用户完成房间体验复核：可接受的唤醒/漏唤醒、误唤醒、截断、延迟与 CPU/内存表现。该项不等同于 AEC、远场或 24 小时常驻验收。

本规格达到 `implemented` 只表示本地激活边界、可替换检测器、离线测试和最小真实流程已落地；只有真实本机唤醒、零未唤醒调用、VAD 结束、取消和用户体验都有证据时，才可标记 `verified`。

## 8. 文档影响与实施前复核

- [x] 已阅读 [`../START-HERE.md`](../START-HERE.md)、[`../architecture.md`](../architecture.md)、[`../mvp-plan.md`](../mvp-plan.md)、[`../providers/tencent-cloud.md`](../providers/tencent-cloud.md)、[`../deployment/macos-orbstack.md`](../deployment/macos-orbstack.md)、[ADR-0001](../decisions/ADR-0001-first-mvp-boundary.md)、[ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[ADR-0003](../decisions/ADR-0003-mac-mini-orbstack-deployment.md)、[ADR-0004](../decisions/ADR-0004-documentation-driven-development.md)、[ADR-0005](../decisions/ADR-0005-native-macos-voice-satellite.md) 与 [VOICE-001](VOICE-001-development-voice-session-core.md)、[VOICE-002](VOICE-002-text-reasoner-readiness.md)、[VOICE-003](VOICE-003-tencent-realtime-voice-adapters.md)、[VOICE-004](VOICE-004-macos-voice-satellite.md)。
- [x] 新的本地激活、VAD、协议和引擎评测边界已由 ADR-0006 接受；Gateway、腾讯云、文本推理、部署和单房间无副作用边界保持不变。
- [x] 本规格是 T2：扩大本地麦克风状态机并改变何时允许云端 ASR，因此同时更新架构、路线图、功能目录与公开状态。
- [x] 用户已接受本第一片范围；真实模型依赖安装、真实监听和每次云端调用仍分别需要授权。
- [x] 本规格达到 `accepted`，可先实现不依赖真实模型/云端的协议、状态机与测试替身；实际唤醒引擎选择继续遵循 ADR-0006 的本地评测门。

## 9. 实现与验证证据（实现后填写）

| 项目 | 证据 |
| --- | --- |
| 实现路径 | 待实现 |
| 文档/ADR 更新 | 2026-08-20：新增本规格与 ADR-0006，并同步 START-HERE、架构、路线图、功能目录和 README；未修改 Provider、部署或运行配置 |
| 静态检查 | 待实现 |
| 自动化测试 | 待实现 |
| 本机进程运行验证 | 待实现 |
| 真实运行/人工验收 | 待取得明确授权后执行 |
| 已知限制或未验证假设 | 唤醒引擎真实准确率、模型运行时/许可、实际 VAD 阈值、CPU/内存、房间噪声和回声均未验证；AEC、降噪、语音驱动打断、免手连续会话和常驻恢复不在本第一片内 |

## 10. 复核记录

| 日期 | session / 变更 | 阅读和复核的文档 | 结论 |
| --- | --- | --- | --- |
| 2026-08-20 | 建立 VOICE-005 本地唤醒与自动 VAD 第一片 | START-HERE、功能模板、MVP、架构、Provider、Deployment、ADR-0001/2/3/4/5、VOICE-001/2/3/4 | `accepted`；可以开始离线的协议、状态机和测试替身实现。真实检测器依赖、监听和云端调用仍需独立授权，AEC/降噪/免手连续会话/常驻恢复不在本第一片内 |
