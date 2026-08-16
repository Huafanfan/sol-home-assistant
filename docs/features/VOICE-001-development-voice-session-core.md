# 功能规格：VOICE-001 开发机语音会话编排核心

> 本规格是单房间 MVP 的第一项实现工作。它先交付可替换适配器上的确定性会话编排与诊断闭环；真实麦克风、腾讯云 WebSocket 和本地唤醒引擎在相同契约上后续接入，不能被本规格中的模拟验证替代。

## 元数据

| 字段 | 内容 |
| --- | --- |
| 状态 | `implemented` |
| 变更等级 | `T2` |
| 创建日期 | 2026-08-16 |
| 最后文档复核 | 2026-08-16 |
| 设计依据 | 用户已授权开始第一项功能；MVP 路线图“开发机语音闭环” |
| 关联 ADR | [ADR-0001](../decisions/ADR-0001-first-mvp-boundary.md)、[ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[ADR-0003](../decisions/ADR-0003-mac-mini-orbstack-deployment.md)、[ADR-0004](../decisions/ADR-0004-documentation-driven-development.md) |
| 预计实现路径 | `packages/voice-session/src/`、`apps/voice-gateway/src/`、`apps/voice-demo/src/`、`test/voice-session.test.ts` 与根目录 TypeScript 工程配置 |
| 验收负责人 | Codex：静态与自动化证据；用户：凭据、真实音频与腾讯云运行验收 |

## 1. 目标与非目标

### 目标

- 提供一个运行时无关的语音会话编排核心，明确执行 `IDLE → AWAKE → ASR_STREAMING → ROUTING/DEEP_REASONING → TTS_STREAMING/SPEAKING → CLOSING → IDLE` 的合法转换。
- 用可替换的 ASR、文本推理、TTS 与播放适配器完成一次确定性的开发者诊断闭环；首个入口以本地手动触发模拟 `AWAKE`，便于在没有最终唤醒硬件和真实凭据时测试取消、超时与数据边界。
- 使“用户打断”成为跨 ASR、推理、TTS、播放的一等取消操作：一次打断必须停止当前活动工作，并使该会话回到可观察的关闭状态。
- 在接口层保证文本推理适配器只能收到最终转写和最小化的会话摘要；原始音频帧不能进入文本推理或日志接口。
- 记录仅含时长、计数、阶段和错误分类的会话指标，为后续真实腾讯云和声学评测提供统一测量点。

### 非目标

- 不在本功能中实现或宣称真实的 macOS 麦克风采集、扬声器播放、AEC、VAD 或唤醒词；手动触发是诊断入口，不是最终唤醒方案。
- 不在未完成官方接口核验和凭据配置前实现或宣称已验证的腾讯云实时 ASR/TTS WebSocket 调用。
- 不在本功能中持久化会话、原始转录或长期记忆，也不接入数据库、联网搜索、智能家居工具或任何写操作。
- 不把 CLIProxyAPI 或任何文本上游假定为支持音频、工具、联网搜索或特定模型；本功能只定义可取消的文本流契约和模拟实现。
- 不创建常驻容器、Docker Socket 挂载、数据库端口或家庭 LAN 对外服务。

## 2. 用户场景与状态流

开发者在 Mac mini 上启动诊断入口，以显式手动命令开始一轮会话。只有在这一步之后，模拟的“已获准音频帧”才可交给 ASR 适配器；ASR 给出最终转写后，Gateway 决定直接回答或调用文本推理，再把已批准的文本片段交给 TTS 与播放适配器。

开发者可在 ASR、推理、TTS 或播放阶段发出打断。系统必须取消活跃适配器、停止播放、记录脱敏取消指标，并关闭本轮会话；不能继续发送后续文本或音频。

~~~text
IDLE
  └─ 手动开始（后续可替换为本地唤醒） ─► AWAKE
AWAKE
  └─ 开始已获准音频流 ─► ASR_STREAMING
ASR_STREAMING
  ├─ 最终转写 ─► ROUTING
  ├─ 超时 / 取消 / 错误 ─► CLOSING
  └─ 部分转写 ─► ASR_STREAMING
ROUTING
  ├─ 直接文本 ─► TTS_STREAMING
  └─ 复杂请求 ─► DEEP_REASONING
DEEP_REASONING
  ├─ 文本片段 ─► TTS_STREAMING
  └─ 超时 / 取消 / 错误 ─► FALLBACK / CLOSING
TTS_STREAMING
  ├─ 音频片段 ─► SPEAKING
  ├─ 完成 ─► CLOSING
  └─ 取消 / 错误 ─► CLOSING
SPEAKING
  ├─ 打断 ─► CLOSING
  └─ 片段结束 ─► TTS_STREAMING / CLOSING
CLOSING
  └─ 清理短期状态与记录脱敏指标 ─► IDLE
~~~

本阶段不实现同一唤醒会话的连续多轮 `LISTENING`；每次诊断会话只覆盖一轮，避免在记忆和 VAD 设计未完成前隐式延长录音窗口。

## 3. 模块边界与契约

| 模块/外部系统 | 输入 | 输出 | 不负责什么 |
| --- | --- | --- | --- |
| `voice-session` 核心 | 明确的开始、音频帧、最终转写、取消和适配器事件 | 状态变化、取消信号、脱敏指标、批准给下一阶段的最小化数据 | 麦克风设备、网络凭据、持久化、业务工具 |
| `voice-demo` | 开发者手动开始/取消和确定性模拟适配器 | 可观察的阶段事件与本地演示结果 | 真实音频、云端调用、长期日志 |
| `voice-gateway` | 来自后续 Satellite 的已认证会话输入 | 对 ASR、文本推理、TTS 的唯一调用入口 | 直接操作 macOS 音频设备或保存卫星凭据 |
| ASR 适配器 | 仅已获准的当前轮音频帧、取消信号 | 部分/最终转写、脱敏错误分类 | 未唤醒音频、长期记忆、文本上游凭据 |
| Text Reasoner 适配器 | 最终转写、可选的最小化短期摘要、取消信号 | 文本流或结构化失败 | 原始音频、完整转录、完整长期记忆、腾讯云凭据 |
| TTS/播放适配器 | 已批准的回答文本片段、取消信号 | 音频片段/播放状态、脱敏错误分类 | 用户原始音频、记忆、文本上游凭据 |

核心接口必须使用显式的 `AbortSignal` 或等价取消令牌；所有异步适配器都必须监听同一会话的取消。接口禁止接收“任意上下文对象”或原始日志对象，避免把音频/完整转录意外传给文本推理。

在真实网络适配器出现前，`voice-demo` 的模拟实现必须是确定性的，不读取 `.env`、不发起网络请求，也不把模拟内容写入文件。

## 4. 数据、隐私与权限

- 本阶段的音频帧、转写和回答只存在于进程内、当前会话生命周期内；会话结束或取消后必须释放引用，不写入磁盘。
- 日志和指标只能记录会话 ID（随机且短期）、阶段、事件时间、延迟、计数、错误分类、取消原因和提供方名称；不得记录原始音频、完整转写、回答内容、API 密钥或完整记忆。
- `voice-demo` 不拥有腾讯云、文本推理或数据库凭据；真实凭据未来仅由 `voice-gateway` 在本机未提交配置中读取。
- 手动开始是开发者的显式本地授权；未开始状态不应创建 ASR 适配器或向任何适配器传递音频帧。
- 本功能不产生可检索或可长期保留的数据，因此不修改 Memory Policy。新增持久化或记忆行为时必须另建规格。

## 5. 提供方、成本与运行影响

- 首次实现只包含适配器契约和本地确定性模拟，零腾讯云/文本上游调用、零可变用量费用。
- 后续真实适配器必须由 `voice-gateway` 独占，并遵守 [`../providers/tencent-cloud.md`](../providers/tencent-cloud.md) 的配置、成本和指标要求；价格、引擎、音色、采样率和地区不得写死在核心代码中。
- 在真实文本上游接入前，Gateway 必须先探测模型、流式、超时和取消能力。探测结论与真实调用验收应记录在后续功能规格的证据中。
- 本功能不新增 Docker 服务或端口。Gateway 的工程入口可以在本机以开发模式运行，但不应宣称已满足 OrbStack 常驻、重启恢复或 LAN 认证验收。

## 6. 失败、取消与降级

| 情形 | 期望行为 | 用户可见反馈 | 审计/指标 |
| --- | --- | --- | --- |
| ASR 超时或错误 | 停止该轮、不调用文本推理或 TTS、进入 `CLOSING` | 本地短提示或结构化诊断错误 | `asr_timeout` / `asr_error`、时长、会话阶段 |
| 文本推理超时或错误 | 取消未完成工作，不阻塞关闭；可选本地短提示 | “当前无法生成回答” | `reasoner_timeout` / `reasoner_error`、首字节是否到达 |
| TTS 或播放错误 | 停止当前输出、进入 `CLOSING`，不重试循环 | “语音输出暂不可用” | `tts_error` / `playback_error`、已输出片段数 |
| 用户打断 | 广播同一取消信号、停止播放和所有活跃适配器、丢弃后续输出 | 明确的“已停止”阶段事件 | `interrupted`、触发时所在阶段、清理是否完成 |
| 在 `IDLE` 传入音频 | 拒绝，不创建网络/ASR 工作 | 仅开发者诊断错误 | `audio_before_activation` |

任何错误、超时或取消都不能启动无限重试、持续录音或在 `CLOSING` 后继续发送文本/音频。

## 7. 验收标准

自动化验收（本功能完成前必须通过）：

- [x] 确定性模拟闭环从手动开始进入 `ASR_STREAMING`，收到最终转写后按路由进入文本/TTS，最终回到 `IDLE`。
- [x] 在 `IDLE` 交付音频帧被拒绝，且 ASR 适配器未被调用。
- [x] 文本推理适配器的输入只含最终转写与最小化摘要；测试能证明原始音频帧不在其请求对象中。
- [x] 在 ASR、推理、TTS、播放的每个阶段打断，会取消活跃任务、停止播放，且不会处理后续输出。
- [x] Gateway 的 ASR、路由、推理、TTS 与播放均有分阶段超时；任一适配器的超时/错误都会广播取消、关闭会话，不产生无限重试，也不进入下一外部阶段。
- [x] 指标测试确认日志载荷不含原始音频、完整转写、回答文本、密钥字段或长期记忆字段。
- [x] TypeScript 编译、静态检查和测试命令在无腾讯云/文本上游凭据环境中运行。

真实运行验收（本规格不会提前宣称通过）：

- [ ] 配置腾讯云凭据并通过官方接口核验后，手动触发的一轮中文音频可完成 ASR → 文本 → TTS → 本地播放。
- [ ] 真实麦克风、扬声器、腾讯云和文本上游条件下，打断可停止播放与未完成的云端工作。
- [ ] 在真实控制台确认后付费、资源包/余额告警与本轮费用上限后，记录 ASR/TTS 用量和延迟。

## 8. 文档影响与实施前复核

- [x] 已阅读 [`../START-HERE.md`](../START-HERE.md)。
- [x] 已阅读 [`../architecture.md`](../architecture.md)、[`../mvp-plan.md`](../mvp-plan.md)、[ADR-0001](../decisions/ADR-0001-first-mvp-boundary.md)、[ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[ADR-0003](../decisions/ADR-0003-mac-mini-orbstack-deployment.md)、[ADR-0004](../decisions/ADR-0004-documentation-driven-development.md)、[`../providers/tencent-cloud.md`](../providers/tencent-cloud.md) 与 [`../deployment/macos-orbstack.md`](../deployment/macos-orbstack.md)。
- [x] 与现有文档无冲突：本规格不改变已接受的腾讯云、Mac mini 或隐私边界；因此关联既有 ADR，而不新增 ADR。
- [x] 核心行为事实由本规格维护；稳定的系统边界、提供方成本和部署要求只以链接引用。
- [x] 本规格已达到 `accepted`，可以开始实现。

## 9. 实现与验证证据（实现后填写）

| 项目 | 证据 |
| --- | --- |
| 实现路径 | `packages/voice-session/src/` 的状态机、分阶段超时/取消、内存音频队列、脱敏指标与确定性适配器；`apps/voice-gateway/src/` 的 Gateway 组合根；`apps/voice-demo/src/main.ts`；`test/voice-session.test.ts` |
| 文档/ADR 更新 | 本规格、`docs/START-HERE.md`、`docs/features/README.md`、`README.md`；不改变 ADR-0001/2/3 的既有决定 |
| 静态检查 | `npm run typecheck` 通过（2026-08-16） |
| 自动化测试 | `npm run check` 通过：9/9 Node 原生测试（2026-08-16） |
| 真实运行/人工验收 | `npm run demo` 已完成离线确定性诊断（`completed` / `IDLE`）；尚未进行腾讯云、文本上游、麦克风或扬声器真实验证 |
| 已知限制或未验证假设 | 真实腾讯云协议、文本上游流式/取消能力、音频设备、VAD/AEC/唤醒词均未验证 |

## 10. 复核记录

| 日期 | session / 变更 | 阅读和复核的文档 | 结论 |
| --- | --- | --- | --- |
| 2026-08-16 | 首次建立 VOICE-001 | `AGENTS.md`、START-HERE、架构、MVP、ADR-0001/2/3/4、腾讯云与部署文档 | `accepted`；先交付确定性会话编排核心，再做真实提供方/音频验收 |
| 2026-08-16 | 会话编排核心实现 | 本规格及其关联架构/ADR | `implemented`；自动化与离线诊断通过，真实语音验收仍未开始 |
