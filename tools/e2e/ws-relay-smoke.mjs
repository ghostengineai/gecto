#!/usr/bin/env node
/**
 * Smoke-test the /relay websocket contract.
 *
 * Usage:
 *   node tools/e2e/ws-relay-smoke.mjs --relay ws://localhost:5050/relay --text "hello" --out /tmp/out.wav
 */
import fs from "node:fs";
import { WebSocket } from "ws";

function arg(name, def) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return def;
  return v;
}

const relayUrl = arg("relay");
const text = arg("text", "hello");
const outPath = arg("out", "./relay-audio.wav");
const timeoutMs = Number(arg("timeout", "15000"));

if (!relayUrl) {
  console.error("Missing --relay <ws(s)://.../relay>");
  process.exit(2);
}

const pcmChunks = [];
let sawReady = false;
let sawAnyText = false;
let sawCompleted = false;

function writeWav16kMono(path, pcm) {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(path, Buffer.concat([header, pcm]));
}

const ws = new WebSocket(relayUrl);

const kill = (code, msg) => {
  try {
    console.error(msg);
    ws.close();
  } catch {}
  process.exit(code);
};

const timer = setTimeout(() => {
  kill(1, `Timeout after ${timeoutMs}ms waiting for response_completed`);
}, timeoutMs);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "text", text }));
  ws.send(JSON.stringify({ type: "commit" }));
});

ws.on("message", (data) => {
  let evt;
  try {
    evt = JSON.parse(data.toString());
  } catch {
    return;
  }

  if (evt.type === "ready") sawReady = true;
  if (evt.type === "text_delta" || evt.type === "text_completed") sawAnyText = true;
  if (evt.type === "audio_delta" && evt.audio) {
    pcmChunks.push(Buffer.from(evt.audio, "base64"));
  }
  if (evt.type === "response_completed") {
    sawCompleted = true;
    clearTimeout(timer);

    if (!sawReady) {
      kill(1, "Did not receive {type:ready}");
    }
    if (!sawAnyText) {
      kill(1, "Did not receive any text_delta/text_completed");
    }

    if (pcmChunks.length) {
      const pcm = Buffer.concat(pcmChunks);
      writeWav16kMono(outPath, pcm);
      console.log(`OK: wrote audio to ${outPath} (${pcm.length} bytes PCM)`);
    } else {
      console.log("OK: no audio_delta received (this may be expected if TTS is disabled)");
    }

    ws.send(JSON.stringify({ type: "end" }));
    ws.close();
    process.exit(0);
  }

  if (evt.type === "error") {
    clearTimeout(timer);
    kill(1, `Server error: ${evt.error}`);
  }
});

ws.on("error", (err) => {
  clearTimeout(timer);
  kill(1, `WS error: ${err?.message ?? String(err)}`);
});

ws.on("close", () => {
  if (!sawCompleted) {
    clearTimeout(timer);
    kill(1, "WebSocket closed before response_completed");
  }
});
