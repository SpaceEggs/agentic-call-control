# Agentic Call Control — ByteDance Seeduplex Realtime (3.0 duplex)

An AI voice agent that connects to a **3CX PBX** via the CallControl SDK and uses **ByteDance Seeduplex 3.0** (豆包实时语音) over a **text JSON duplex WebSocket**. STT, reasoning, and TTS stay in one continuous bidirectional audio stream.

> **Protocol status (2026-09-15):** Payloads are verified against the official `go1.24_duplex_demo.zip`, `python3.7_duplex_demo.zip`, and API document. Live-call acceptance still requires provisioned 3CX and Volcengine credentials. See `docs/development/issue-2-p0-protocol-status.md`.
>
> This example uses the **3.0 text JSON** API only. Do **not** fall back to the Seeduplex **1.0 binary** protocol if you see 403 / permission errors.

---

## Prerequisites

### 3CX Service Principal

1. Open your 3CX Web Client
2. **Admin → Integrations → API → Add Service Principal**
3. Set a **Client ID** (e.g. `assistant`) — this becomes `appId`
4. Enable **Call Control API** access
5. *(Optional)* Assign a DID and controlled extensions
6. **Save** — the generated secret becomes `appSecret`

### Volcengine / Doubao speech credentials

1. Open the Volcengine Doubao speech console
2. Create or select an app; copy **APP ID** → `volcAppId` and **API Key** → `volcApiKey`
3. Seeduplex **3.0 duplex** access may require invitation / enablement
4. **403 / permission denied means enable 3.0 access** — switching to a 1.0 endpoint is not a valid workaround

`appId` (3CX) and `volcAppId` (Volcengine) are different fields and must not be swapped.

---

## Quick Start

From the repo root:

```bash
cp examples/bytedance-seeduplex-realtime/config.yaml.example examples/bytedance-seeduplex-realtime/config.yaml
```

Fill in credentials in `examples/bytedance-seeduplex-realtime/config.yaml`:

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
```

Start from the **repository root**:

```bash
yarn install
yarn start:bytedance-seeduplex
```

---

## Configuration reference

| Field | Required | Notes |
| --- | --- | --- |
| `appId` / `appSecret` / `pbxBase` | yes | 3CX service principal |
| `volcAppId` / `volcApiKey` | yes | Volcengine Seeduplex credentials |
| `realtimeModel` | no | Version string, default `1.2.6.0` |
| `realtimeVoice` | no | Fallback voice; profile `voice` wins |
| `agentProfile` | recommended | `receptionist_cn` or `receptionist_en` |
| `customMcpServers` | no | Extra MCP servers (none / bearer / oauth) |

Custom MCP OAuth uses the existing `yarn mcp:auth` flow (authorization_code). Seeduplex WebSocket auth is independent of MCP OAuth.

---

## Audio path

```
3CX PCM 8 kHz  → upsample 2× → 16 kHz Base64 → input_audio_buffer.append
Seeduplex PCM 24 kHz Base64 → downsample 3× → 8 kHz → 3CX audioWriter
```

Mono 16-bit little-endian. Uplink is packetized into the official recommended
20 ms / 640-byte frames. Resamplers preserve cross-frame state and the downlink
uses a small anti-alias filter before 3:1 decimation.

Barge-in: on `conversation.item.input_audio_transcription.started` the agent
clears the writer, cancels the PBX stream queue, and sends `response.cancel`.
`audioWriter.cancel()` is reserved for final shutdown because SDK 0.1.10 makes
that writer permanently unwritable. Late deltas for the cancelled response are dropped.

---

## Tools and routing

- Tool schema provider: `seeduplex` (initial design aliases the OpenAI profile; keeps integer/boolean types)
- Namespaced MCP tools are sanitized on the wire and restored before `executeTool`
- Local actions (`transfer_call`, `drop_call`, `transfer_to_voicemail`) reuse the Qwen example screening / allowlist / availability rules
- First version does **not** auto-replay tools or rebuild the dialog after disconnect

---

## Tests

```bash
yarn workspace @3cx-examples/bytedance-seeduplex-realtime test
yarn workspace @3cx-examples/mcp test
```

Automated tests lock official payload shapes, 20 ms packetization, resampling,
lifecycle, barge-in recovery, tool batching/deduplication/name restoration, and
routing locks.

### Live validation checklist

1. Start with a provisioned Seeduplex 3.0 API key and confirm `session.created`.
2. Place an incoming 3CX call and verify one greeting, continuous caller audio,
   and audible 24 kHz → 8 kHz playback.
3. Invoke one local tool and one 3CX MCP tool; verify matching `call_id` values
   and a single batched `conversation.item.create` result.
4. Interrupt playback and confirm it stops immediately, then confirm the next
   response remains audible.
5. Exercise transfer success, transfer failure/retry, voicemail, and drop while
   checking that only one terminal route action is executed.
6. Hang up from each side and confirm `session.close`, listener removal, and no
   late audio or tool result writes.
7. Run a 15-minute soak call while watching WebSocket and playback buffer warnings.

Mock tests do not prove account entitlement, WAN behavior, or real PBX media.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Missing config fields error | Fill `volcAppId` / `volcApiKey` / 3CX credentials |
| WebSocket 401/403 | Wrong key or no 3.0 duplex permission — do not switch to 1.0 |
| No greeting / no audio | Session never reached ready (check session.create ack logs) |
| Tool not called | Name not in profile `mcpTools` or collision rejected |
| Model rejected | The current official demo uses `1.2.6.1`; override `realtimeModel` with the version enabled for your account |
| English voice wrong | Select an English-capable voice enabled for the account |

---

## Related docs

- Product: https://seed.bytedance.com/zh/seeduplex
- API (JS-gated; may need login): https://www.volcengine.com/docs/6561/2549778
- Access guide: https://www.volcengine.com/docs/6561/2549732
- P0 status in this repo: `docs/development/issue-2-p0-protocol-status.md`
