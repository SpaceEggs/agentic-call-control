# Issue #2：ByteDance Seeduplex 实时语音示例开发说明

版本：1.1 · 更新日期：2026-09-15 · 状态：已取得官方 demo 并完成协议核验；真实通话待凭据验收。

> 协议核验结果与本初始设计有三处重要差异：工具位于
> `session.create/session.update` 的 `session.tools` 数组（不存在独立
> `session.tools` 事件）；工具结果使用顶层 `items[]` 及 `content[]`；
> 当前官方 demo 使用模型 `1.2.6.1`。实现细节、来源与 SHA-256 以
> `issue-2-p0-protocol-status.md` 为准；本文件其余“待核验”文字保留为设计历史。

## 1. 需求与证据边界

需求来源：[Issue #2](https://github.com/SpaceEggs/agentic-call-control/issues/2)，当前无补充讨论。

新增一个将 3CX CallControl 电话音频接入 ByteDance Seeduplex（豆包实时语音模型 3.0）的示例。保留现有接待员、通话筛选、路由、日志和 MCP 工具能力，替换实时模型适配层。

本文区分三类信息：

- **需求指定**：issue 明确给出的目录、端点、事件名称、采样率、模型和验收条件。
- **设计约定**：本文补充的模块分工、状态管理、错误处理、测试和实施顺序。
- **待核验**：需要官方 3.0 demo、API 权限或真实 3CX 通话才能确定的字段与行为。

官方入口：

- [Seeduplex 产品页面](https://seed.bytedance.com/zh/seeduplex)
- [3.0 API 文档](https://www.volcengine.com/docs/6561/2549778)
- [接入指南](https://www.volcengine.com/docs/6561/2549732)

本次访问 API 与接入指南未获得正文；产品页也未返回可验证接口细节。以下协议参数来源于 issue，不代表已经独立核验上游接口。issue 指定 `go1.24_duplex_demo.zip` / `python3.7_duplex_demo.zip` 为 JSON 字段依据；本次未取得这两个文件。实现前须完成第 5 节的协议核验，不得猜测字段补全请求。

## 2. 范围、基线与非目标

### 2.1 必须交付

| 项目 | 约定 |
| --- | --- |
| 示例目录 | `examples/bytedance-seeduplex-realtime` |
| workspace 名称 | `@3cx-examples/bytedance-seeduplex-realtime` |
| 根启动命令 | `yarn start:bytedance-seeduplex` |
| provider 文件 | `src/providers/seeduplex-realtime.ts` |
| 工具 schema provider | `seeduplex` |
| 默认配置 | 中文接待员、模型字符串 `1.2.6.0` |
| 文档 | 示例 README 英文/中文、示例 CLAUDE.md、根 README/CLAUDE 示例说明 |
| 实施分支与目标 | `feature/bytedance-seeduplex-realtime` 从最新 `Dev` 建立，PR 回 `Dev` |

### 2.2 复制来源

从实施时最新 `Dev` 的 `examples/alibaba-qwen-realtime/` 复制源码模板，并在 PR 中记录确切基线 SHA。本文检查的远端跟踪基线是 `ca5e5d8`，已包含 PR #3 的 SDK OAuth 实现。

当前本地 `codex/qwen-admin-wip-20260912` 含有未并入 Dev 的管理后台、Tailscale、Zoho Desk 和旧 OAuth 设计，不能直接作为复制来源。Web Dialer 和 Zoho 工具 PR 也不是本任务的前置依赖。

保留 Qwen 模板的 agent、call-routing、tool registry/executor、call logger 和 MCP 接线；仅改造 provider 相关接口与配置。复制代码时不复制真实 `config.yaml`、日志、token store、证书、构建产物或依赖目录。

### 2.3 不在本次范围

- Seeduplex 1.0 二进制协议或版本自动降级。
- 新增管理后台、公网 OAuth 回调、Tailscale、Zoho Desk 或 Web Dialer。
- 改变 3CX 内置 MCP 认证、重新实现 custom MCP OAuth。
- 为其他模型重构一套通用 provider 框架。
- 改变既有分机允许列表、筛选规则、转接授权或业务工具的含义。

## 3. 系统结构和职责

```text
3CX participantConnected
  → call-store：创建独立 CallState、logger、tool executor
  → Seeduplex bridge：WebSocket + 会话初始化
  → session ready → 问候 + 双向流

来电 PCM 8 kHz → 有状态重采样 16 kHz → Base64 → Seeduplex
Seeduplex PCM 24 kHz → 有状态重采样 8 kHz → 3CX audioWriter

模型工具调用 → 名称还原 → 既有 executor
  → 本地路由/筛选工具或 MCP router
  → 工具结果回传 → 后续响应或路由动作

participantDisconnected / terminal error → 幂等清理
```

| 模块 | 职责与改动 |
| --- | --- |
| `src/app-config.ts` | 火山凭据、模型和音色配置；启动前校验；保留 3CX 和 MCP 配置 |
| `src/index.ts` | 3CX 与 MCP 初始化；保留显式 `CONFIG_PATH` 传递；调用新示例的 call-store |
| `src/callcontrol/call-store.ts` | 每通话独立桥接；组合 profile、greeting、tools；断线清理 |
| `src/providers/seeduplex-realtime.ts` | 3.0 会话、WebSocket、音频、事件、工具回传与生命周期协调 |
| `src/providers/seeduplex-protocol.ts`（建议） | 经核验的编码/解码与最小运行时校验；避免把断言当成验证 |
| `src/providers/pcm-resampler.ts`（建议） | 跨帧采样余数、滤波状态与取消后的重置 |
| `src/agent/*` | 复用筛选、允许列表、路由和 executor；修改 provider 类型引用 |
| `agents/receptionist_cn.yaml` / `receptionist_en.yaml` | 保留双语业务提示；替换 Qwen 音色和 provider 特有提示 |
| `packages/mcp/src/tool-schema.ts` | 增加 `seeduplex` 分支和 schema/name 映射测试 |

建议导出 `SeeduplexRealtimeConfig`、`SeeduplexToolDef`、`SeeduplexBridgeHandle` 和 `createSeeduplexRealtimeBridge(participant, config, executeTool)`，保持原模板的注入方式。`stop()` 必须允许重复调用；如果改成异步方法，所有调用方须一致 await 或显式处理 rejection。

## 4. 配置和启动

```yaml
appId: your-3cx-app-id
appSecret: your-3cx-app-secret
pbxBase: https://your-pbx.3cx.eu:5001

volcAppId: your-volcengine-app-id
volcApiKey: your-volcengine-api-key
realtimeModel: "1.2.6.0"
realtimeVoice: zh_female_vv_jupiter_bigtts

agentProfile: receptionist_cn
companyName: "Your Company"
agentName: "小助手"
initialGreeting: 您好，请问有什么可以帮您？
speakOnRouteFailure: true
routeFailureUserReply: 暂时无法完成转接，请稍候或稍后再拨。
```

规则：

1. `volcAppId`、`volcApiKey`、3CX 凭据须为非空值；错误只输出缺失字段名。
2. `appId` 与 `volcAppId` 含义不同，不得相互替代。沿用模板对数字型 3CX DN 的字符串规范化。
3. `realtimeModel` 以字符串保存，默认 `1.2.6.0`；当前需求视其为上游固定值。不宣称支持任意模型版本。
4. 音色优先级沿用模板：profile.voice → realtimeVoice → 默认值。必须替换复制来的 Ethan/Serena 等 Qwen 音色；英文 profile 的可用音色需核验，不以改成英文提示等同于英文能力验证。
5. `customMcpServers` 继续使用共享包的配置类型和校验。authorization_code 使用 `grant`、`clientId`、`tokenStore`、`redirectUri`，通过 `mcp:auth` 预授权。
6. 不引入旧 `callbackPort`、`tokenFile`、`openBrowser` 配置。火山 WebSocket 凭据与 custom MCP OAuth 是独立链路。
7. 不把 Qwen `dashscopeBaseUrl`、`dashscopeApiKey`、`gummy-realtime-v1` 或 VAD 配置直接发送给 Seeduplex。
8. 端点固定在协议模块；若未来允许覆盖，应显式新增配置和验证，本期不自动尝试 1.0 地址。

根 package.json 增加 workspace 启动脚本与 `yarn start` 帮助说明；保留现有 `mcp:auth` 和其他例子的命令。新 workspace 使用仓库 Yarn 版本及现有依赖约定，更新并验证 lockfile。

README 需说明：在火山豆包语音控制台取得 APP ID/API Key，3.0 访问可能需要邀请或开通；403/权限不足不能通过更换成 1.0 端点规避。

## 5. 协议契约：开发前置核验

### 5.1 issue 指定的接口

| 方向/用途 | 需求指定值 | 尚需 demo 确认 |
| --- | --- | --- |
| WebSocket | `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue` | 额外握手头、版本与连接标识 |
| 认证头 | `X-Api-Key` + `X-Api-App-Id` | 值的格式、授权失败返回 |
| 帧格式 | WebSocket text JSON | 心跳、错误帧、大小限制 |
| 创建会话 | `session.create` | model、voice、instructions、音频参数的嵌套位置及必填项 |
| 更新会话 | 可选 `session.update` | 允许更新字段、ack 事件与时序 |
| 上行音频 | `input_audio_buffer.append`，Base64 16 kHz PCM | 音频字段名、推荐帧长、commit/VAD 规则 |
| 下行音频 | `response.output_audio.delta`，Base64 `pcm_s16le` 24 kHz | payload 字段名、response/item 标识与结束事件 |
| 问候 | `speech_text_buffer.commit` | 是否先 append 文本、文本字段位置及触发响应规则 |
| 工具注册 | `session.tools`，JSON Schema function tools | flat/nested function 格式、支持关键字 |
| 工具调用 | `response.function_call_arguments.done`，`items[]` | arguments 是字符串还是对象、批次完成语义 |
| 工具结果 | `conversation.item.create`，`role: "tool"`、匹配 `call_id` | content/output 类型与字段层级；是否显式触发后续响应 |
| 用户开始发言 | `conversation.item.input_audio_transcription.started` | 是否足够早地表示语音起点；重复事件行为 |
| 取消输出 | `response.cancel` | 取消粒度、标识字段、ack、迟到音频处理 |

禁止使用 `/api/v3/realtime/dialogue`、二进制帧头、压缩标志或数字事件 ID。不要因为事件名相似而复用 Qwen `response.create`、`function_call_output` 或 nested tool envelope。

### 5.2 核验产物与完成标准

取得官方 demo 后记录来源链接、下载日期、文件名、SHA-256 和关键源码位置；不提交含密钥的运行配置。按 demo 和 API 文档形成一份脱敏协议记录，包括：

- 最小握手、session.create、ready ack、可选 update。
- 一次完整问候、输入音频、输出音频与 response 结束。
- 单工具、多工具调用和工具结果后的继续生成。
- 用户打断、取消响应、取消后的新回复。
- 认证失败、session 配置错误和关闭帧。

将以上输入/输出整理成测试 fixtures。协议核验完成条件是每一条生产发送消息均有官方依据，每一个控制状态转换都有确认的事件或明确本地条件。demo 与 issue 冲突时记录差异并更新设计，不静默切换 API 版本。

没有真实权限时可继续 scaffold、音频和 mock 测试；“协议已核验”和“真实通话验收”必须保持未完成状态。

## 6. 会话与资源生命周期

设计状态为 `connecting → configuring → ready → closing → closed`，异常进入 `closing`。这些是本地状态名，不是上游事件名。

1. 每个 participant 独立创建连接、音频状态、工具去重表和日志上下文。
2. WebSocket open 后发送一次 session.create；按核验的 ack 进入 ready。open 不等于会话配置成功。
3. ready 前不发送问候和音频。若为避免丢失开头而缓冲输入，必须使用有界队列并记录溢出。
4. 问候只发送一次；重复 ack/update 不得重复问候或注册第二条音频监听。
5. ready 后开始双向音频；输出与工具处理可并发，但路由动作受单独终态锁保护。
6. 通话结束、路由成功、provider 终止或连接超时都走同一个 stop 路径。
7. stop 移除音频监听、清空队列、取消播放、关闭 socket、清理定时器和 logger；迟到的 Promise/事件不得重新启动桥接。
8. 首版不自动重放工具调用或透明重建对话。连接断开后清理该桥接并记录失败，不擅自执行 drop/transfer；后续自动恢复策略单独设计。

连接/配置/工具超时和队列上限采用具名常量，记录默认值、单位与触发行为；具体参数在协议核验和延迟测试后确定，不能无界等待。

## 7. 音频处理与打断

### 7.1 数据格式

全链路使用单声道、16-bit little-endian PCM：3CX 为 8 kHz，上行模型为 16 kHz，下行为 24 kHz。Base64 仅用于 WebSocket JSON 传输，不加入 WAV 头。

验证样本量：连续 1 秒 3CX 音频为 16,000 bytes，转成 16 kHz 为 32,000 bytes；模型 24 kHz 的 48,000 bytes 应产生 16,000 bytes 的 3CX 音频。以上不含 Base64 编码膨胀。

### 7.2 重采样

模板的重复采样/每三个采样取一个可作为功能参考，但不可忽略跨帧状态：WebSocket 帧不是采样边界保证。

- 上行保留不足 2 bytes 的残片，和下一块合并后处理。
- 下行保留不足完整采样的残片及 3:1 抽取相位；不得每块独立 floor 后丢尾部。
- 下采样采用带抗混叠处理的有状态实现；记录滤波延迟，并测试振幅/削波。若首版暂用模板算法，明确音质限制，不能宣称达到同等音质。
- 打断和通话结束清掉旧响应残片；新响应不得混入旧采样尾部。
- 对输入队列、WebSocket bufferedAmount 和播放队列建立上限；持续积压必须可观测，不能以无限缓存换取假成功。

### 7.3 Barge-in

收到需求指定的 `conversation.item.input_audio_transcription.started` 时，立即调用 `audioWriter.cancel()`，清除旧输出缓存并使当前输出失效。此动作不能等待 MCP 工具结束。

需要针对锁定版本的 3CX SDK 核验 cancel/clear/恢复播放的真实语义：如果 cancel 会使 writer 持续不可写，必须按 SDK API 恢复或取得可用 writer。验收同时要求“旧音频停止”和“下一轮音频能继续播放”。

使用响应标识或本地输出代数隔离被打断的旧 delta。若上游不携带足够标识，必须依据核验后的响应边界设计丢弃窗口并测试；不能无条件把 cancel 后收到的所有 delta 当作新回复。

用户打断不应重复执行或重发已有工具。是否在普通 barge-in 同时发送 response.cancel 按 3.0 协议确认；issue 明确要求的本地 audioWriter.cancel 必须执行。

## 8. 工具调用和通话路由

### 8.1 Schema 与名称

`ToolSchemaProvider` 增加 `seeduplex`；初始设计复用 `openai` profile，保留数值/布尔类型，不套用 Qwen 的标量转字符串规则。若实测拒绝关键字，只针对有证据的字段收紧。

保留 `normalizeToolDefinitions` 返回的 `originalNameByName`，在执行前还原名称。例如模型看到 `googlecalendar_quick_add`，executor 必须收到原始 `googlecalendar.quick_add`。名称规范化冲突应在创建会话前失败，禁止将调用路由到错误工具。

工具只来自既有 registry 和 profile 允许列表。issue 的 `list_phonebook` 示例归类为 3CX MCP 工具；`transfer_call`、`drop_call` 等属于本地动作，两者都要验证闭环。

### 8.2 调用流水线

1. 只在经核验的 arguments.done 事件上解析 `items[]`，不能沿用 Qwen 顶层 `event.call_id/name/arguments` 假设。
2. 每项校验 call_id、name 和 arguments；arguments 为对象时按 executor 接口序列化，为字符串时验证 JSON 为可接受对象。
3. 按 call_id 保存 queued/running/completed 状态，重复事件不得再次产生副作用。
4. 首版按 items 顺序执行；工具批次之间也必须串行协调，避免两个异步 handler 同时转接。
5. 调用既有 executeTool，将结果按 demo 的 role=tool 消息封装并保持相同 call_id。
6. 参数错误、未知工具、MCP 失败返回可理解的错误结果；不泄露凭据、不构造虚假业务成功。
7. 普通工具完成后，按协议确定的机制继续生成。不照搬 Qwen response.done 后才执行或无条件 response.create。
8. stop 后完成的工具结果不得写入已关闭连接。

### 8.3 路由动作

继续复用 ToolResult.action：transfer、drop、transfer_voicemail；由既有 screening、分机允许列表与可用性检查决定是否允许执行。

动作确认后锁定本通话的路由操作。若 TTS 在飞，发送 response.cancel 并阻止旧音频继续入队；按既有业务规则处理必要的结束语/播放完成，调用相应 Participant API。后续批次不得再发起第二个路由动作。

SDK 操作成功后清理桥接；失败时记录真实失败并按 speakOnRouteFailure/routeFailureUserReply 恢复反馈。不得把“模型请求转接”记录为“转接成功”。同批次多工具结果如何回传、动作之后剩余项目如何拒绝，需要以明确测试固定。

## 9. 错误处理与日志

| 场景 | 行为 |
| --- | --- |
| 缺失凭据 | 启动校验失败，提示配置字段 |
| WebSocket 401/403 | 记录鉴权/开通失败，清理连接，不尝试旧协议 |
| session.create 被拒绝 | 记录脱敏错误码及阶段，不进入 ready |
| 非 JSON/格式错误事件 | 捕获解析错误；计数并按严重性关闭，不导致进程未捕获异常 |
| 未知事件 | debug 摘要与计数，不任意改变状态 |
| 非法音频/持续积压 | 记录原因，丢弃或关闭按明确策略处理，保持内存有界 |
| 工具超时/失败 | 一次错误结果，副作用工具不得自动重试 |
| caller 已挂机 | 停止处理迟到音频、工具结果和响应 |

日志至少包含 participant/session/response/call_id 的关联信息、连接阶段、问候发送、输入输出字节统计、打断次数、被丢弃的旧帧数、工具耗时、路由结果、关闭原因。语音转写沿用既有日志策略；不默认增加原始音频落盘。

禁止打印 API Key、认证头、appSecret、token store 内容和整段 Base64 音频。协议 fixture 使用合成数据或脱敏录制结果。

## 10. 文件与实施任务清单

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| P0 协议核验 | 取得官方 demo、锁定 payload、确认 writer 取消/恢复、整理 fixtures | 第 5 节未确认字段有证据或明确阻塞记录 |
| P1 Scaffold | 从 Dev 复制 Qwen、新 workspace/config/profile、根脚本、schema provider | 无 Qwen 凭据/音色残留；配置检查与 build 可运行 |
| P2 会话桥接 | WebSocket headers、session.create/ready、问候、JSON parser、stop | fixture 覆盖成功、配置失败、重复 ack、迟到事件 |
| P3 音频 | 有状态重采样、上行/下行、队列控制、barge-in、恢复播放 | 分块一致性、取消和新回复测试通过 |
| P4 Tools | items[]、名称还原、去重、结果封装、批次、路由终态锁 | 本地与 MCP 工具闭环、重复动作和失败路径测试通过 |
| P5 文档/回归 | EN/ZH README、CLAUDE、根入口、自动化测试、真实联调 | 第 11 节证据完整，PR 回 Dev |

共享包改动只限 Seeduplex schema profile 和针对性测试；不借此改造其他 provider。新例子的测试脚本要实际发现新增测试文件，不能只继承模板的文件 glob。

## 11. 测试和验收矩阵

### 11.1 无真实凭据的自动化测试

| 编号 | 测试输入 | 必须证明 |
| --- | --- | --- |
| T01 | 正确/缺失配置、数字型 DN、模型字符串 | 字段校验和类型处理正确，错误无秘密 |
| T02 | Mock WebSocket 握手与配置 | 端点为 duplex 路径、两项认证头、text JSON、无 Bearer |
| T03 | ack 重复、延迟、拒绝 | ready 前无媒体发送；问候仅一次 |
| T04 | PCM 连续块与任意碎片分块 | 采样数量正确、分块结果一致、余数不丢失 |
| T05 | 音频输出中 speech started、迟到 delta、新响应 | cancel 立即生效；旧音频不回放；新回复正常 |
| T06 | items[] 单项/多项、字符串/对象参数 | 使用真实 fixture 字段，顺序和 call_id 正确 |
| T07 | 命名空间工具、名称冲突、未允许工具 | 名称还原、碰撞拒绝、allowlist 有效 |
| T08 | 重复 call_id、重叠批次、多路由动作 | 业务副作用只一次，路由互斥 |
| T09 | 工具抛错、超时、转接失败 | 一次失败结果，反馈策略与清理正确 |
| T10 | stop 重复、连接过程中挂机、工具完成后挂机 | 无泄漏监听/定时器、无未处理 rejection、无连接复活 |
| T11 | 非 JSON、非法音频、未知事件、缓冲积压 | 可控失败、内存有界 |
| T12 | Seeduplex schema 与其他 provider 对比 | 初始 openai 别名符合设计，现有 provider 行为不变 |

Mock 不替代 API 兼容性验收；用脱敏官方 demo fixtures 锁定字段，用 fake Participant/writer 验证通话行为。

### 11.2 真实环境验收

准备测试用 3CX service principal/RoutePoint、可接听的目标分机、火山 3.0 权限、测试电话号码和必要 MCP 凭据。不得用真实业务写入工具作为 smoke test。

1. 仓库根目录执行 `yarn start:bytedance-seeduplex`，正确定位示例 config。
2. 来电后建立 3.0 会话，中文问候一次，持续双向音频清晰无明显变速。
3. 用户在长回复中插话，剩余 3CX 播放停止，下一轮能继续回复。
4. 连续多轮插话、回复和工具调用不导致无声、重复播放或工具重复执行。
5. 电话簿查询、允许转接、拒绝非法分机、筛选未完成、drop/voicemail 和路由失败均符合原业务规则。
6. 分别验证中文和英文 profile；记录语言/音色支持限制。
7. 通话中关闭上游连接、caller 提前挂机，进程可服务后续新来电，无资源持续增长。
8. 两通并发来电的音频、call_id、工具结果互不串线。

测量问候延迟、用户结束说话到首段回复、打断到播放停止、工具往返耗时。issue 未指定毫秒 SLA；记录实际分布与网络环境，评审后再设门槛，不能声称已满足未定义指标。

### 11.3 仓库检查

```bash
yarn install --immutable
yarn build
yarn lint
yarn workspace @3cx-examples/mcp test
yarn workspace @3cx-examples/bytedance-seeduplex-realtime test
```

验证各命令实际涵盖的文件，并记录基线已存在的失败与本次新增失败。真实验收未完成时 PR 可为 draft，不能用 mock 成功勾选通话验收。

### 11.4 Issue 验收映射

| Issue 条件 | 开发落点 | 验收证据 |
| --- | --- | --- |
| 根命令启动 | workspace、根脚本、config loader | T01、实际根命令启动 |
| 来电建会话、问候、8k↔16k/24k | bridge、call-store、重采样 | T02–T04、真实双向通话 |
| function_call_arguments.done 闭环 | tools adapter、executor、MCP | T06–T09、真实电话簿和路由 |
| barge-in 取消残余音频 | writer cancel、旧响应过滤、播放恢复 | T05、连续插话实测 |
| EN/ZH README 说明凭据、模型、版本区别 | 文档与配置示例 | 文档核对和新环境操作复现 |

## 12. 文档交付与待确认项

英文/中文 README 应包含：3CX service principal 与 RoutePoint 准备、火山 APP ID/API Key 和邀请权限、Yarn 启动、配置字段、profile/voice、音频路径图、3.0 与 1.0 区别、工具与 MCP 预授权、日志与故障排查。示例 CLAUDE.md 说明模块入口、协议来源、测试命令和禁止回退到二进制 API 的约束。

实现前优先关闭以下问题：

1. 官方 demo 的可访问来源、版本以及完整 session/greeting/tool payload。
2. 会话就绪、响应开始/结束、工具结果继续生成的准确事件与时序。
3. audioWriter.cancel 后的恢复机制以及旧响应识别能力。
4. APP ID/API Key 是否具备 3.0 权限；默认音色及英文 profile 的实际支持。
5. session.tools 接受的 schema 范围、最大音频消息与并发限制。

本文可用于实施拆解与 PR 验收，但尚未完成上述上游协议核验，也未执行 Seeduplex 真实通话测试。
