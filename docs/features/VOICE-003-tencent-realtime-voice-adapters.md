# 功能规格：VOICE-003 腾讯云实时 ASR/TTS 适配器与安全探测

> 本规格把已经接受的腾讯云语音边界落成可替换的实时 ASR/TTS 适配器，并先用固定、非私人内容完成协议与取消验证。真实麦克风、扬声器、唤醒、VAD 和声学体验由后续功能验收，不得用本规格中的云端探测替代。

## 元数据

| 字段 | 内容 |
| --- | --- |
| 状态 | `implemented` |
| 变更等级 | `T2` |
| 创建日期 | 2026-08-17 |
| 最后文档复核 | 2026-08-17 |
| 设计依据 | 用户已确认使用本机麦克风/扬声器，已开通腾讯云 ASR/TTS、领取 TTS 免费包并准备专用凭据；[ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md) 已接受腾讯云实时语音层 |
| 关联 ADR | [ADR-0001](../decisions/ADR-0001-first-mvp-boundary.md)、[ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[ADR-0003](../decisions/ADR-0003-mac-mini-orbstack-deployment.md)、[ADR-0004](../decisions/ADR-0004-documentation-driven-development.md) |
| 预计实现路径 | `packages/tencent-voice/src/`、`apps/voice-gateway/src/config/tencent-voice.ts`、`scripts/probe-tencent-voice.ts`、`test/tencent-voice.test.ts`、根目录 TypeScript/脚本配置 |
| 验收负责人 | Codex：设计、静态检查、mock 与安全探测实现；用户：新密钥安全落盘、计费边界确认、真实调用授权和后续本机音频体验验收 |

## 1. 目标与非目标

### 目标

- 为腾讯云实时 ASR 与实时 TTS WebSocket 提供类型化、可取消、可超时的适配器，实现 VOICE-001 的 `AsrAdapter` 与 `TtsAdapter` 契约。
- 从 Voice Gateway 独占的本机配置读取 `AppID`、子账号 `SecretId`/`SecretKey`、ASR profile 与 TTS `VoiceType`；配置、日志和错误不得暴露凭据、签名、完整请求 URL 或内容正文。
- 把内部 `standard` ASR profile 映射为部署时选择的 16k 中文标准识别参数；VoiceType 必须来自配置，不在代码中写死。
- 以固定短中文文本和由本轮 TTS 生成的临时 PCM 音频完成受控协议探测，验证 TTS 音频流、ASR 部分/最终结果、超时、错误分类与本地取消。
- 记录仅含阶段、延迟、音频秒数、合成字符数、提供方错误分类和完成/取消状态的安全报告。
- 使真实探测成为显式、有限、默认不执行的操作；没有独立的真实调用授权时，只运行配置检查、mock 和离线测试。

### 非目标

- 不实现 macOS 麦克风采集、扬声器播放、音频设备选择、系统权限、VAD、AEC、唤醒词或连续对话；这些属于后续本机 Voice Satellite 规格。
- 不把腾讯云凭据下发给 Voice Satellite、浏览器、客户端或文本推理提供方。
- 不保存原始音频、完整 ASR 转写、完整 TTS 文本或合成音频；受控 Probe 的临时缓冲只存在于当前进程内，结束后释放。
- 不实现声音复刻、说话人分离、实时翻译、离线 SDK、热词/自学习模型管理或购买资源包。
- 不创建 Dockerfile、Compose 服务、公开端口或常驻进程，也不宣称已满足 Mac mini 24 小时运行验收。
- 不在本功能中完成真人语音质量、噪声、回声、打断体验或家庭房间声学评测。

## 2. 用户场景与状态流

开发者先运行离线检查；只有在用户明确授权一次真实调用、确认当前计费边界并提供新生成的安全凭据后，才运行受控 Probe。Probe 使用固定短文本生成 PCM，再把该临时 PCM 送入实时 ASR，从而隔离麦克风、扬声器和私人语音变量。

~~~text
LOCAL .env（0600、Git 忽略、Gateway 独占）
  │
  ▼
CONFIG_VALIDATED ─► SIGNING_SELF_CHECK ─► MOCK_CONTRACTS_OK
                                               │
                            显式真实调用授权 + 计费确认
                                               │
                                               ▼
                                     TTS_WS_CONNECTING
                                               │
                                     固定短文本（非私人）
                                               │
                                               ▼
                                     TTS_AUDIO_STREAMED
                                               │
                                     临时 16k PCM（仅内存）
                                               │
                                               ▼
                                     ASR_WS_CONNECTING
                                               │
                                               ▼
                                  ASR_PARTIAL / ASR_FINAL
                                               │
                         ┌─────────────────────┴────────────────────┐
                         ▼                                          ▼
                  SAFE_PROBE_REPORT                         SAFE_FAILURE_REPORT
                         │                                          │
                         └─────────────────────┬────────────────────┘
                                               ▼
                                   BUFFERS_RELEASED / CLOSED
~~~

取消测试使用独立、受限的连接，不复用已经完成的 Probe 会话。客户端观察到取消和后续数据被丢弃，只能证明本地终止边界；除非腾讯云提供独立证据，不得宣称服务端已经停止计费或生成。

## 3. 模块边界与契约

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `packages/tencent-voice/config` | 校验并归一化 AppID、SecretId/SecretKey、ASR profile、VoiceType 和超时 | 输出配置值、长度、指纹或读取其他提供方凭据 |
| `packages/tencent-voice/signing` | 按腾讯云实时 WebSocket 规范生成短时签名与请求参数 | 持久化签名、记录完整 URL、接受任意域名 |
| `packages/tencent-voice/asr` | 打开官方 ASR WebSocket、节流发送 PCM、解析部分/最终结果、响应取消 | 录音、VAD、长期保存转写、自动重试循环 |
| `packages/tencent-voice/tts` | 打开官方 TTS WebSocket、发送获准文本、流式产出 PCM、响应取消 | 播放声音、选择系统设备、声音复刻 |
| `apps/voice-gateway/config` | 组合腾讯云适配器并注入 VOICE-001 | 将凭据或签名传给 Satellite/文本上游 |
| `scripts/probe-tencent-voice.ts` | 执行离线检查或受控真实 Probe，输出脱敏结果 | 默认联网、打印正文、长期保存音频、代表生产验收 |

核心约束：

- 只允许腾讯云官方实时 ASR/TTS 主机；端点不从未经校验的环境变量注入，避免凭据被发送到任意地址。
- 配置错误使用稳定的本地错误码；提供方响应映射为 `auth`、`quota_or_billing`、`rate_limited`、`invalid_request`、`timeout`、`cancelled`、`provider_unavailable` 和 `protocol_error`。
- ASR 输入为 VOICE-001 已授权阶段提供的 16kHz、单声道、16-bit PCM 帧；TTS 输出为相同 PCM 基线，便于后续本机播放与 Probe 回送。
- ASR 适配器可向诊断层报告部分结果，但只把最终结果交给 VOICE-001 的文本路由。
- TTS 的 `VoiceType` 是正整数配置；没有配置时安全失败，不偷偷选择其他音色。
- 首版不自动重试。未来若加入重试，必须单独规定幂等、费用上限、退避和取消语义。

## 4. 数据、隐私与权限

- 腾讯云凭据只存在于被 Git 忽略且权限为 0600 的本机 `.env` 或未来独立密钥管理器；`.env.example` 永远只保留空占位。
- 使用专用 CAM 编程子账号；不使用主账号长期密钥，不授予管理员、财务、CAM 或无关云产品权限。
- `SecretKey`、签名和包含鉴权查询参数的完整 WebSocket URL 均按秘密处理；错误对象、调试日志、测试快照和 Probe 报告不得包含这些内容。
- Probe 固定文本不含用户姓名、地址、真实会话、长期记忆或工具数据；临时音频不写入磁盘。
- 正式会话仍遵守“未唤醒音频不离开设备”。VOICE-003 的 Probe 是开发者显式触发的独立诊断，不改变正式唤醒边界。
- 原始音频、完整转写和完整回答默认不保留；只记录 [`../providers/tencent-cloud.md`](../providers/tencent-cloud.md) 定义的脱敏指标。
- 任何曾出现在受跟踪文件、聊天、日志或导出文件中的密钥都必须先禁用并轮换，不能用于真实 Probe。

## 5. 提供方、成本与运行影响

- 提供方、价格快照、免费额度和成本原则以 [`../providers/tencent-cloud.md`](../providers/tencent-cloud.md) 为事实来源；代码不得写死价格或假定免费额度仍有效。
- 用户已确认 ASR/TTS 服务开通和 TTS 免费包领取；这只证明控制台准备，不证明凭据、接口、配额、延迟或音色可用。
- 每次真实 Probe 前必须确认后付费状态或“额度耗尽即停”策略，并取得用户对本轮调用的明确授权。
- 单次标准 Probe 的默认上限：固定短文本不超过 20 个中文字符、生成/识别音频不超过 10 秒、每种能力一次成功路径；取消路径分别最多再建立一次连接。超限立即取消，不自动重试。
- Probe 只输出调用次数、合成字符数、音频秒数和脱敏延迟；不得把免费包或成功调用等同于无费用。
- 本功能仅创建可按需运行的本机代码和脚本，不创建常驻云资源、容器或公开网络监听。

## 6. 失败、取消与降级

| 情形 | 期望行为 | 用户可见反馈 | 审计/指标 |
| --- | --- | --- | --- |
| 配置缺失或格式错误 | 联网前拒绝；不显示值、长度或指纹 | 安全配置错误与缺失字段名 | `config_invalid` |
| 密钥无效或权限不足 | 关闭连接，不回显签名/URL，不尝试主账号或其他密钥 | “腾讯云鉴权失败” | `auth`、阶段、耗时 |
| 免费额度/余额/计费不可用 | 停止本轮，不重试或自动购买 | “额度或计费不可用” | `quota_or_billing` |
| WebSocket 握手或协议异常 | 关闭连接与缓冲，不进入下一外部阶段 | 脱敏协议错误 | `protocol_error` / `provider_unavailable` |
| ASR/TTS 超时 | 广播取消，关闭连接，释放临时 PCM | “语音服务超时” | `timeout`、阶段、已发送/接收量 |
| 用户取消 | 立即关闭本地流，丢弃取消后的帧/文本/音频 | “已停止” | `cancelled`、阶段、清理完成 |
| ASR 未返回最终结果 | 不调用文本路由或后续 TTS；安全关闭 | “未获得有效识别结果” | `asr_no_final` |
| TTS 无音频或过早结束 | 不进入播放或 ASR 回送；安全关闭 | “未获得有效语音输出” | `tts_no_audio` |

任何失败均不得触发无限重连、切换未知引擎/音色、持续发送音频或在会话关闭后处理提供方数据。

## 7. 验收标准

自动化验收：

- [x] 配置校验拒绝缺失/空白凭据、非数字 AppID、未知 ASR profile、非正整数 VoiceType 和越界超时；错误不含配置值、长度或指纹。
- [x] 签名测试使用固定时钟/随机数验证规范化、排序、编码与签名结果，同时证明日志/错误不含 SecretId、SecretKey、Signature 或完整 URL。
- [x] mock ASR 覆盖握手、PCM 节流、部分/最终结果、无最终结果、协议错误、超时和 `AbortSignal`；只有最终结果进入 VOICE-001。
- [x] mock TTS 覆盖签名握手、WebSocket 打开、音频块、`final=1` 完成、空音频、提供方错误、超时和 `AbortSignal`；取消后没有音频进入播放或 Probe 回送。
- [x] 适配器可被 Voice Gateway 注入 VOICE-001，ASR/TTS 任一失败都遵守既有关闭语义且不自动重试。
- [x] Probe 默认只做离线配置/签名自检；没有显式真实调用确认参数时不会建立网络连接。
- [x] Probe 报告不含凭据、签名、完整 URL、固定文本正文、完整转写或音频字节。
- [x] `npm run typecheck`、`npm test` 和现有离线 demo 在无腾讯云凭据环境中通过。

受控真实探测（必须另行获得用户授权）：

- [x] 使用新生成且只存在于本机 `.env` 的专用子账号密钥完成鉴权；报告不显示 AppID、SecretId、SecretKey、签名或完整 URL。
- [x] 固定短文本通过实时 TTS 得到非空 16k PCM，安全报告记录完成延迟、字符数和音频秒数；第五次 Probe 能进入后续 ASR 阶段也构成 TTS 完成证据。
- [ ] 临时 PCM 通过实时 ASR 得到至少一个最终结果，记录首部分/最终结果延迟和音频秒数；只以布尔/长度范围验证结果，不打印正文。
- [ ] 独立取消测试证明本地连接关闭且取消后的提供方数据不会进入 VOICE-001；不宣称服务端已停止计费。
- [ ] 本轮调用次数与用量未超过规格上限，并由用户复核控制台用量/计费状态。

本规格达到 `implemented` 只代表代码与自动化验收完成；只有上述受控真实探测也有证据时，才可标记 `verified`。即使 `verified`，仍不能替代本机麦克风/扬声器的真实端到端语音验收。

## 8. 文档影响与实施前复核

- [x] 已阅读 [`../START-HERE.md`](../START-HERE.md)。
- [x] 已阅读 [`../architecture.md`](../architecture.md)、[`../mvp-plan.md`](../mvp-plan.md)、[ADR-0001](../decisions/ADR-0001-first-mvp-boundary.md)、[ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[ADR-0003](../decisions/ADR-0003-mac-mini-orbstack-deployment.md)、[ADR-0004](../decisions/ADR-0004-documentation-driven-development.md)、[VOICE-001](VOICE-001-development-voice-session-core.md)、[VOICE-002](VOICE-002-text-reasoner-readiness.md)、[`../providers/tencent-cloud.md`](../providers/tencent-cloud.md) 与 [`../templates/feature-spec.md`](../templates/feature-spec.md)。
- [x] 与现有文档无冲突：本功能实现 ADR-0002 已接受的腾讯云语音适配器边界，不改变单房间、Mac mini、文本上游、记忆或工具决定；因此不新增 ADR。
- [x] 本规格拥有腾讯云适配器契约、Probe 与验收事实；稳定架构、Provider 成本和部署事实只链接引用。
- [x] 已确认 ASR/TTS 控制台开通与 TTS 免费包领取；真实调用仍需新密钥安全落盘、计费边界确认与独立授权。
- [x] 本规格达到 `accepted`，可以开始离线实现和自动化测试。

## 9. 实现与验证证据（实现后填写）

| 项目 | 证据 |
| --- | --- |
| 实现路径 | `packages/tencent-voice/src/`（安全配置、固定官方主机签名、WebSocket 抽象、实时 ASR/TTS 适配器与错误分类）、`apps/voice-gateway/src/config/tencent-voice.ts`（Gateway 组合）、`scripts/probe-tencent-voice.ts`（默认离线、显式计费确认门）与 `test/tencent-voice.test.ts` |
| 文档/ADR 更新 | 本规格、`docs/START-HERE.md`、`docs/features/README.md`、VOICE-001 状态表述、`README.md` 与 `.env.example`；不新增 ADR |
| 静态检查 | `npm run typecheck` 通过（2026-08-17） |
| 自动化测试 | `npm run check` 通过，31/31；其中 13 项覆盖腾讯云配置/签名、ASR/TTS 协议、节流、错误、超时、取消、Gateway 边界、Probe 默认无网络、固定时钟指标、成功/取消连接上限、取消后零交付、全 mock 路径，以及失败时只暴露 stage、安全错误码和数字 providerCode 的诊断包络 |
| 真实运行/人工验收 | 2026-08-17 在新密钥安全门、离线签名自检通过后执行六次各自获得授权的受控 Probe。前三次定位并修正 TTS 鉴权配置；第四、第五次把问题最小化到 ASR `6001` 地域/网络出口边界。为 `tts.cloud.tencent.com` 与 `asr.cloud.tencent.com` 添加 Surge 精确 `DIRECT` 规则后，第六次单次 Probe 以退出码 `0` 完成；按实现的成功条件，这证明真实 TTS 返回非空 PCM，随后 ASR 返回非空最终转写。全程未输出或持久化凭据、正文、转写或音频 |
| 已知限制或未验证假设 | Surge 精确直连已消除 ASR `6001`。Probe 现已输出单行安全成功报告，记录 TTS 首包/完成、ASR 首部分/最终延迟、音频用量、连接次数与零重试，并以 `--confirm-billable` + `--confirm-cancellation` 双重门控最多增加 TTS/ASR 各一次独立取消连接。真实指标、真实取消和控制台用量仍未验收，且本地取消不能证明服务端停止生成/计费；本机音频、VAD/AEC/唤醒词不在本功能范围 |

## 10. 复核记录

| 日期 | session / 变更 | 阅读和复核的文档 | 结论 |
| --- | --- | --- | --- |
| 2026-08-17 | 最终验收探测能力补齐 | 复核 START-HERE、架构、ADR-0002、腾讯云 Provider 文档和既有 accepted 规格；在 Probe 内加入独立单调时钟、单行安全指标、连接/重试计数和 `--confirm-cancellation` 第二授权门。mock 证明成功与取消路径每种能力各最多一次连接、所有 socket 关闭且取消后交付为零；CLI 仅带取消开关仍保持离线 | 不改变架构或 Provider 决策，无需新 ADR；`npm run check` 31/31，离线 CLI 安全门通过。代码已具备最终真实验收条件，但尚未获得新增取消连接的真实调用授权，因此保持 `implemented` |
| 2026-08-17 | Surge 直连后的第六次受控 Probe | 用户确认在 Surge 新增并启用 `tts.cloud.tencent.com`、`asr.cloud.tencent.com` 两条精确 `DOMAIN → DIRECT` 规则；随后只执行一次真实 Probe 且未重试。Probe 退出码为 `0`；复核实现确认失败均设置非零退出码，且成功返回前必须完成非空 TTS PCM 和非空 ASR 最终转写 | `6001` 已消除，真实 TTS→ASR 功能链路打通。外层安全提取器未保留 pretty-printed 成功指标，故仍待延迟/音频指标、独立取消与控制台用量证据，不将规格标记为 `verified` |
| 2026-08-17 | 第五次受控 Probe 与 ASR 错误最小化 | 使用新增安全诊断包络执行一次且未重试；返回 `stage=asr`、`providerCode=6001`。复核腾讯云实时语音识别官方错误码说明，并只读检查当前 shell 代理是否启用，不输出代理地址或凭据 | 鉴权与真实 TTS 已通过；ASR 被国内站账号经境外代理调用的地域边界阻塞。当前 `HTTP_PROXY`/`HTTPS_PROXY` 指向本机回环代理；改为中国大陆直连后再申请一次复测授权 |
| 2026-08-17 | 修正主账号 AppID 后第四次受控 Probe | 用户将 `.env` AppID 修正为签发当前子账号密钥的主账号 AppID；同一 Probe 从稳定 `auth` 前进为 `protocol_error`。随后新增安全 Probe 错误包络和 mock 回归测试，禁止输出 provider message、URL、文本或音频 | 已确认 AppID 归属错误是鉴权根因；30/30 自动化测试通过，等待下一次单次授权以定位新协议错误的 provider stage/code |
| 2026-08-17 | 权限变更后第三次受控 Probe | 用户报告完成 TTS/ASR 权限调整；同一最小 Probe 仍返回 `auth`。使用当前本机配置在内存中把实现与官方 SDK 算法逐字段差分，canonical string 与签名完全一致，且未输出参数、签名或凭据 | 停止真实重试；本地签名已排除，下一步只核对 AppID、密钥、服务开通与策略关联是否落在同一主账号/子用户 |
| 2026-08-17 | 修正后第二次受控 Probe | 使用同一最小复现回路验证官方 SDK 对齐后的签名；TTS 仍稳定返回 `auth`，无音频、无 ASR 调用。复核腾讯官方 CAM 指引确认可用预设策略 `QcloudTTSFullAccess` | 签名修正不是唯一根因；停止真实重试，转为核对子账号 TTS 权限和 AppID/密钥主账号归属 |
| 2026-08-17 | 首次受控真实 Probe 与签名差分 | 新密钥与本机安全门通过；TTS 握手稳定返回 `auth`。对照腾讯官方 TTS/ASR Python SDK，新增签名 known-vector 回归断言，补齐 TTS `ModelType=1`，并把两类签名有效期对齐为官方的 24 小时 | 真实验收仍未通过；29/29 自动化测试通过，等待新的单次真实 Probe 授权后区分签名修正与 CAM/AppID 配置问题 |
| 2026-08-17 | 离线实现与自动化验收 | 本规格及其关联架构/ADR；对照腾讯云实时 ASR/TTS 官方协议实现固定主机签名、PCM 流、取消/超时和默认无网络 Probe | `implemented`；静态检查、29/29 测试、离线 demo 与 Probe 无网络证明通过，真实腾讯云 Probe 仍未授权或执行 |
| 2026-08-17 | 首次建立 VOICE-003 | `AGENTS.md`、START-HERE、架构、MVP、ADR-0001/2/3/4、VOICE-001/002、腾讯云 Provider 文档与功能模板 | `accepted`；可以开始离线实现与 mock 测试，真实 Probe 继续等待安全新密钥、计费确认和明确调用授权 |
