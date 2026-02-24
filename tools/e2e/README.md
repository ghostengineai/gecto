# E2E harnesses

Small, dependency-free scripts to smoke-test the `/relay` WebSocket contract.

## ws-relay-smoke.mjs

Validates the minimal contract:

- Connects to `WS /relay`
- Expects `{ type: "ready" }`
- Sends a text turn (`{type:"text"}` + `{type:"commit"}`)
- Expects at least one of:
  - `{ type: "text_delta" }` or `{ type: "text_completed" }`
- If any `{ type: "audio_delta" }` events arrive, decodes them and writes a PCM16 mono 16kHz WAV file.
- Expects `{ type: "response_completed" }` (preferred) or times out after an idle window.

### Local

```bash
# terminal A
cd services/ragnar-backend-v2 && npm i && npm run dev

# terminal B
cd services/voice-relay-server && npm i && RAGNAR_BACKEND_URL=ws://localhost:5052/relay npm run dev

# terminal C (repo root)
node tools/e2e/ws-relay-smoke.mjs \
  --relay ws://localhost:5050/relay \
  --text "hello" \
  --out /tmp/ragnar-audio.wav
```

### Render (staging)

```bash
node tools/e2e/ws-relay-smoke.mjs \
  --relay wss://<YOUR-RENDER-HOST>/relay \
  --text "hello from staging" \
  --out /tmp/ragnar-audio.wav
```

Notes:
- `--out` is optional; it will only write a WAV if `audio_delta` is observed.
- Requires Node.js 20+ (for global `WebSocket`).

## ws-relay-replay-wav.mjs

Replays a WAV (mono, PCM16) into `/relay` as a stream of `{type:"audio_chunk"}` frames.

This is the foundation for "golden call" regression checks: keep a stable input WAV and inspect the resulting transcript / response.

```bash
node tools/e2e/ws-relay-replay-wav.mjs \
  --relay ws://localhost:5050/relay \
  --wav ./path/to/input-16k-mono.wav \
  --commit \
  --out /tmp/golden-run.json
```

Notes:
- The script expects 16kHz mono PCM16 by default. Override with `--rate` if needed.
- The run report includes `traceId` which can be correlated across phone-bridge → voice-relay-server → ragnar-backend-v2 logs.
