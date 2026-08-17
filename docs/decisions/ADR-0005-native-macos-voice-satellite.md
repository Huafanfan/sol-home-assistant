# ADR-0005：首台 Voice Satellite 使用原生 macOS 音频宿主

## 状态

`accepted`

## 背景

[ADR-0003](ADR-0003-mac-mini-orbstack-deployment.md) 已决定首台 Voice Satellite 运行在 Mac mini 的 macOS 宿主机，不把实时音频硬件路径放进容器。现在需要进一步确定麦克风权限、设备变化、音频采集、格式转换、扬声器播放和立即停止应由什么运行时承担。

项目的 Gateway、会话核心与供应商适配器以 Node.js/TypeScript 实现并保持可迁移；但 macOS 音频权限、Core Audio 设备生命周期和低延迟播放属于平台边界。若直接依赖 Node 原生音频扩展，首版会同时承担第三方二进制兼容、Electron/Node ABI、TCC 权限归属和跨架构打包风险，也会把 Gateway 与 macOS 实现耦合。

VOICE-004 的目标只是验证当前 Mac mini 的手动激活单轮闭环。唤醒词、自动 VAD、AEC、降噪、远场体验、常驻恢复和多房间协议仍需后续独立决策。

## 决策

- 首台 Voice Satellite 使用 Swift 与 AVFoundation 实现为 macOS 宿主机进程；它负责麦克风权限、系统默认输入/输出设备、音频采集与转换、扬声器播放和本地立即停止。
- Voice Satellite 不进入 OrbStack，不持有腾讯云、文本推理、数据库或 Docker 凭据；Gateway 仍是建立会话和调用外部提供方的唯一入口。
- VOICE-004 由 TypeScript Gateway 启动 Swift 可执行文件作为受控子进程，使用专用 stdin/stdout 管道中的版本化二进制帧传递 16kHz、单声道、16-bit PCM 与控制事件。stdout 是协议通道，不得继承到终端、tee 到文件或作为日志解析；stderr 只允许脱敏文本诊断。首版不开放本机或家庭 LAN 监听端口；未来远程 Satellite 的认证 LAN 协议另行设计。
- Swift 侧只处理设备和音频边界，不复制 Gateway 状态机、ASR/TTS 签名、文本路由、记忆或工具权限逻辑。TypeScript 侧通过可替换的 Satellite 适配器使用该协议。
- VOICE-004 只提供显式本地手动开始、结束和打断。未激活时不创建 ASR 会话，不向 Gateway 交付麦克风帧；单次采集必须有硬上限且不会自动重新开始。
- 唤醒词、自动 VAD、语音驱动的免手打断、AEC/降噪与连续会话由后续 VOICE-005 或其他独立规格负责，不以临时实现静默进入 VOICE-004。
- 首版面向本机开发与人工验收，不把签名、发布、自动启动、24 小时恢复或 Linux Satellite 描述为已解决。

## 后果

- macOS 权限、设备切换和播放停止可以使用平台原生 API 验收，避免把低层音频生命周期塞入 Gateway。
- 仓库新增 Swift 构建与测试边界；macOS 专用测试必须与现有跨平台 TypeScript 检查分开报告，不能用 mock 结果替代真实硬件验收。
- 同机进程协议必须有版本、帧大小上限、取消语义和安全错误分类；专用 stdout 管道可以承载有界协议帧，但不得被记录，stderr/应用日志不得承载原始音频、完整转写或凭据。
- 未来 Linux/N100 或独立房间硬件需要实现同一高层 Satellite 契约，而不是复用 AVFoundation 代码。
- 原生宿主提高首台 Mac mini 的可靠性，但增加一种语言和平台构建工具；这是换取明确权限归属和可测试设备生命周期的接受成本。
