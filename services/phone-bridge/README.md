# Phone Bridge

Bridges Twilio phone calls into the Ragnar realtime voice relay. Inbound PSTN callers hear Ragnar’s responses, and Ragnar receives low-latency audio plus transcripts from the caller via the existing `voice-relay-server`.

## Capabilities

- **Inbound calls → Realtime**: Twilio Voice `<Connect><Stream>` sends μ-law audio frames into the bridge. Audio is up-sampled and forwarded as PCM16 to the relay; silence-based VAD automatically triggers `commit` events so Ragnar responds naturally.
- **Outbound calls**: `/api/call` uses the Twilio REST API to dial a number and attach it to the same stream endpoint (optional API token guard).
- **Bidirectional audio**: Ragnar’s synthesized PCM16 audio is down-sampled, μ-law encoded, and streamed back to Twilio in 20 ms frames so the caller hears responses in real time.
- **Signature validation**: Optional verification of the Twilio webhook using `x-twilio-signature`.
- **DTMF controls**: `#` forces a commit (useful if the caller pauses mid-sentence) and `*` cancels the current relay turn.

## Prerequisites

| Dependency | Purpose |
| --- | --- |
| Node.js 20+ | Runtime for the bridge |
| Twilio account (voice enabled) | Buying numbers + Programmable Voice |
| Public HTTPS + WSS URL | Twilio must reach both the voice webhook and media WebSocket (use Cloudflare Tunnel, ngrok, Fly.io, etc.) |
| Running `voice-relay-server` | Handles the OpenAI Realtime session |

## Environment Variables

Create `services/phone-bridge/.env` (see `.env.example`).

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | ❌ | HTTP/WebSocket port (default `5060`) |
| `VOICE_RELAY_URL` | ❌ | Relay WebSocket (default `ws://localhost:5050/relay`) |
| `RELAY_INPUT_SAMPLE_RATE` | ❌ | Sample rate sent to relay (default `16000`) |
| `RELAY_OUTPUT_SAMPLE_RATE` | ❌ | Sample rate expected from relay (default `24000`) |
| `COMMIT_SILENCE_MS` | ❌ | Silence duration before auto-commit (default `900`) |
| `VAD_THRESHOLD` | ❌ | RMS threshold for speech detection (default `0.012`) |
| `PUBLIC_BASE_URL` | ✅ (for outbound + signature validation) | Public HTTPS origin, e.g. `https://yourdomain.example` |
| `PUBLIC_WS_URL` | ✅ | Public WSS base URL (if omitted we derive from `PUBLIC_BASE_URL`) |
| `TWILIO_WEBHOOK_PATH` | ❌ | Voice webhook route (default `/twilio/voice`) |
| `TWILIO_STREAM_PATH` | ❌ | Media WebSocket path (default `/twilio/media`) |
| `TWILIO_ACCOUNT_SID` | ✅ (for outbound) | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | ✅ (for outbound + signature validation) | Twilio Auth Token |
| `TWILIO_CALLER_ID` | ✅ (for outbound) | Verified Twilio number used as caller ID |
| `TWILIO_STATUS_CALLBACK_URL` | ❌ | Optional status callback URL |
| `BRIDGE_API_TOKEN` | ❌ | Bearer token required for `/api/call` |
| `TWILIO_VALIDATE_SIGNATURE` | ❌ | Set `0` to skip signature validation |

### Example `.env`

```bash
PORT=5060
VOICE_RELAY_URL=ws://localhost:5050/relay
PUBLIC_BASE_URL=https://your-ngrok-domain.ngrok.app
PUBLIC_WS_URL=wss://your-ngrok-domain.ngrok.app
TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_CALLER_ID=+15551234567
BRIDGE_API_TOKEN=supersecret
```

## Setup

```bash
cd services/phone-bridge
npm install
npm run dev
```

Expose the port publicly (ngrok/Fly/etc.) so Twilio can reach both:

- Voice webhook: `https://your-domain/twilio/voice`
- Media stream: `wss://your-domain/twilio/media`

## Configuring Twilio

1. Buy / use an existing phone number.
2. Set **Voice & Fax → A CALL COMES IN** to `Webhook` with `https://your-domain/twilio/voice` (POST).
3. Ensure the number is assigned to the region closest to callers (latency matters).
4. Optional: create a TwiML App and point it to the same webhook; use the App SID in outbound calls if preferred.

### Outbound Calls

`POST /api/call`

```json
{
  "to": "+15557654321"
}
```

Headers: `Authorization: Bearer <BRIDGE_API_TOKEN>` (if configured).

Response:

```json
{ "ok": true, "callSid": "CAXXXXXXXXXXXXXXXXX" }
```

## How It Works

1. Twilio hits `/twilio/voice` → TwiML `<Connect><Stream url="wss://.../twilio/media" track="both_tracks"/>`.
2. Twilio opens the WebSocket and starts sending μ-law 8 kHz frames.
3. The bridge converts to PCM16 @ `RELAY_INPUT_SAMPLE_RATE`, forwards `audio_chunk` messages to `voice-relay-server`, and runs a simple RMS-based VAD to issue `commit` events after ~900 ms of silence.
4. Ragnar’s audio deltas (PCM16) stream back from the relay. They’re down-sampled to 8 kHz, μ-law encoded, and sent to Twilio as outbound media frames so the caller hears responses immediately.
5. DTMF shortcuts: `#` forces a commit; `*` aborts the current relay turn.

## Extending to Telnyx

Telnyx Call Control WebRTC streams expose the same μ-law audio payloads. To support Telnyx next:

- Add an additional `/telnyx/media` WebSocket endpoint that performs the same conversions.
- Mirror the Twilio webhook with Call Control instructions to start streaming audio to the bridge.
- Re-use `PhoneBridgeManager` by abstracting the media adapter (Twilio vs Telnyx) so both produce/consume the same internal events.

## Observability

`phone-bridge` emits structured JSON logs with a per-call `traceId` (seeded from Twilio `callSid`).

- See `docs/phone/observability.md` for the common schema and stage names.
- Audio/base64 payloads are redacted from logs.

## Troubleshooting

| Symptom | Possible Cause |
| --- | --- |
| Caller hears nothing | PUBLIC_WS_URL wrong or TLS cert invalid |
| Relay never responds | `voice-relay-server` unreachable or `VOICE_RELAY_URL` incorrect |
| Frequent double responses | VAD threshold too low – raise `VAD_THRESHOLD` or `COMMIT_SILENCE_MS` |
| Twilio 403 on webhook | Signature validation enabled but `TWILIO_AUTH_TOKEN` mismatched |
| `/api/call` 401 | Missing/incorrect `Authorization` bearer token |

## Next Ideas

- Persist transcripts + call metadata into Ragnar’s memory via event webhooks.
- Plug in advanced VAD (WebRTC VAD) instead of RMS threshold.
- Surface call dashboards (active sessions, durations, errors) via `/admin` endpoints.
- Add Telnyx + SIPREC adapters sharing the same internal bridge manager.
