# 功能规格目录

这里存放 T1、T2、T3 功能或新模块的可实现规格。

当前规格：

- [VOICE-001：开发机语音会话编排核心](VOICE-001-development-voice-session-core.md)（`implemented`，待真实语音运行验收）
- [VOICE-002：文本深度推理适配器准备与探测](VOICE-002-text-reasoner-readiness.md)（`verified`，默认 `gpt-5.6-terra`）
- [VOICE-003：腾讯云实时 ASR/TTS 适配器与安全探测](VOICE-003-tencent-realtime-voice-adapters.md)（`verified`，自动化、真实成功/取消路径与控制台用量复核均通过）
- [VOICE-004：macOS Voice Satellite 本机音频闭环](VOICE-004-macos-voice-satellite.md)（`accepted`，等待实现手动激活的真实麦克风/扬声器闭环）

开始新功能时，从 [`../templates/feature-spec.md`](../templates/feature-spec.md) 创建 `docs/features/<feature>.md`；先完成并接受规格，再修改实现。完整流程和状态定义以 [`../../AGENTS.md`](../../AGENTS.md) 与 [`../START-HERE.md`](../START-HERE.md) 为准。
