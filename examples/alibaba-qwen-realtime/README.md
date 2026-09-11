# Agentic Call Control — Alibaba Qwen Realtime

An AI voice agent that connects to a **3CX PBX** via the CallControl SDK and uses **Alibaba Cloud DashScope Qwen Omni Realtime** — a single WebSocket connection for end-to-end voice conversation with no separate STT/LLM/TTS pipeline.

---

## Prerequisites

### 3CX Service Principal

Create API credentials so the agent can control calls on your PBX:

1. Open your 3CX Web Client
2. Go to **Admin → Integrations → API**
3. Click **Add Service Principal**
4. Set a **Client ID** (e.g. `assistant`) — this becomes your `appId`
5. Enable **"Enable access to the 3CX Call Control API for this application"**
6. *(Optional)* Assign a **DID Number** (the phone number callers will dial)
7. *(Optional)* Click **Select Extensions** to choose which extensions the agent can control
8. **Save** — the generated Client Secret becomes your `appSecret`

### DashScope API Key

Get an API key from the [Alibaba Cloud DashScope Console](https://dashscope.console.aliyun.com/).

> **Note:** DashScope API keys are region-locked. Keys from the mainland China console require `dashscopeBaseUrl: https://dashscope.aliyuncs.com`; keys from the international (Singapore) console use `https://dashscope-intl.aliyuncs.com`. Using the wrong endpoint will cause authentication failures.

---

## Quick Start

From the repo root, copy the config:

```bash
cp examples/alibaba-qwen-realtime/config.yaml.example examples/alibaba-qwen-realtime/config.yaml
```

Fill in your credentials — open `examples/alibaba-qwen-realtime/config.yaml`:

```yaml
# 3CX Service Principal — Web Client → Admin → Integrations → API
appId: your-client-id       # Service Principal Client ID
appSecret: your-client-secret  # Service Principal API key
pbxBase: https://your-pbx.3cx.eu:5001  # Your PBX FQDN

# Alibaba DashScope API key — https://dashscope.console.aliyun.com/
dashscopeApiKey: sk-your-dashscope-api-key
dashscopeBaseUrl: https://dashscope-intl.aliyuncs.com  # API keys are region-locked — use https://dashscope.aliyuncs.com for mainland China keys
realtimeModel: qwen3.5-omni-plus-realtime
realtimeVoice: male-qn-qingse  # male-qn-qingse | female-shaonv | male-qn-jingying | female-tianmei
realtimeVadSilenceDurationMs: 800  # Server-side VAD silence threshold (optional)

# Agent profile — loads from agents/<name>.yaml
agentProfile: receptionist
companyName: Your Company
agentName: Assistant
```

Then start from the repo root:

```bash
yarn start:qwenalibaba
```

`yarn start:alibaba-qwen` remains an equivalent alias.

## Administration dashboard exposure modes

The Qwen process provides a Chinese administration page with Overview, Logs, MCP, and Certificates tabs. Choose one `admin.mode`:

- `https` (default) serves HTTPS directly with a custom domain and a lego-managed certificate.
- `tailscale-funnel` serves plaintext HTTP only on `127.0.0.1` and publishes the entire dashboard through Tailscale Funnel, which supplies the public `*.ts.net` hostname and HTTPS certificate.

For direct HTTPS, install **lego v5.0.4**, create two mode-`0600` files containing a dedicated Alibaba Cloud DNS RAM access key and secret, configure `admin.publicBaseUrl` and `admin.tls`, then run:

```bash
export ALICLOUD_ACCESS_KEY_FILE=/secure/alidns-access-key
export ALICLOUD_SECRET_KEY_FILE=/secure/alidns-secret-key
yarn cert:init:qwenalibaba
yarn start:qwenalibaba
```

For Tailscale Funnel, no custom domain, lego binary, or Alibaba Cloud credential is required:

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

When `tailscaleFunnel.publicBaseUrl` is omitted, the process reads `Self.DNSName` from `tailscale status --json`. It starts `tailscale funnel` in background mode, proxies the complete dashboard to its loopback-only HTTP listener, and removes the Funnel on graceful shutdown by default. Tailscale must already be logged in, Funnel must be permitted by the tailnet policy, and the process user must be allowed to run the Tailscale CLI without an interactive privilege prompt.

The dashboard and OAuth callback are available at `https://<node>.<tailnet>.ts.net/` and `https://<node>.<tailnet>.ts.net/api/mcp/oauth/callback`. Funnel ports `443`, `8443`, and `10000` are supported. Set `stopOnExit: false` only when Funnel lifecycle is managed outside this process.

The dashboard intentionally has no application login or IP allowlist. In `tailscale-funnel` mode, anyone on the Internet who knows or discovers the URL can read call/tool logs and operate MCP authorization.

### MCP authorization behavior

- `streamable-http` is the default and supports remote browser OAuth through the dashboard.
- `mcp-remote` is pinned to `0.1.38` and runs as a local stdio compatibility process with an isolated cache per server. Dashboard OAuth registers the public dashboard callback and forwards the completed callback to the loopback `mcp-remote` process.
- Deauthorizing also disables the server, preventing an endpoint that permits credential-free access from reconnecting automatically. Authorizing re-enables it; when the endpoint does not issue an OAuth challenge, the dashboard reports that it connected directly instead of opening a provider page.
- Saving normal MCP configuration uses a new connection generation: current calls finish on the old connection and new calls receive the new tool snapshot. Disabling or deauthorizing a server blocks it immediately.
- Zoho **Authorization via Connection** remains an upstream Zoho Super Admin operation. The dashboard controls the MCP client token and shows the Zoho console link separately.
- MCP URLs and bearer tokens are write-only in the API. Runtime edits are stored in `data/admin-state.json`; credentials are stored separately under `data/secrets`, all with mode `0600`.

### Calling the Agent

Once the agent is running, there are two ways to reach it on your 3CX PBX:

- **Internal call** — from any registered 3CX extension (desk phone, web client, or mobile app), dial the **Client ID** (the `appId` you configured, e.g. `assistant`). The PBX routes the call directly to the agent.
- **External call (DID)** — if you assigned a DID number to the Service Principal (step 6 above), callers can dial that phone number from any external line to reach the agent.

---

## Architecture

```
Incoming call on 3CX
  └─ WebSocket event → call-store.ts (orchestrator)
       └─ qwen-realtime.ts → DashScope Omni Realtime WebSocket
            ├─ audio 8 kHz → upsample 16 kHz → model input
            ├─ tool calls → tool-executor.ts
            │                ├─ local tools (transfer/voicemail/drop/screening) → routing
            │                └─ MCP tools → callMcpTool → 3CX MCP server
            └─ model output → downsample 24 kHz → 8 kHz → caller hears audio
```

No separate STT, LLM, or TTS pipeline — the realtime model handles conversation audio end-to-end.

---

## Tools

### Local Tools (SDK-backed)

| Tool | What it does | Behavior |
|---|---|---|
| `transfer_call` | `participant.transfer(ext)` | Waits for audio drain, then transfers. Blocked if screening incomplete. |
| `drop_call` | `participant.drop()` | Waits for audio drain (caller hears goodbye), then drops |
| `transfer_to_voicemail` | `participant.transferToVoiceMail(ext)` | Same guards as transfer |
| `update_screening` | Saves caller `name`, `company`, or `reason` | Only available when `callScreening` is enabled in the agent profile |

### MCP Tools

MCP is managed by a long-lived `McpRuntimeManager`. 3CX tools are discovered and passed to the realtime session, while optional custom servers can be reconfigured and reauthorized without restarting the phone process. Enable tools in `agents/<profile>.yaml` by listing exact names under `mcpTools`.

```typescript
// index.ts — 3CX MCP + optional custom MCP, filtered by profile.mcpTools
const filtered = filterMcpTools(toolsResult.tools, profile?.mcpTools);
const customMcpRuntime = new McpRuntimeManager(customServers, profile?.mcpTools);
await customMcpRuntime.initialize();
```

### Staged Zoho Desk enablement

`desk.enabled` defaults to `false`. After the target Desk organization is authorized and supplies a fixed department ID, configure only `searchSolutions`, `getArticle`, `searchContacts`, `createContact`, `searchTickets`, `createTicket`, and the setup-only `getDepartments`. The model sees only the local semantic tools `desk_search_knowledge` and `desk_create_support_ticket`; raw Desk operations remain hidden.

A knowledge lookup failure is distinct from a genuine no-match. The agent answers only from a published article that fully resolves the question. Otherwise it must obtain explicit consent and complete caller screening before creating a phone-callback ticket from the 3CX caller number. A ticket created during the current call is reused on repeated tool calls.

---

## Key Implementation Details

### Configuration

| Setting | Notes |
|---|---|
| `dashscopeApiKey` | Your Alibaba Cloud DashScope API key |
| `dashscopeBaseUrl` | `https://dashscope-intl.aliyuncs.com` (Singapore) or `https://dashscope.aliyuncs.com` (mainland China) — **API keys are region-locked**; use the URL matching where your key was created |
| `realtimeModel` | e.g. `qwen3.5-omni-plus-realtime` |
| `realtimeVoice` | Voice (default: `male-qn-qingse`) — `male-qn-qingse`, `female-shaonv`, `male-qn-jingying`, `female-tianmei` |
| `realtimeVadSilenceDurationMs` | Server-side VAD silence threshold in milliseconds (optional, model uses default if not specified) |
| `agentProfile` | Loads agent persona from `agents/<name>.yaml` |
| `companyName` / `agentName` | Injected into the system prompt |
| `saveAudioToFile` / `audioOutputDir` | Save caller audio as WAV files for debugging |

### Audio Pipeline

| Stage | Format |
|---|---|
| 3CX inbound stream | PCM 8 kHz 16-bit mono |
| Qwen Realtime input | PCM 16 kHz 16-bit mono (upsampled 2:1 via linear interpolation) |
| Qwen Realtime output | PCM 24 kHz 16-bit mono |
| 3CX outbound stream | PCM 8 kHz 16-bit mono (downsampled 3:1 via decimation) |

### Barge-In

The Qwen Realtime model handles barge-in automatically via server-side VAD. When the caller starts speaking, the model stops generating audio. No explicit client-side barge-in logic is needed.

---

## Project Structure

```
src/
├── index.ts                          # Entry point — connects to 3CX, MCP init, starts call store
├── app-config.ts                     # Loads config.yaml, exports AppConfig interface
└── callcontrol/
    ├── call-store.ts                 # Per-call orchestrator — wires realtime bridge, tool executor
    └── utils.ts                      # CallControl state helpers
└── providers/
    └── qwen-realtime.ts              # DashScope Omni Realtime WebSocket bridge
└── agent/
    ├── agent-profiles.ts             # Loads agents/<name>.yaml, renders system prompt
    ├── tool-executor.ts              # Local tool execution (transfer, drop, screening)
    └── tools.ts                      # Tool definitions for Qwen format
└── mcp/
    ├── mcp-client.ts                 # MCP client: connect, listTools, callTool
    └── mcp-to-qwen.ts                # Converts MCP tool schemas to DashScope format
└── audio/
    └── audio-utils.ts                # PCM helpers: upsample 8k→16k, downsample 24k→8k
└── logging/
    └── call-logger.ts                # Per-call conversation logger
```

The `@3cx/call-control-sdk` package provides the OAuth2 client, WebSocket connection, and REST API calls — these are not part of this repo.

---

<p align="center">
  <sub>Part of the <a href="../../README.md">Agentic Call Control</a> examples · Built with <a href="https://www.3cx.com">3CX</a> Call Control SDK</sub>
</p>
