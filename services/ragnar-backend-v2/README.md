# Ragnar Backend v2 (whisper.cpp + Piper)

Self-hosted Ragnar backend that terminates the `voice-relay-server` WebSocket contract and runs:

- **ASR:** `whisper.cpp` (PCM16@16kHz → transcript)
- **TTS:** `piper` (text → WAV) + `ffmpeg` resample to PCM16@16kHz

This is an intentionally simple *chunked* pipeline:

- Clients stream `audio_chunk` frames (20ms PCM16 recommended).
- On `commit`, the backend writes a WAV from the buffered PCM and runs Whisper once.
- It then generates a response (currently a minimal deterministic conversation core) and speaks it via Piper.

## Endpoints

- `GET /healthz` → readiness & config
- `WS /relay` → same JSON contract as `services/voice-relay-server`

## Environment

| Name | Required | Default | Notes |
|---|---:|---:|---|
| `RAGNAR_BACKEND_V2_PORT` | ❌ | `5052` | falls back to `PORT` |
| `WHISPER_CPP_BIN` | ❌ | `/opt/whispercpp/main` | whisper.cpp binary path |
| `WHISPER_MODEL_PATH` | ✅ | - | e.g. `/models/ggml-base.en.bin` |
| `PIPER_BIN` | ❌ | `/opt/piper/piper` | piper binary path |
| `PIPER_MODEL_PATH` | ✅ | - | `.onnx` model path |
| `PIPER_CONFIG_PATH` | ❌ | `${PIPER_MODEL_PATH}.json` | model config json |
| `FFMPEG_BIN` | ❌ | `ffmpeg` | used for resampling |
| `LOG_LEVEL` | ❌ | `info` | `debug|info|warn|error` |

Create a `.env`:

```bash
RAGNAR_BACKEND_V2_PORT=5052
WHISPER_MODEL_PATH=/models/ggml-base.en.bin
PIPER_MODEL_PATH=/models/en_US-lessac-medium.onnx
PIPER_CONFIG_PATH=/models/en_US-lessac-medium.onnx.json
```

## Run locally (without Docker)

You need:

- `whisper.cpp` built (providing `main`)
- a whisper ggml model
- `piper` + a piper model + config
- `ffmpeg`

```bash
cd services/ragnar-backend-v2
npm install
npm run dev

curl http://localhost:5052/healthz
```

## Docker

A Dockerfile is provided that builds whisper.cpp and downloads a piper release binary.
Models are **not** baked in by default (they are large). Mount them as a volume.

```bash
docker build -t ragnar-backend-v2 -f services/ragnar-backend-v2/Dockerfile .

docker run --rm -p 5052:5052 \
  -e RAGNAR_BACKEND_V2_PORT=5052 \
  -e WHISPER_MODEL_PATH=/models/ggml-base.en.bin \
  -e PIPER_MODEL_PATH=/models/en_US-lessac-medium.onnx \
  -v $(pwd)/models:/models \
  ragnar-backend-v2
```

## WebSocket contract

Same as the relay contract:

Client → server:

```jsonc
{ "type": "audio_chunk", "audio": "<base64 pcm16 frame>" }
{ "type": "commit", "instructions": "optional" }
{ "type": "text", "text": "manual text" }
{ "type": "end" }
```

Server → client:

```jsonc
{ "type": "ready" }
{ "type": "transcript", "text": "..." }
{ "type": "text_delta", "text": "..." }
{ "type": "text_completed", "text": "..." }
{ "type": "audio_delta", "audio": "<base64 pcm16 chunk>" }
{ "type": "response_completed", "responseId": "resp_..." }
{ "type": "error", "error": "..." }
```

## Quick end-to-end smoke test

1. Run backend v2 on `:5052`.
2. Run voice-relay-server on `:5050` with `RAGNAR_BACKEND_URL=ws://localhost:5052/relay`.
3. In another terminal:

```bash
cd services/ragnar-backend-v2
npm run simulate -- --relay ws://localhost:5050/relay --text "Hello Ragnar"
```
