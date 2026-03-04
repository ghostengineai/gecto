# Voice Relay Server

Prototype Node.js relay that accepts duplex audio streams from any client and proxies them into an agent backend over WebSockets (Ragnar, OpenClaw, or custom). Clients keep the same interface (audio/text in; transcripts + synthesized audio out) while the backend can evolve independently.

## Features

- **WebSocket relay (`/relay`)** – clients push microphone audio frames (`base64` PCM16) and receive live transcripts plus synthesized audio chunks.
- **Pluggable backend** – every client session maps 1:1 to a backend WebSocket (default `services/ragnar-backend`) so you can swap placeholder + production assistants without touching clients.
- **Agent-agnostic** – backend handles persona + response style; relay simply forwards events with minimal latency.
- **Graceful fan-out** – text deltas, completed responses, and audio deltas are streamed to the caller immediately.
- **Health endpoint** – `GET /healthz` confirms readiness and surfaces the configured backend URL.

## Requirements

| Dependency | Notes |
| --- | --- |
| Node.js 20+ | Required for native `fetch` + `WebSocket` support |
| npm | For dependency management |
| Agent backend | Defaults to `ws://localhost:5051/relay` (see `services/ragnar-backend`) |

## Environment Variables

| Name | Required | Description |
| --- | --- | --- |
| `VOICE_RELAY_PORT` | ❌ | HTTP/WebSocket port (default `5050`; falls back to `PORT`) |
| `OPENCLAW_AGENT_URL` | ❌ | Preferred WebSocket URL for your OpenClaw/backend agent |
| `AGENT_BACKEND_URL` | ❌ | Generic WebSocket URL for the backend |
| `RAGNAR_BACKEND_URL` | ❌ | Backward-compatible backend URL name (default `ws://localhost:5051/relay`) |

Create a `.env` file:

```bash
VOICE_RELAY_PORT=5050
OPENCLAW_AGENT_URL=ws://localhost:5051/relay
```

## Install & Run

```bash
cd services/voice-relay-server
npm install
npm run dev      # tsx live reload
# or
npm run build && npm start
```

`GET http://localhost:5050/healthz` → `{ "ok": true, "backend": "ws://localhost:5051/relay" }`

## Observability

`voice-relay-server` emits structured JSON logs and attempts to preserve a `traceId` across the proxy boundary.

- If the client sends `{type:"start", traceId}` or includes `traceId` on other messages, the relay will adopt it.
- Otherwise, it generates a random `traceId`.

See `docs/phone/observability.md`.

## WebSocket Contract

Clients still connect to `ws://localhost:5050/relay` and exchange JSON payloads.

### Client → Server messages

```jsonc
{ "type": "audio_chunk", "audio": "<base64 pcm16 frame>" }
{ "type": "commit" }                        // Flush current audio buffer and trigger an agent reply
{ "type": "commit", "instructions": "..." } // Optional per-turn override
{ "type": "text", "text": "manual text input" }
{ "type": "end" }                            // Close session
```

### Server → Client events

```jsonc
{ "type": "ready" }
{ "type": "transcript", "text": "partial user transcript" }
{ "type": "text_delta", "text": "partial assistant text" }
{ "type": "text_completed", "text": "full assistant reply" }
{ "type": "audio_delta", "audio": "<base64 pcm16 chunk>" }
{ "type": "response_completed", "responseId": "resp_..." }
{ "type": "error", "error": "Something went wrong" }
```

The relay simply forwards messages/events between the client and whichever backend you configure.

## How It Works

1. Each browser/SDK client connects to `/relay`; the server immediately establishes a matching WebSocket to your configured agent backend (default `services/ragnar-backend`).
2. Incoming client payloads are forwarded as-is to the backend.
3. Backend events (`ready`, `transcript`, `text_delta`, etc.) are streamed back to the client without modification.
4. If either side closes or errors, the relay gracefully tears down the paired connection and notifies the client.

## Next Steps

- Add auth (API keys or JWT) before exposing publicly.
- Persist transcripts (stream them into Supabase/Postgres).
- Support multiple downstream agent sessions per tenant by mapping connections to user IDs.
- Swap the placeholder backend (`services/ragnar-backend`) with the real assistant stack once ready.

## Troubleshooting

| Symptom | Likely Cause |
| --- | --- |
| `error: Unable to reach agent backend` | Backend not running or wrong `OPENCLAW_AGENT_URL` / `AGENT_BACKEND_URL` |
| Connection immediately closes | Backend closed its socket or crashed |
| Choppy audio | Client must send consistent 20ms PCM16 frames and play deltas via `AudioWorklet` |
