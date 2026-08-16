# 功能规格：VOICE-002 文本深度推理适配器准备与探测

> 本功能将 VOICE-001 的确定性文本推理适配器替换为可验证的 OpenAI-compatible 文本上游边界。它先探测实际模型与流式能力；不接入音频、搜索、记忆或真实家庭工具。

## 元数据

| 字段 | 内容 |
| --- | --- |
| 状态 | `accepted` |
| 变更等级 | `T2` |
| 创建日期 | 2026-08-16 |
| 最后文档复核 | 2026-08-16 |
| 设计依据 | 用户授权使用当前进程中的 `IVAN_ONLINE_API_URL` 与 `IVAN_ONLINE_API_KEY` 完成本机测试；MVP 的可替换文本深度推理边界 |
| 关联 ADR | [ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[ADR-0004](../decisions/ADR-0004-documentation-driven-development.md) |
| 默认模型决定 | `gpt-5.6-terra`；以当前受控探测中更短的流式首包为准，`gpt-5.6-sol` 保留为后续可显式选择的深度候选 |
| 预计实现路径 | `apps/voice-gateway/src/config/`、`packages/text-reasoner/`、`scripts/`、对应测试、`.env`（本机忽略文件） |
| 验收负责人 | Codex：静态/自动化与受控探测；用户：确认本机上游账户与后续实际用量策略 |

## 1. 目标与非目标

### 目标

- 在不输出、提交或记录密钥的前提下，将当前进程的 `IVAN_ONLINE_*` 配置写入本机忽略的 `.env`，仅供 Voice Gateway 的文本推理适配器读取。
- 以最小的无私人内容请求探测 OpenAI-compatible 上游的模型列表、普通响应、流式响应、超时、取消和错误分类。
- 根据实测结果选择一个默认文本深度推理模型；选择必须可复现为 `.env` 中的 `TEXT_REASONER_MODEL`，而不是写死进代码。
- 提供类型化的 OpenAI-compatible 文本流适配器，可注入 VOICE-001 的 `ReasonerAdapter`，并只接收最终转写与可选最小化摘要。
- 输出脱敏能力报告：模型 ID、支持/不支持的能力、延迟和错误分类；不得输出 endpoint、Authorization header、密钥、完整请求或完整响应文本。

### 非目标

- 不将 `IVAN_ONLINE_*` 变量、`.env`、模型响应或任何凭据加入 Git、日志、测试快照或文档。
- 不假定上游支持 Responses API、音频、联网搜索、工具调用、JSON Schema 或特定模型；只验证本功能实际使用的 Chat Completions 文本路径。
- 不向上游发送原始音频、部分转写、完整会话、完整长期记忆或腾讯云凭据。
- 不接入腾讯云 ASR/TTS、macOS 麦克风/扬声器、唤醒词、VAD、数据库或常驻 Docker 服务。
- 不把一次模型探测视为长期可用性、价格、配额或生产 SLA 的证明。

## 2. 用户场景与状态流

开发者在 Mac mini 的受控本机环境执行一次显式的文本上游探测。配置校验只报告“是否存在”和安全元数据；探测先读取模型列表，再针对候选模型发送固定短探针，最后单独验证流式与取消。任何失败都输出结构化、脱敏诊断并停止；不会自动切换到未知模型或重复消耗上游配额。

~~~text
LOCAL ENV（仅当前进程）
  └─ 显式本机同步 ─► .env（0600、被 .gitignore 忽略）
                              │
                              ▼
CONFIG_VALIDATED ─► MODELS_LISTED ─► CANDIDATE_PROBED
                                              │
                           ┌──────────────────┴──────────────────┐
                           ▼                                     ▼
                    STREAM/CANCEL_OK                       UNSUPPORTED/ERROR
                           │                                     │
                           ▼                                     ▼
                    MODEL_SELECTED                       SAFE_FAILURE_REPORT
                           │
                           ▼
            ReasonerAdapter 可被 Gateway 注入（文本仅）
~~~

探测内容固定为无私人、无工具、无音频的短文本。用户取消或超时必须中止 HTTP 请求；上游后续输出不得进入会话状态机。

## 3. 模块边界与契约

| 模块/外部系统 | 输入 | 输出 | 不负责什么 |
| --- | --- | --- | --- |
| 本机配置同步 | 当前进程的 `IVAN_ONLINE_API_URL`、`IVAN_ONLINE_API_KEY` | 权限为 0600 的本机 `.env` | Git 提交、系统级凭据管理、向 Satellite 下发密钥 |
| Gateway 配置 | `TEXT_REASONER_*` 环境变量 | 经校验的、不可序列化密钥配置 | 自动猜测模型或默认公网 endpoint |
| 模型探测器 | 已校验配置、固定短探针、取消信号 | 脱敏模型/能力/延迟报告 | 写入用户会话、长期记忆或业务日志 |
| OpenAI-compatible 适配器 | 最终转写、可选最小化摘要、取消信号 | 文本片段或结构化失败 | 原始音频、部分转写、完整上下文、搜索/工具调用 |
| VOICE-001 Gateway | 已注入的 `ReasonerAdapter` | 既有状态机中的文本流 | 读取 `.env` 以外的系统密钥或接触音频设备 |

配置允许的 URL 仅为 HTTPS；环回 `http://127.0.0.1` 或 `http://localhost` 可作为本机开发例外。禁止自动跟随重定向，禁止将上游 URL 从用户转写、模型输出或网络响应中取得。HTTP 请求固定使用 `Authorization: Bearer <key>`、`Content-Type: application/json` 和显式 `AbortSignal`。

当前配置的地址形态是完整的 Chat Completions 路径。适配器应当同时接受“API 根路径”和完整的 `.../chat/completions` 路径：普通请求使用 Chat Completions 路径，模型列表从同一 API 根路径派生为 `/models`。此归一化只在已验证的配置 URL 内完成，清除 query/hash，不允许跳转到其他主机。

Chat Completions 请求的最小形状为：`model`、固定系统提示（仅在探测时）、一条固定用户短句、`stream` 与受限 `max_tokens`。实际 ReasonerAdapter 只允许最终转写、可选摘要和用户批准的结构化工具结果；VOICE-002 不启用工具。

## 4. 数据、隐私与权限

- `.env` 是本机私有配置，必须由 `.gitignore` 排除，创建后权限为 0600；现有文件若存在且含未知配置，不得静默覆盖。
- 密钥只作为 HTTP Authorization header 使用，任何配置对象的 `toJSON`、错误、指标和 CLI 输出均不能含该值或其长度/指纹。
- 能力探测的请求和响应正文不写入磁盘。报告只保存模型 ID、状态、首字节/完成延迟、HTTP 状态类别和取消结果。
- 文本适配器请求只接收最终转写和已获准的最小化摘要；类型和单元测试必须排除 `audio`、`partialTranscript`、`fullTranscript`、`memoryItems` 与任意凭据字段。
- 本功能不建立新用户身份或外部授权。用户已授权本机调用其当前 CLIProxyAPI 上游；任何新的提供方、账户或可计费资源仍需单独确认。

## 5. 提供方、成本与运行影响

- 上游是用户当前环境提供的 OpenAI-compatible 文本 endpoint；其实际模型、价格、限流、流式/取消能力均未知，必须通过探测获得事实。
- 探测最多执行一次模型列表、每个候选一次非流式短请求、一次流式短请求和一次受控取消；候选数和 `max_tokens` 必须有限，避免意外消耗。
- 默认模型的选择优先级：可用性与稳定取消/流式 > 中文复杂推理质量 > 首字节延迟 > 成本/配额适配。不得只因名称包含“最新”或“最强”就设为默认。
- 默认模型、endpoint 和密钥均由 `.env` 控制；代码不包含模型 ID、价格或 endpoint 常量。README 只描述配置变量和安全行为。
- 不新增 LAN 端口、Docker 服务或持久化数据库。探测 CLI 只能由本机手工执行，不作为常驻重试任务。

### 2026-08-16 受控探测事实

- 以用户授权的当前进程配置进行了一次只读模型列表探测，确认存在 9 个模型；其中可用于本功能的文本候选包括 `gpt-5.6-terra`、`gpt-5.6-sol`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4` 与 `gpt-5.4-mini`。探测没有输出地址、凭据或响应正文。
- 对 `gpt-5.6-terra` 与 `gpt-5.6-sol` 的固定简短中文非流式请求均获得正常结束的响应；实测完成时间分别约为 5.1 秒与 4.3 秒。该样本只证明基本响应可用，不能据此比较复杂推理质量或长期延迟。
- 两个候选都能够开始 SSE 流并在收到第一个数据块后观测到本地 `AbortSignal` 取消。实测首数据块约为 `gpt-5.6-terra` 2.2 秒、`gpt-5.6-sol` 4.5 秒。
- 因 VOICE-002 的回答会持续向后续 TTS 管道流转，默认选择 `gpt-5.6-terra`，优先保证当前已测得的首片段体验与取消行为。`gpt-5.6-sol` 不是回退模型；后续若需要“深度模式”，应以用户可见、可配置的路由规则单独设计。
- 本次探测未衡量上游价格、配额、复杂推理准确率、并发容量或服务端是否停止了已被客户端取消的生成；这些都仍是后续运行验证范围。

## 6. 失败、取消与降级

| 情形 | 期望行为 | 用户可见反馈 | 审计/指标 |
| --- | --- | --- | --- |
| 缺少或非法配置 | 请求前失败，不建立网络连接 | `configuration_invalid` | 缺失字段名和错误类别，不含值 |
| 401/403 | 停止，不重试、不输出响应正文 | `authentication_failed` | HTTP 类别、阶段 |
| 429 | 停止，不自动切换模型或循环重试 | `rate_limited` | HTTP 类别、`Retry-After` 是否出现 |
| 上游 5xx/协议不兼容 | 停止该候选，继续下一个候选仅在探测预算内 | `provider_unavailable` / `protocol_unsupported` | 阶段、HTTP 类别、模型 ID |
| 超时 | 中止 fetch、报告该阶段超时 | `timed_out` | 阶段、耗时、模型 ID |
| 用户取消 | 中止 fetch、不消费后续流片段 | `cancelled` | 阶段、取消是否传播 |
| 无可用模型 | 保持 `TEXT_REASONER_MODEL` 未配置，不假定回退 | `no_supported_model` | 可用模型数量、失败类别摘要 |

## 7. 验收标准

自动化验收：

- [ ] 配置校验拒绝缺失、空白、非法 URL、非 HTTPS（非环回例外）和无模型配置；错误不含密钥值、长度或指纹。
- [ ] `.env` 同步只在文件不存在时创建，设置 0600，不覆盖已有文件，且不会出现在 `git status`。
- [ ] 模型列表、普通 Chat Completions、SSE/流式片段、401/429/5xx、超时和 `AbortSignal` 均由本地 mock 覆盖。
- [ ] 实际适配器向上游只发送允许的文本字段和固定元数据；测试证明请求 JSON 不含音频、完整会话、长期记忆、密钥或工具定义。
- [ ] Probe report 不包含 endpoint、Authorization、密钥、请求正文或完整响应正文。
- [ ] 适配器可被 VOICE-001 注入，用户取消会阻止后续文本片段进入 TTS。

受控真实探测（用户已授权，但不会伪称生产验证）：

- [ ] 使用本机 `.env` 成功列出上游模型 ID，不输出 endpoint 或凭据。
- [ ] 至少一个候选模型完成固定短文本的非流式与流式请求，并记录脱敏延迟。
- [ ] 对选定模型验证取消可终止本地请求；若上游不支持，应明确标记限制而不是假定成功。
- [ ] `TEXT_REASONER_MODEL` 被设置为依据上述优先级选择的实测可用模型。

## 8. 文档影响与实施前复核

- [x] 已阅读 [`../START-HERE.md`](../START-HERE.md)。
- [x] 已阅读 [`../architecture.md`](../architecture.md)、[`../mvp-plan.md`](../mvp-plan.md)、[ADR-0002](../decisions/ADR-0002-tencent-voice-and-text-reasoner.md)、[ADR-0004](../decisions/ADR-0004-documentation-driven-development.md)、[VOICE-001](VOICE-001-development-voice-session-core.md) 与 [`../providers/tencent-cloud.md`](../providers/tencent-cloud.md)。
- [x] 与现有文档无冲突：本功能实现既有的可替换文本上游边界，不改变腾讯云、音频或部署决定；因此关联现有 ADR，不新增 ADR。
- [x] 本规格拥有配置同步、上游探测和文本适配器的事实；稳定语音/隐私边界仅链接引用。
- [x] 已完成真实模型列表与最小能力探测，并选择默认模型。
- [x] 本规格达到 `accepted`，可以开始实现。

## 9. 实现与验证证据（实现后填写）

| 项目 | 证据 |
| --- | --- |
| 实现路径 | 待实现 |
| 文档/ADR 更新 | 本规格、`docs/START-HERE.md`、`docs/features/README.md`，以及必要的 README/配置示例 |
| 静态检查 | 待实现 |
| 自动化测试 | 待实现 |
| 真实运行/人工验收 | 已用当前进程环境完成只读模型列表、两条短中文非流式请求及两条首片段后本地取消的流式请求；未显示 endpoint、凭据或响应正文。`.env` 写入和从 `.env` 的实际适配器运行仍待实现后验证 |
| 已知限制或未验证假设 | 已确认基本模型列表、文本响应、首片段与本地取消；流格式完整兼容、超时/HTTP 分类、限流、账号配额、复杂推理与服务端取消仍待实现和后续验证 |

## 10. 复核记录

| 日期 | session / 变更 | 阅读和复核的文档 | 结论 |
| --- | --- | --- | --- |
| 2026-08-16 | 受控模型探测 | 本规格、ADR-0002/4、VOICE-001；在授权的当前进程环境中完成模型列表、短中文响应、SSE 首片段与本地取消测试 | `accepted`；默认 `gpt-5.6-terra`，随后可开始实现 |
| 2026-08-16 | 首次建立 VOICE-002 | `AGENTS.md`、START-HERE、架构、MVP、ADR-0002/4、VOICE-001、提供方文档；仅盘点 `IVAN_ONLINE_*` 变量名与配置状态 | `draft`；先获取模型列表与最小能力事实，再选择模型和接受规格 |
