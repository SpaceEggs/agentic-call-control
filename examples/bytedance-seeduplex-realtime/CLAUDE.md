# CLAUDE.md — bytedance-seeduplex-realtime example

ByteDance Seeduplex 3.0 duplex realtime — end-to-end voice over a **text JSON** WebSocket. No 1.0 binary frames. No separate STT/LLM/TTS pipeline.

## Commands

```bash
yarn start          # from examples/bytedance-seeduplex-realtime (tsx)
# or from repo root: yarn start:bytedance-seeduplex
yarn build          # tsc --noEmit
yarn lint
yarn test
```

## Architecture

```
3CX CallControlClient
  → callcontrol/call-store.ts (orchestrator)
  → providers/seeduplex-realtime.ts (Seeduplex 3.0 duplex WebSocket)
      ↔ providers/seeduplex-protocol.ts  (official 2026-08 demo payloads)
      ↔ providers/pcm-resampler.ts       (stateful 8k↔16k/24k)
      ↔ audio: 8k → 16k up | 24k down → 8k
      ↔ tools: agent/tool-executor.ts (local + MCP tools)
```

## Protocol evidence

- Payloads are locked to the official `go1.24_duplex_demo.zip` and
  `python3.7_duplex_demo.zip` retrieved on 2026-09-15.
- Tools are the `session.tools` array inside `session.create` / `session.update`.
- Tool results use one `conversation.item.create` event with `items[]` and
  `content:[{type:"input_text",text}]`.
- **Forbidden:** `/api/v3/realtime/dialogue`, binary headers, Bearer auth, silent 1.0 fallback,
  Qwen `response.create` / `function_call_output` envelopes as if they were Seeduplex.

See `docs/development/issue-2-p0-protocol-status.md` for source URLs, hashes,
and explicit Issue-vs-upstream differences.

## File structure

```
src/
├── index.ts                          # Entry: SDK client, MCP manager, call-store init
├── app-config.ts                     # loadAppConfig() + validateConfig (no import side effect)
├── callcontrol/call-store.ts         # Per-call orchestrator
├── providers/
│   ├── seeduplex-realtime.ts         # Bridge: lifecycle, audio, barge-in, tools, routing lock
│   ├── seeduplex-protocol.ts         # Endpoint/headers/event names + payload builders
│   └── pcm-resampler.ts              # Stateful conversion, anti-aliasing, 20 ms packetization
├── agent/                            # Screening, allowlist, executor, registry (from Qwen template)
├── logging/call-logger.ts
test/
├── protocol.test.ts                  # Endpoint, headers, event names, items[] parsing
├── pcm-resampler.test.ts             # Chunk consistency, 1s sample counts, reset
├── config.test.ts                    # T01 validation, no Qwen credentials
└── bridge.test.ts                    # Mock WS: ready gating, barge-in, tools, stop
```

## Constraints

- Keep 3CX MCP OAuth / `mcp:auth` flow untouched.
- Do not reintroduce DashScope fields (`dashscopeApiKey`, `gummy-realtime-v1`, Qwen VAD).
- Keep protocol shapes aligned with the recorded official demo evidence.
- `stop()` is idempotent; late events after stop must not revive the bridge.
- **Barge-in must not call `audioWriter.cancel()`** (SDK ^0.1.10: permanent sink
  death). Use `clear()` + `cancelStreamQueue()`; `cancel()` only on `stop()`.
- Tool drain is single-flight; overlapping `arguments.done` batches queue, never parallelize.
- Route actions: `idle → in_progress → terminated|idle(fail)`; failure releases the lock.
