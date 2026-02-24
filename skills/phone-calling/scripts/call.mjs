#!/usr/bin/env node
/**
 * Skill helper: place an outbound call via services/phone-bridge.
 *
 * Requires env:
 *   PHONE_BRIDGE_URL=https://phone-bridge.onrender.com
 *   BRIDGE_API_TOKEN=...
 *
 * Usage examples:
 *   node skills/phone-calling/scripts/call.mjs --to "+15855550123" --opener "Hi, this is Ragnar." --callerName "Ragnar"
 *   node skills/phone-calling/scripts/call.mjs --contact "Me" --opener "Test call."
 */

import fs from "node:fs";
import path from "node:path";

function arg(name, def) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return def;
  return v;
}

const to = arg("to");
const contact = arg("contact");
const openerText = arg("opener");
const callerName = arg("callerName");
const from = arg("from");

const baseUrl = (process.env.PHONE_BRIDGE_URL ?? process.env.PHONE_BRIDGE_BASE_URL ?? "").replace(/\/$/, "");
if (!baseUrl) {
  console.error("Missing env PHONE_BRIDGE_URL (e.g. https://phone-bridge.onrender.com)");
  process.exit(2);
}

const token = process.env.BRIDGE_API_TOKEN ?? "";
if (!token) {
  console.error("Missing env BRIDGE_API_TOKEN");
  process.exit(2);
}

let resolvedTo = to;
if (!resolvedTo && contact) {
  const contactsPath = path.resolve(process.cwd(), "skills/phone-calling/references/contacts.json");
  const contacts = JSON.parse(fs.readFileSync(contactsPath, "utf8"));
  resolvedTo = contacts[contact];
}

if (!resolvedTo) {
  console.error("Missing --to or --contact");
  process.exit(2);
}

const url = `${baseUrl}/api/call`;

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ to: resolvedTo, from, openerText, callerName }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`Call failed: HTTP ${res.status} ${res.statusText}`);
  console.error(text);
  process.exit(1);
}

console.log(text);
