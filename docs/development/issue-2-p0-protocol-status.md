# Issue #2 P0 — Seeduplex 3.0 protocol verification

Date: 2026-09-15  
Branch: `feature/bytedance-seeduplex-realtime`  
Baseline: `origin/Dev` @ `ca5e5d8ae21c12a2f8a6c4a038d07838f487fcca`

## Status

The text-JSON wire contract is verified against the official API document and
both official demo archives. Mock integration tests lock the verified payloads.
Live 3CX-to-Seeduplex acceptance still requires provisioned credentials and an
actual PBX call.

## Sources

Retrieved from the official Volcengine document API on 2026-09-15:

- [Full-duplex API document](https://www.volcengine.com/docs/6561/2549778)
- [Integration guide](https://www.volcengine.com/docs/6561/2549732)
- `go1.24_duplex_demo.zip`
  - Official download: `https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_623b7ef30ec3660a806e92bde33d05d8.zip`
  - SHA-256: `417791341ecae230b369d9d1e9ee2b2c52557e17167e3e4d53b13b45f807b971`
  - Key files: `events.go`, `client_request.go`, `function_call.go`, `main.go`
- `python3.7_duplex_demo.zip`
  - Official download: `https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_148ee77d3245e465d244b912d1e83c91.zip`
  - SHA-256: `bcd9a6a8b4672bc25057dab06c4425a791dfac79f17c2421c251b0916eccf7c0`
  - Key files: `realtime_client.py`, `main.py`, `tools.py`, `config.py`

The archives are evidence only and are not committed because they contain
unrelated binaries and platform metadata. Their verified payload shapes are
covered by `test/protocol.test.ts` and `test/bridge.test.ts`.

## Verified contract

| Area | Verified behavior |
| --- | --- |
| Transport | `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`, WebSocket text JSON |
| Authentication | Official demos use `X-Api-Key` (or Bearer as an alternative) |
| Session | `session.create` carries `event_id`, `session`, and `extension`; ready ack is `session.created` |
| Audio config | `session.audio.input.format={type:"pcm",rate:16000}`; output is `{type:"pcm_s16le",rate:24000}` plus `voice` |
| Tools | Function definitions are the `session.tools` array inside `session.create` / `session.update` |
| Uplink | `input_audio_buffer.append.audio`; recommended 20 ms / 640-byte PCM frames |
| Downlink | `response.output_audio.delta.delta` contains Base64 audio |
| Greeting | `speech_text_buffer.commit` accepts `event_id`, optional `speech_id`, and `text` |
| Tool calls | `response.function_call_arguments.done.items[]`; `arguments` is JSON text |
| Tool results | One `conversation.item.create` with `items[]`; each item has `type:"message"`, `role:"tool"`, matching `call_id`, and `content:[{type:"input_text",text}]` |
| Continue after tools | The server continues generation after tool results; no client `response.create` is required |
| Interrupt | Client sends `response.cancel`; server acknowledges with `response.canceled` |
| Shutdown | Client sends `session.close`; server acknowledges with `session.closed` |
| Errors | Nested `error.{type,code,message,param,event_id}` |

## Issue/document differences

1. Issue #2 describes `session.tools` as an event. The official contract defines
   `tools` as an array inside `session.create` or `session.update`; the
   implementation follows the official contract.
2. Issue #2 requires both `X-Api-Key` and `X-Api-App-Id`. The official demos only
   require `X-Api-Key` (or Bearer). The implementation retains `X-Api-App-Id`
   because it is an explicit issue/config requirement and sends `X-Api-Key` in
   the official form.
3. Issue #2 fixes model `1.2.6.0`; the 2026-08 official demos use `1.2.6.1`.
   The example keeps `1.2.6.0` as its default to meet the issue contract, while
   allowing `realtimeModel` to be overridden for the version enabled on an account.
4. Issue #2 says to call `audioWriter.cancel()` for barge-in. In 3CX SDK 0.1.10,
   `cancel()` permanently stops that writer. The implementation uses
   `audioWriter.clear()` plus `participant.cancelStreamQueue()` so playback stops
   immediately and the next model reply remains audible; `cancel()` is reserved
   for final bridge shutdown.

## Validation boundary

Automated tests prove payload shape, lifecycle, 8/16/24 kHz byte counts,
20 ms packetization, cross-chunk state, basic anti-alias suppression, function
call batching/deduplication/name restoration, barge-in recovery, routing locks,
and idempotent cleanup. They do not prove account entitlement, WAN behavior,
model quality, or PBX media behavior. Those require the live checklist in the
example README.

## Live API smoke verification (2026-09-15)

Using an API key supplied directly to the test process through stdin (never
written to a file, config, or Git object), the official endpoint completed
these checks with model `1.2.6.0`:

- `X-Api-Key` only: `session.created`, greeting audio, `response.done`, and
  `session.closed` all received; 113,376 decoded PCM bytes were returned.
- `X-Api-Key` plus a synthetic `X-Api-App-Id`: the same lifecycle completed;
  125,034 decoded PCM bytes were returned. This confirms the issue-required
  extra header does not prevent authentication.
- Official `whoareyou.wav` (16 kHz mono PCM, SHA-256
  `f349a9546fb020be250370cbe16b674ee0bc51e8965e1b5979d5b2c123efd985`):
  ASR started/delta/completed, `response.function_call_arguments.done`, batched
  tool-result upload, continued text/audio response, `response.done`, and
  `session.closed` all completed. The post-tool response contained 201,786
  decoded PCM bytes.

The live event trace also showed that completed ASR text can be empty while its
delta events contain the transcript. The bridge therefore accumulates official
ASR deltas and `response.output_text.*` events, with completed text taking
precedence when present.
