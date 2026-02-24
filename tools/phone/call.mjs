#!/usr/bin/env node
/**
 * Place an outbound call via services/phone-bridge.
 *
 * Usage:
 *   PHONE_BRIDGE_URL=https://phone-bridge.onrender.com \
 *   BRIDGE_API_TOKEN=... \
 *   node tools/phone/call.mjs +15857300483
 */

const to = process.argv[2];
if (!to) {
  console.error("Usage: node tools/phone/call.mjs <toE164>");
  process.exit(2);
}

const baseUrl = (process.env.PHONE_BRIDGE_URL ?? process.env.PHONE_BRIDGE_BASE_URL ?? "").replace(/\/$/, "");
if (!baseUrl) {
  console.error("Missing env PHONE_BRIDGE_URL (e.g. https://phone-bridge.onrender.com)");
  process.exit(2);
}

const token = process.env.BRIDGE_API_TOKEN ?? "";
if (!token) {
  console.error("Missing env BRIDGE_API_TOKEN (do not commit; set in host env / Render)");
  process.exit(2);
}

const url = `${baseUrl}/api/call`;

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ to }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`Call failed: HTTP ${res.status} ${res.statusText}`);
  console.error(text);
  process.exit(1);
}

console.log(text);
