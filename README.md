# Voice Bridge App

Next.js client for the Ragnar voice bridge. It now streams audio through the local `services/voice-relay-server` via WebSockets, letting browsers participate in the same relay used by the phone + PSTN bridges.

## Getting Started

### Local dev

```bash
# Terminal 1 – relay (streams audio to OpenAI)
cd services/voice-relay-server
npm install
npm run dev

# Terminal 2 – Next.js client
cd projects/voice-bridge-app
npm install
npm run dev
```

Set `NEXT_PUBLIC_VOICE_RELAY_URL` (or rely on the default `ws://localhost:5050/relay`), open [http://localhost:3000](http://localhost:3000), and click **Connect**. Grant mic permission once and you’ll have a live, full-duplex call through the relay. Use **Hang Up** to end the session.

### Environment variables

| Variable | Scope | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_VOICE_RELAY_URL` | client | WebSocket URL for `voice-relay-server` (default `ws://localhost:5050/relay`) |
| `NEXT_PUBLIC_VOICE_RELAY_TOKEN` | client (optional) | Token appended as `?token=...` for relays that require auth |
| `NEXT_PUBLIC_RELAY_INPUT_SAMPLE_RATE` | client (optional) | Sample rate sent to relay (default `16000`) |
| `NEXT_PUBLIC_RELAY_OUTPUT_SAMPLE_RATE` | client (optional) | Sample rate expected from relay audio (default `24000`) |
| `NEXT_PUBLIC_RELAY_CHUNK_MS` | client (optional) | Size of PCM chunks forwarded to relay (default `20` ms) |
| `NEXT_PUBLIC_VAD_THRESHOLD` | client (optional) | RMS threshold for detecting speech (default `0.012`) |
| `NEXT_PUBLIC_COMMIT_SILENCE_MS` | client (optional) | Silence duration before auto `commit` (default `900` ms) |
| `NEXT_PUBLIC_MIN_COMMIT_MS` | client (optional) | Minimum audio duration (ms) required before sending a commit (default `100`) |
| `BASIC_AUTH_USERNAME` | edge (middleware) | Username required to load the app |
| `BASIC_AUTH_PASSWORD` | edge (middleware) | Password required to load the app |

If the BASIC auth vars are unset, the app is public; set them before deploying so only you can connect.

## Voice Relay Workflow

1. **Browser ↔ relay WebSocket**: `src/app/page.tsx` opens `NEXT_PUBLIC_VOICE_RELAY_URL`, queues microphone PCM16 frames (`audio_chunk`), and listens for Ragnar transcripts + audio.
2. **PCM capture**: the mic stream runs through the Web Audio API. Samples are converted to `Int16`, resampled to `NEXT_PUBLIC_RELAY_INPUT_SAMPLE_RATE`, batched into `NEXT_PUBLIC_RELAY_CHUNK_MS`, and base64-encoded before hitting `/relay`.
3. **Auto commit via VAD**: a lightweight RMS-based detector mirrors the phone bridge. After `NEXT_PUBLIC_COMMIT_SILENCE_MS` of silence, we send `{ type: "commit" }` so Ragnar responds naturally without button presses.
4. **Playback**: incoming `audio_delta` payloads are decoded back into PCM, queued inside an `AudioContext`, and played immediately. `text_delta`/`transcript` events drive the on-screen captions.
5. **Hang up**: clicking **Hang Up** sends `{ type: "end" }` to the relay and tears down the audio graph/WebSocket.

## Deployment (permanent, secure URL)

1. **Initialize git (optional but recommended)**
   ```bash
   git init
   git add .
   git commit -m "voice bridge"
   ```
2. **Create a Vercel project**
   - `npm i -g vercel` (if not already installed)
   - `vercel login`
   - `vercel` (first deploy) – select this folder, accept build defaults.
3. **Set environment variables in Vercel**
   - `NEXT_PUBLIC_VOICE_RELAY_URL`
   - `NEXT_PUBLIC_VOICE_RELAY_TOKEN` (if your relay expects a token)
   - `BASIC_AUTH_USERNAME`, `BASIC_AUTH_PASSWORD`
4. **Deploy**
   - `vercel --prod`
   - Result: `https://your-project.vercel.app` (TLS by default).

Make sure the relay is reachable from the deployed app (public `wss://` URL, optional auth token). For extra security you can wrap the relay itself with firewall rules, Cloudflare Zero Trust, or JWT verification.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [`voice-relay-server` README](../../services/voice-relay-server/README.md)

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start local dev server |
| `npm run build` | Production build |
| `npm run start` | Serve build |
| `npm run lint` | Lint project |
