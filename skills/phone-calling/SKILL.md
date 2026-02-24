---
name: phone-calling
description: Place outbound phone calls via GhostEngine.ai phone-bridge/Twilio and control what Ragnar says when the callee answers. Use when the user says things like "call this number", "call Alice", "call +1...", "dial", "ring", or wants a reusable contacts list and safe confirmation workflow for phone calls.
---

# Phone calling (GhostEngine)

## What this skill is

Use the repo’s `services/phone-bridge` to initiate outbound calls and (optionally) provide an opening line for Ragnar to speak first.

## Safety / default behavior

- Always confirm before dialing unless the user explicitly says to dial immediately.
- Prefer contacts (name → number) over raw numbers.
- Do not store secrets in chat; rely on env vars.

## Configuration files

- `references/contacts.json` name → E.164 number mapping.
- `references/policy.json` allowlist + confirmation defaults.

## How to place a call

Use the bundled script:

```bash
PHONE_BRIDGE_URL=https://phone-bridge.onrender.com \
BRIDGE_API_TOKEN=... \
node skills/phone-calling/scripts/call.mjs --to "+15855550123" --opener "Hi, this is Ragnar from GhostEngine.ai." --callerName "Ragnar"
```

Or call a contact:

```bash
node skills/phone-calling/scripts/call.mjs --contact "Alice" --opener "Hi Alice, quick question..."
```

## Notes

- The opener is delivered via phone-bridge and should be spoken immediately after answer (no need for the callee to press keys).
- If the stack is healthy but there is silence, check phone-bridge logs for relay/ASR errors.
