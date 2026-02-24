# Ragnar Backend (Placeholder)

A lightweight Express + WebSocket scaffold that mirrors the `voice-relay-server` contract and streams placeholder Ragnar responses. Use it to unblock local development before wiring up the real assistant stack.

## Features

- `/healthz` endpoint for readiness checks
- WebSocket endpoint at `/relay` with the same message contract as `voice-relay-server`
- Deterministic placeholder transcripts + responses so downstream clients can exercise streaming logic
- Emits `ready`, `transcript`, `text_delta`, `text_completed`, `audio_delta`, `response_completed`, and `error` events

## Environment Variables

| Name | Required | Description |
| --- | --- | --- |
| `RAGNAR_BACKEND_PORT` | ❌ | HTTP/WebSocket port (defaults to `5051`, falls back to `PORT`) |
| `RAGNAR_PROMPT` | ❌ | Persona text referenced when crafting placeholder responses |

Create a `.env` (optional):

```bash
RAGNAR_BACKEND_PORT=5051
RAGNAR_PROMPT="You are Ragnar, ..."
```

## Install & Run

```bash
cd services/ragnar-backend
npm install
npm run dev      # tsx live reload
# or
npm run build && npm start
```

## WebSocket Contract

The backend mirrors the relay contract. Connect to `ws://localhost:5051/relay` and exchange JSON payloads:

**Client → Server**
```jsonc
{ "type": "audio_chunk", "audio": "<base64 pcm16>" }
{ "type": "commit", "instructions": "optional per-turn override" }
{ "type": "text", "text": "manual text input" }
{ "type": "end" }
```

**Server → Client**
```jsonc
{ "type": "ready" }
{ "type": "transcript", "text": "placeholder transcript" }
{ "type": "text_delta", "text": "streamed Ragnar text" }
{ "type": "text_completed", "text": "full Ragnar reply" }
{ "type": "audio_delta", "audio": "<base64 pcm16 silence>" }
{ "type": "response_completed", "responseId": "resp_..." }
{ "type": "error", "error": "description" }
```

The placeholder assistant simply echoes what it heard and produces deterministic audio silence frames so you can validate downstream media pipelines.
