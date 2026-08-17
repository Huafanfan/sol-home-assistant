# 功能规格：VOICE-004 macOS Voice Satellite 本机音频闭环

> 本规格把已验证的 VOICE-001 会话核心、VOICE-002 文本推理和 VOICE-003 腾讯云语音适配器接到 Mac mini 的真实麦克风与扬声器。首轮只做显式手动激活的一次真人对话与手动打断；唤醒词、自动 VAD、AEC 和免手连续对话留给后续规格。

## 元数据

| 字段 | 内容 |
| --- | --- |
| 状态 | `accepted` |
| 变更等级 | `T2` |
| 创建日期 | 2026-08-17 |
| 最后文档复核 | 2026-08-17 |
| 设计依据 | 用户确认首套麦克风/扬声器使用本机设备，并接受先完成手动激活闭环、再由 VOICE-005 处理唤醒/VAD/AEC 的拆分 |
| 关联 ADR | [ADR-0001](../decisions/ADR-0001-first-mvp-boundary.md)、[ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[ADR-0003](../decisions/ADR-0003-mac-mini-orbstack-deployment.md)、[ADR-0004](../decisions/ADR-0004-documentation-driven-development.md)、[ADR-0005](../decisions/ADR-0005-native-macos-voice-satellite.md) |
| 预计实现路径 | `apps/voice-satellite-macos/`（Swift/AVFoundation 宿主、单元测试与开发运行入口）、`apps/voice-gateway/src/satellite/`（本机进程协议适配）、相关 TypeScript 集成测试与根目录脚本 |
| 验收负责人 | Codex：实现、静态检查、mock/集成测试和安全诊断；用户：macOS 麦克风授权、真实设备选择、真人单轮对话、播放与手动打断体验验收 |

## 1. 目标与非目标

### 目标

- 建立一个运行于 macOS 宿主机的原生 Voice Satellite，使用 Swift/AVFoundation 访问系统默认麦克风与扬声器，不把音频设备放入 OrbStack。
- 通过显式本地控制开始一轮采集，把输入转换为 VOICE-003 已接受的 16kHz、单声道、16-bit PCM，并只在已激活会话中交给 Gateway。
- 从 Gateway 接收 VOICE-003 产生的 PCM 音频并立即播放；用户手动打断时停止本地播放，同时触发 VOICE-001 的共享取消语义。
- 处理麦克风权限允许/拒绝、无可用设备、默认设备变化、设备断开、格式不支持、采集/播放失败和进程退出，不允许持续录音或卡死会话。
- 由 Gateway 启动 Swift 子进程，并用专用 stdin/stdout 管道中的版本化、限长、可取消二进制帧隔离 Swift 音频边界和 TypeScript Gateway；原始音频仅在当前会话内存中短暂存在。
- 记录脱敏的权限状态、设备可用性、采集/播放启动延迟、PCM 帧/字节/时长、缓冲欠载、打断阶段与清理完成状态，不记录设备名称、原始音频、完整转写或回答正文。

### 非目标

- 不实现“Hi Sol”唤醒词、自动 VAD、免手连续对话、语音驱动的自然打断、AEC、降噪或远场麦克风优化；这些由 VOICE-005 或后续声学规格负责。
- 不实现自定义音频设备选择 UI；首版使用当前系统默认输入/输出设备，并正确响应默认设备变化或断开。
- 不实现多房间、LAN Satellite 发现/认证、独立硬件选型或 N100/Linux 音频进程。
- 不创建常驻 LaunchAgent、开机启动、自动登录、睡眠/断电恢复、安装包、公证或生产服务等级承诺。
- 不改变腾讯云 ASR/TTS、文本推理、会话状态机、记忆或工具权限决定，也不在 Satellite 中复制任何云端凭据。
- 不保存录音、完整转写、完整回答或可还原用户内容的调试文件；不以录音文件作为默认测试夹具提交到仓库。

## 2. 用户场景与状态流

开发者启动 Gateway，Gateway 再启动本机 Swift Voice Satellite 子进程。首次访问麦克风时，macOS 显示系统权限请求；用户拒绝时应用保持可退出、可重试的本地错误状态，且不得建立 ASR 会话。权限允许后，Satellite 等待显式本地“开始”操作，不在后台持续采集。

~~~text
SATELLITE_STOPPED
  └─ 启动 ─► PERMISSION_CHECK

PERMISSION_CHECK
  ├─ 拒绝/受限 ─► PERMISSION_BLOCKED ─► STOPPED
  └─ 允许 ─► READY

READY
  ├─ 手动开始 ─► CAPTURING
  └─ 退出 ─► STOPPED

CAPTURING
  ├─ 16k mono PCM ─► Gateway / VOICE-001 ASR_STREAMING
  ├─ 手动结束 ─► WAITING_RESPONSE
  ├─ 达到单轮硬上限 ─► WAITING_RESPONSE
  └─ 取消/设备错误 ─► CLOSING

WAITING_RESPONSE
  ├─ TTS PCM ─► PLAYING
  └─ 错误/取消 ─► CLOSING

PLAYING
  ├─ 音频完成 ─► CLOSING
  └─ 手动打断 ─► INTERRUPTING ─► CLOSING

CLOSING
  └─ 麦克风停止、播放停止、缓冲释放、Gateway 会话关闭 ─► READY
~~~

VOICE-004 的“打断”是显式本地按钮或命令，不依赖麦克风在扬声器播放时识别用户语音。一次手动采集默认不超过 15 秒，硬上限为 30 秒；达到上限只结束当前输入，不自动开始下一轮。

## 3. 模块边界与契约

| 模块 | 输入 | 输出 | 不负责什么 |
| --- | --- | --- | --- |
| macOS 权限/设备层 | 显式启动、系统 TCC 与默认设备事件 | 允许/拒绝/受限状态，设备可用/变化事件 | 修改系统隐私设置、保存设备名称、静默选择其他设备 |
| `AudioCapture` | 已激活状态、取消信号、系统输入流 | 有界 16k mono int16 PCM 帧与安全计数 | 唤醒、VAD、ASR、录音落盘 |
| `AudioPlayback` | Gateway 提供的 16k mono int16 PCM、取消信号 | 播放完成/失败/中断与安全计数 | TTS、回答文本、持续缓存 |
| 本机 Satellite 协议 | 专用 stdin/stdout 管道中的版本、会话控制、PCM 帧、播放/取消事件 | 有界双向事件流与协议错误；stderr 脱敏诊断 | 任意 JSON 上下文、云凭据、LAN 服务发现、把 stdout 继承/记录为日志 |
| TypeScript Satellite 适配器 | Swift 进程事件与 PCM | VOICE-001 的开始、音频帧、结束、播放和打断调用 | macOS 设备 API、TCC、供应商签名 |
| Voice Gateway / VOICE-001 | 已激活 PCM、取消与播放状态 | ASR→路由→TTS 会话结果和统一关闭 | 直接打开麦克风/扬声器、拥有 Swift 设备对象 |

核心契约：

- 协议必须带显式版本；未知版本、未知消息、越界帧或顺序错误在联网前/继续处理前安全失败。
- 音频帧必须有固定格式标识和最大长度；控制消息与二进制音频分离，日志只记录类型、长度和时序。
- Swift 进程与 Gateway 必须共享当前会话的取消边界。任一侧退出、权限撤销或设备失败都关闭当前会话并释放缓冲，不自动重连或重新录音。
- VOICE-004 首版由 Gateway 管理 Swift 子进程生命周期，只使用专用 stdin/stdout 管道，不创建本机或家庭 LAN 监听端口；未来远程协议不得直接复用未认证的开发传输。
- 为避免真实硬件成为唯一测试入口，权限、设备、采集、播放、时钟和本机传输都必须有可注入的测试替身。

## 4. 数据、隐私与权限

- 未手动激活时不得创建 ASR 会话、向 Gateway 发送 PCM 或保留可回放音频；仅可观察不含内容的设备可用状态。
- 麦克风权限只能通过 macOS 系统授权流程取得；应用不得自动打开系统设置、模拟点击或把拒绝解释为允许。
- Voice Satellite 不读取 `.env` 中的腾讯云或文本提供方凭据；除本机协议启动所需的短时信息外，不接收 Gateway 的配置对象。
- 原始 PCM 只存在于当前会话的有界内存缓冲；正常完成、打断、超时、设备错误或进程退出后都必须释放，不写入磁盘、日志、崩溃报告附件或测试快照。
- stdout 专用于二进制协议且不得被继承、tee 或持久化；stderr 和应用日志不得包含 PCM、完整转写、回答文本、设备名称、用户名、文件路径、完整协议载荷或可重放令牌。
- 手动开始、结束和打断必须有明确的本地可见状态；用户不得在不知情的情况下持续被录音。

## 5. 提供方、成本与运行影响

- VOICE-004 不新增云供应商；真实会话继续使用已验证的 VOICE-002/003 配置与成本护栏。
- 每次真实硬件验收仍需显式授权；单轮输入默认不超过 15 秒、硬上限 30 秒，不自动重试、不自动开始下一轮。
- 手动激活后才允许建立腾讯云 ASR；播放失败不得重新请求 TTS。测试前后由安全指标和控制台用量分别核对本轮 ASR/TTS 调用。
- Swift/AVFoundation 进程运行于 macOS 宿主机；不创建 Docker 镜像、公开端口、LaunchAgent 或持久化守护进程。
- 新增 Swift/Xcode 构建依赖属于本机开发边界；实现前先使用已安装工具链，不自动安装额外音频驱动、虚拟声卡或系统扩展。

## 6. 失败、取消与降级

| 情形 | 期望行为 | 用户可见反馈 | 审计/指标 |
| --- | --- | --- | --- |
| 麦克风权限拒绝/受限 | 不打开输入、不建立 ASR；保持可退出/重试 | “需要麦克风权限” | `permission_denied` / `permission_restricted` |
| 无输入或输出设备 | 不开始或立即停止当前轮 | “音频设备不可用” | `device_unavailable`、阶段 |
| 默认设备变化/断开 | 停止当前轮并释放旧设备；不静默继续到未知设备 | “音频设备已变化，请重试” | `device_changed`、清理完成 |
| 输入格式/转换失败 | 不发送错误格式 PCM，关闭会话 | “无法处理麦克风音频” | `capture_format_error` |
| 本机协议错误/进程退出 | Gateway 取消当前会话，不解释任意载荷 | “本机语音组件不可用” | `satellite_protocol_error` / `satellite_exited` |
| 播放失败/缓冲欠载 | 停止播放和当前会话，不重新请求 TTS | “语音播放失败” | `playback_error` / `underrun_count` |
| 手动打断 | 停止播放、广播 Gateway 取消、丢弃后续 PCM/TTS | 明确显示“已停止” | `interrupted`、停止延迟、取消后交付量 |
| 输入超时/达到上限 | 停止采集并结束当前输入，不自动重新录音 | “本轮输入已结束” | `capture_limit_reached`、音频时长 |

所有失败都必须回到可观察的 `READY` 或 `STOPPED`，不得无限重启音频引擎、自动重连云服务、持续占用麦克风或处理会话关闭后的音频。

## 7. 验收标准

自动化与离线验收：

- [ ] Swift 权限状态机覆盖未决定、允许、拒绝、受限；拒绝/受限路径不启动捕获、不创建 Gateway/ASR 工作。
- [ ] 输入格式转换把常见设备采样率安全转换为 16kHz、单声道、16-bit PCM；帧长度、累计时长和硬上限均有确定性测试。
- [ ] mock 设备覆盖默认设备变化、断开、无设备、采集失败、播放失败和缓冲欠载；所有路径释放设备和有界缓冲。
- [ ] 本机协议测试覆盖版本、消息顺序、帧上限、进程退出和取消；未知或越界输入安全失败且不记录载荷。
- [ ] TypeScript 集成测试证明未激活音频不会进入 VOICE-001，手动结束会完成一轮，手动打断会停止播放与外部适配器且取消后零交付。
- [ ] 报告/日志快照不含 PCM、完整转写、回答、设备名称、凭据、完整路径或协议正文。
- [ ] 现有 `npm run check` 继续通过；新增 Swift 静态检查/单元测试和本机协议集成检查分别通过，且不要求真实云凭据。

真实 macOS 硬件验收（必须另行获得真实调用授权）：

- [ ] 首次运行能通过 macOS 系统流程获得麦克风权限；拒绝时不联网，允许后状态清晰可见。
- [ ] 使用系统默认麦克风手动说一句中文，完成麦克风→ASR→Gateway/文本推理→TTS→本机扬声器的一轮真实闭环。
- [ ] 未手动开始时，安全指标和腾讯云控制台均证明没有 ASR 调用或上传音频。
- [ ] 播放回答时执行本地手动打断，扬声器及时停止，Gateway/ASR/TTS 取消，取消后无音频或文本继续交付。
- [ ] 切换或断开默认设备时当前轮安全停止；恢复设备后可由用户手动开始新一轮，不需重启整套服务。
- [ ] 本轮日志、工作目录和 Git 状态证明没有生成录音、完整转写、回答或凭据文件；控制台用量符合单轮上限。
- [ ] 用户完成主观验收：音量可听清、无明显爆音/严重卡顿，开始/结束/打断状态可理解。

本规格达到 `implemented` 只表示代码与离线自动化完成；只有真实麦克风、扬声器、云端链路、打断和人工体验均有证据时，才可标记 `verified`。即使 `verified`，也不代表唤醒、VAD、AEC、连续对话、远场声学或 24 小时常驻已完成。

## 8. 文档影响与实施前复核

- [x] 已阅读 [`../START-HERE.md`](../START-HERE.md)。
- [x] 已阅读 [`../architecture.md`](../architecture.md)、[`../mvp-plan.md`](../mvp-plan.md)、[ADR-0001](../decisions/ADR-0001-first-mvp-boundary.md)、[ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[ADR-0003](../decisions/ADR-0003-mac-mini-orbstack-deployment.md)、[ADR-0004](../decisions/ADR-0004-documentation-driven-development.md)、[ADR-0005](../decisions/ADR-0005-native-macos-voice-satellite.md)、[VOICE-001](VOICE-001-development-voice-session-core.md)、[VOICE-002](VOICE-002-text-reasoner-readiness.md)、[VOICE-003](VOICE-003-tencent-realtime-voice-adapters.md)、[`../providers/tencent-cloud.md`](../providers/tencent-cloud.md) 与 [`../deployment/macos-orbstack.md`](../deployment/macos-orbstack.md)。
- [x] 新的架构选择已由 ADR-0005 接受：Swift/AVFoundation 只承担 macOS 音频宿主职责，Gateway 与提供方边界不变。
- [x] 与现有文档无冲突：本规格实现 ADR-0003 已接受的宿主机 Satellite，并保持 ADR-0001 的未激活音频边界和 VOICE-001 的统一取消语义。
- [x] 本规格拥有本机音频、手动激活/打断和硬件验收事实；唤醒/VAD/AEC、远程 Satellite 与常驻恢复由后续规格负责。
- [x] 本规格达到 `accepted`，可以在后续 session 开始实现；本次只提交文档，不创建实现文件或运行真实音频。

## 9. 实现与验证证据（实现后填写）

| 项目 | 证据 |
| --- | --- |
| 实现路径 | 尚未实现；预计为 `apps/voice-satellite-macos/`、`apps/voice-gateway/src/satellite/`、相关测试与根目录脚本 |
| 文档/ADR 更新 | 本规格、ADR-0005、`docs/START-HERE.md`、`docs/features/README.md`、`docs/architecture.md` 与 `README.md` |
| 静态检查 | 尚未运行实现检查；本次为仅文档提交 |
| 自动化测试 | 尚未新增；现有代码未修改 |
| 真实运行/人工验收 | 尚未执行；等待后续实现、macOS 权限和独立真实调用授权 |
| 已知限制或未验证假设 | Swift/AVFoundation 工具链、TCC 权限归属、本机进程协议、设备格式转换、播放延迟和真实打断体验均需在实现阶段验证 |

## 10. 复核记录

| 日期 | session / 变更 | 阅读和复核的文档 | 结论 |
| --- | --- | --- | --- |
| 2026-08-17 | 建立 VOICE-004 与原生 macOS Satellite 决策 | START-HERE、架构、MVP、ADR-0001/2/3/4、VOICE-001/002/003、腾讯云 Provider、macOS 部署文档与功能模板 | `accepted`；下一 session 可在此规格边界内实现手动激活的真实本机音频闭环，唤醒/VAD/AEC 明确留给 VOICE-005 |
