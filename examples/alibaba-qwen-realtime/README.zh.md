# 智能呼叫控制 — 阿里云通义千问实时语音

一个通过 CallControl SDK 连接到 **3CX PBX** 的 AI 语音代理，使用**阿里云 DashScope 通义千问全模态实时**——单条 WebSocket 连接实现端到端语音对话，无需独立的 STT/LLM/TTS 流水线。

---

## 前置条件

### 3CX 服务主体

创建 API 凭证，使代理能够控制 PBX 上的通话：

1. 打开 3CX Web 客户端
2. 进入 **管理 → 集成 → API**
3. 点击 **添加服务主体**
4. 设置**客户端 ID**（例如 `assistant`）——这将成为你的 `appId`
5. 启用 **"为此应用程序启用 3CX 呼叫控制 API 访问"**
6. *(可选)* 分配一个 **DID 号码**（呼叫者拨打的电话号码）
7. *(可选)* 点击**选择分机**，选择代理可控制的分机
8. **保存** ——生成的客户端密钥即为你的 `appSecret`

### DashScope API 密钥

从[阿里云 DashScope 控制台](https://dashscope.console.aliyun.com/)获取 API 密钥。

> **注意：** DashScope API 密钥与地区绑定。中国大陆地区的密钥需使用 `dashscopeBaseUrl: https://dashscope.aliyuncs.com`；国际控制台（新加坡）的密钥使用 `https://dashscope-intl.aliyuncs.com`。端点与密钥地区不匹配将导致认证失败。

---

## 快速开始

在仓库根目录复制配置文件：

```bash
cp examples/alibaba-qwen-realtime/config.yaml.example examples/alibaba-qwen-realtime/config.yaml
```

填写凭证——打开 `examples/alibaba-qwen-realtime/config.yaml`：

```yaml
# 3CX 服务主体 — Web 客户端 → 管理 → 集成 → API
appId: your-client-id          # 服务主体客户端 ID
appSecret: your-client-secret  # 服务主体 API 密钥
pbxBase: https://your-pbx.3cx.eu:5001  # 你的 PBX FQDN

# 阿里云 DashScope API 密钥 — https://dashscope.console.aliyun.com/
dashscopeApiKey: sk-your-dashscope-api-key
dashscopeBaseUrl: https://dashscope-intl.aliyuncs.com  # API 密钥与地区绑定 — 中国大陆地区密钥请使用 https://dashscope.aliyuncs.com
realtimeModel: qwen3.5-omni-plus-realtime
realtimeVoice: male-qn-qingse  # male-qn-qingse | female-shaonv | male-qn-jingying | female-tianmei
realtimeVadSilenceDurationMs: 800  # 服务端 VAD 静音阈值（可选）

# 代理配置文件 — 从 agents/<name>.yaml 加载
agentProfile: receptionist
companyName: Your Company
agentName: Assistant
```

然后在仓库根目录启动：

```bash
yarn start:alibaba-qwen
```

### 呼叫代理

代理运行后，有两种方式在 3CX PBX 上接通它：

- **内部呼叫** ——从任何已注册的 3CX 分机（桌面电话、Web 客户端或移动应用），拨打**客户端 ID**（配置的 `appId`，例如 `assistant`）。PBX 将直接把呼叫路由到代理。
- **外部呼叫（DID）** ——如果你为服务主体分配了 DID 号码（上面的第 6 步），外部线路上的呼叫者可以拨打该电话号码接通代理。

## 管理台公开方式

Qwen 进程提供包含概览、日志、MCP 和证书管理的中文管理台。通过 `admin.mode` 二选一：

- `https`（默认）：使用自定义域名和 lego 证书，由应用直接提供 HTTPS。
- `tailscale-funnel`：应用只在 `127.0.0.1` 提供 HTTP，由 Tailscale Funnel 公开完整管理台并提供 `*.ts.net` 域名和 HTTPS 证书。

直接 HTTPS 模式需要安装 **lego v5.0.4**、配置 `admin.publicBaseUrl`、`admin.tls` 和权限为 `0600` 的阿里云 DNS 凭据文件，然后执行 `yarn cert:init:qwenalibaba`。

Tailscale Funnel 模式不需要自定义域名、lego 或阿里云凭据：

```yaml
admin:
  enabled: true
  mode: tailscale-funnel
  host: 127.0.0.1
  port: 8787
  stateFile: data/admin-state.json
  tailscaleFunnel:
    tailscalePath: /usr/bin/tailscale
    publicPort: 443
    stopOnExit: true
    # publicBaseUrl: https://your-node.your-tailnet.ts.net
```

未配置 `tailscaleFunnel.publicBaseUrl` 时，程序会从 `tailscale status --json` 自动读取当前节点的 `Self.DNSName`。启动时执行后台 Funnel，将整个管理台代理到仅监听 `127.0.0.1` 的 HTTP 服务；正常退出时默认关闭 Funnel。

使用前需要确保 Tailscale 已登录、tailnet policy 已允许 Funnel，并且运行进程的用户可以无交互执行 Tailscale CLI。管理台地址和 OAuth 回调分别为：

```text
https://<node>.<tailnet>.ts.net/
https://<node>.<tailnet>.ts.net/api/mcp/oauth/callback
```

Funnel 公网端口只支持 `443`、`8443` 或 `10000`。管理台没有应用层登录或 IP 白名单；Funnel 模式下，知道或发现该地址的公网用户都可以访问管理功能。

管理台支持 `streamable-http` 和 `mcp-remote` 的浏览器 OAuth。`mcp-remote` 使用独立本地缓存，管理台会注册公网回调并将授权结果转发给本机兼容进程。取消鉴权会同时禁用该 MCP，避免不要求 OAuth 的端点自动重新连接；重新鉴权后会再次启用。若上游端点本身不发起 OAuth challenge，页面会明确提示已直接连接，不会伪造登录页面。

---

## 架构

```
3CX 来电
  └─ WebSocket 事件 → call-store.ts（编排器）
       └─ qwen-realtime.ts → DashScope 全模态实时 WebSocket
            ├─ 音频 8 kHz → 上采样 16 kHz → 模型输入
            ├─ 工具调用 → tool-executor.ts
            │                ├─ 本地工具（转接/语音邮件/挂断/筛选）→ 路由
            │                └─ MCP 工具 → callMcpTool → 3CX MCP 服务器
            └─ 模型输出 → 下采样 24 kHz → 8 kHz → 呼叫者听到音频
```

无独立的 STT、LLM 或 TTS 流水线——实时模型端到端处理对话音频。

---

## 工具

### 本地工具（SDK 支持）

| 工具 | 功能 | 行为 |
|---|---|---|
| `transfer_call` | `participant.transfer(ext)` | 等待音频传输完成后转接，筛选未完成时阻止 |
| `drop_call` | `participant.drop()` | 等待音频传输完成（呼叫者听到再见），然后挂断 |
| `transfer_to_voicemail` | `participant.transferToVoiceMail(ext)` | 与转接相同的保护机制 |
| `update_screening` | 保存呼叫者的 `name`、`company` 或 `reason` | 仅在代理配置中启用 `callScreening` 时可用 |

### MCP 工具

MCP 服务器在启动时通过 `mcp-client.ts` 连接。其工具将被自动发现、转换为 DashScope 工具格式，并传递给实时会话。

```typescript
// index.ts
const mcpClient = await connectMcp(client.getMcpUrl(), client.createMcpAuthProvider());
const mcpToolDefs = await listMcpTools(mcpClient, allowedTools);
const mcpToolsQwen = mcpToolsToQwen(mcpToolDefs);
const mcpCaller = (name, args) => callMcpTool(mcpClient, name, args);

createCallStore(client, appconfig, mcpToolsQwen, mcpCaller);
```

### Zoho Desk 分阶段启用

`desk.enabled` 默认为 `false`。正式 Desk 组织授权并提供固定部门 ID 后，配置仅包含 `searchSolutions`、`getArticle`、`searchContacts`、`createContact`、`searchTickets`、`createTicket` 和初始化用的 `getDepartments`。应用只向模型暴露 `desk_search_knowledge` 与 `desk_create_support_ticket` 两个本地语义工具；原始 Desk 工具保持隐藏。

知识库查询失败与“没有匹配文章”是不同状态。只有已发布文章能完整回答问题时才直接答复；否则必须征得来电者同意并完成姓名、公司和事由筛选后，才能使用 3CX 来电号码创建电话回拨工单。同一通话内会复用已经创建的工单。

---

## 关键实现细节

### 配置

| 设置 | 说明 |
|---|---|
| `dashscopeApiKey` | 阿里云 DashScope API 密钥 |
| `dashscopeBaseUrl` | `https://dashscope-intl.aliyuncs.com`（新加坡）或 `https://dashscope.aliyuncs.com`（中国大陆）— **API 密钥与地区绑定**，请使用与密钥创建地区匹配的 URL |
| `realtimeModel` | 例如 `qwen3.5-omni-plus-realtime` |
| `realtimeVoice` | 语音（默认：`male-qn-qingse`）——`male-qn-qingse`、`female-shaonv`、`male-qn-jingying`、`female-tianmei` |
| `realtimeVadSilenceDurationMs` | 服务端 VAD 静音阈值（毫秒，可选，未指定时使用模型默认值） |
| `agentProfile` | 从 `agents/<name>.yaml` 加载代理人设 |
| `companyName` / `agentName` | 注入到系统提示中 |
| `saveAudioToFile` / `audioOutputDir` | 将呼叫者音频保存为 WAV 文件以供调试 |

### 音频流水线

| 阶段 | 格式 |
|---|---|
| 3CX 入站流 | PCM 8 kHz 16位单声道 |
| 千问实时输入 | PCM 16 kHz 16位单声道（线性插值 2:1 上采样） |
| 千问实时输出 | PCM 24 kHz 16位单声道 |
| 3CX 出站流 | PCM 8 kHz 16位单声道（3:1 抽取下采样） |

### 打断（Barge-In）

千问实时模型通过服务端 VAD 自动处理打断。当呼叫者开始说话时，模型停止生成音频，无需客户端打断逻辑。

---

## 项目结构

```
src/
├── index.ts                          # 入口 — 连接 3CX、MCP 初始化、启动呼叫存储
├── app-config.ts                     # 加载 config.yaml，导出 AppConfig 接口
└── callcontrol/
    ├── call-store.ts                 # 每通呼叫的编排器 — 连接实时桥接与工具执行器
    └── utils.ts                      # CallControl 状态辅助函数
└── providers/
    └── qwen-realtime.ts              # DashScope 全模态实时 WebSocket 桥接
└── agent/
    ├── agent-profiles.ts             # 加载 agents/<name>.yaml，渲染系统提示
    ├── tool-executor.ts              # 本地工具执行（转接、挂断、筛选）
    └── tools.ts                      # 千问格式的工具定义
└── mcp/
    ├── mcp-client.ts                 # MCP 客户端：连接、列出工具、调用工具
    └── mcp-to-qwen.ts                # 将 MCP 工具 schema 转换为 DashScope 格式
└── audio/
    └── audio-utils.ts                # PCM 辅助函数：8k→16k 上采样，24k→8k 下采样
└── logging/
    └── call-logger.ts                # 每通呼叫的对话日志记录器
```

`@3cx/call-control-sdk` 包提供 OAuth2 客户端、WebSocket 连接和 REST API 调用——这些不在本仓库范围内。

---

<p align="center">
  <sub>属于 <a href="../../README.md">Agentic Call Control</a> 示例集 · 基于 <a href="https://www.3cx.com">3CX</a> Call Control SDK 构建</sub>
</p>
