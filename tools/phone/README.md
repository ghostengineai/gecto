# Phone tools

## Outbound call

This repo’s outbound calling is done via `services/phone-bridge`.

### Prereqs
- Your `phone-bridge` is deployed and reachable.
- `BRIDGE_API_TOKEN` is set on the phone-bridge service.

### Run

```bash
PHONE_BRIDGE_URL=https://phone-bridge.onrender.com \
BRIDGE_API_TOKEN=... \
node tools/phone/call.mjs +15857300483
```

Notes:
- Do **not** commit tokens.
- Prefer setting `BRIDGE_API_TOKEN` in the runtime environment (e.g. OpenClaw host env) rather than pasting into chat.
