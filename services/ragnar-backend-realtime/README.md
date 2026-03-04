# Ragnar Backend (OpenAI Realtime)

Backend that terminates the `voice-relay-server` WebSocket contract and uses the OpenAI Realtime API for low-latency:

- speech recognition (caller → transcript)
- response generation (LLM)
- speech synthesis (Ragnar voice)

It speaks the same JSON contract as `services/ragnar-backend` and `services/ragnar-backend-v2` so you can swap implementations without changing the relay or phone bridge.

## Endpoints

- `GET /healthz`
- `WS /relay`

## Environment variables

| Name | Required | Default | Notes |
|---|---:|---:|---|
| `RAGNAR_BACKEND_REALTIME_PORT` | ❌ | `5053` | falls back to `PORT` |
| `OPENAI_API_KEY` | ✅ | - | used to connect to Realtime |
| `OPENAI_REALTIME_URL` | ❌ | `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview` | override if needed |
| `REALTIME_VOICE` | ❌ | `alloy` | voice name/id (provider-dependent) |
| `REALTIME_INSTRUCTIONS` | ❌ | persona/system instructions |
| `RELAY_INPUT_SAMPLE_RATE` | ❌ | `16000` | should match `phone-bridge` |
| `RELAY_OUTPUT_SAMPLE_RATE` | ❌ | `24000` | should match `phone-bridge` |

## Run

```bash
cd services/ragnar-backend-realtime
npm install
npm run dev

curl http://localhost:5053/healthz
```

## Hooking up the relay

Run `voice-relay-server` pointing at this backend:

```bash
RAGNAR_BACKEND_URL=ws://localhost:5053/relay \
VOICE_RELAY_PORT=5050 \
npm run dev
```

Then run `phone-bridge` pointing at the relay:

```bash
VOICE_RELAY_URL=ws://localhost:5050/relay \
PORT=5060 \
# plus PUBLIC_BASE_URL / TWILIO_* for real calls
npm run dev
```

## Notes

- This implementation is intentionally tolerant to Realtime event schema drift; it best-effort maps common `response.*` event types into the relay contract (`text_delta`, `audio_delta`, etc.).
- If OpenAI changes event names, update the switch in `src/server.ts`.
