# Phone stack observability (foundation)

This repo’s phone stack is:

- `services/phone-bridge` (Twilio Media Streams ↔ relay)
- `services/voice-relay-server` (WS proxy ↔ backend)
- `services/ragnar-backend-v2` (ASR + response + optional TTS)

## Trace ID

Each call/turn is correlated with a `traceId`:

- In Twilio flows, `phone-bridge` seeds `traceId` from `callSid` (stable and already unique).
- `phone-bridge` sends `{type:"start", traceId, callSid, streamSid}` as the first message to the relay.
- Downstream services sniff/propagate `traceId` and include it in structured logs.

Use `traceId` to stitch logs across services.

## Log schema

All three services emit JSON lines to stdout.

Common fields:

- `t` ISO timestamp
- `level` (`debug` | `info` | `warn` | `error`)
- `msg` short event name
- `component` service name (`phone-bridge`, `voice-relay-server`, `ragnar-backend-v2`)
- `traceId` correlation id
- `stage` coarse lifecycle stage
- `ms` milliseconds since per-connection trace start

Service-specific fields may include:

- `callSid`, `streamSid` (Twilio identifiers)
- `sessionId` (`ragnar-backend-v2` WS session)
- `responseId`
- `audioInChunks`, `audioOutChunks`, `audioChunksIn`

## Stages (selected)

Phone-bridge:

- `twilio_start`
- `relay_ws_open`
- `relay_ready`
- `commit`
- `relay_response_completed`
- `teardown`

Voice relay server:

- `client_connected`
- `backend_ws_open`
- `backend_ws_error` / `backend_ws_closed`
- `client_ws_closed`

Ragnar backend v2:

- `ws_connected`
- `ready_sent`
- `start_received`
- `commit_received`
- `asr_start` / `asr_done`
- `llm_start` / `llm_done` (conversation core)
- `tts_start` / `tts_done`
- `response_completed`
- `ws_closed`

## Redaction / privacy

Logs are **best-effort redacted**:

- any fields named `audio`, `payload`, `pcm`, `pcm16`, `mulaw` are replaced with `"[REDACTED_AUDIO]"`
- long base64-looking strings are replaced with `"[REDACTED_BASE64]"`
- bearer tokens / api keys / generic `token=` patterns are masked

If you add new logging, do not log raw audio buffers or base64 payloads.

## How to interpret

Typical latency questions:

- Did the relay connect quickly?
  - `phone-bridge stage=relay_ws_open ms=...`
  - `phone-bridge stage=relay_ready ms=...`

- Is ASR slow?
  - `ragnar-backend-v2 stage=asr_start ms=...`
  - `ragnar-backend-v2 stage=asr_done ms=...`

- Is TTS slow or disabled?
  - `ragnar-backend-v2 stage=tts_done ms=...` (absent if TTS not configured)
  - `ragnar-backend-v2 msg=tts failed ...` for errors

- Did the call end cleanly?
  - `phone-bridge stage=teardown reason=...`
  - `voice-relay-server stage=client_ws_closed ...`
  - `ragnar-backend-v2 stage=ws_closed ...`
