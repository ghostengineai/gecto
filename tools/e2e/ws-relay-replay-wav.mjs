#!/usr/bin/env node
/**
 * Replay a WAV (16-bit PCM) into the /relay websocket contract as {type:"audio_chunk"} frames.
 *
 * This is intended for "golden call" regression checks and quick repros.
 *
 * Usage:
 *   node tools/e2e/ws-relay-replay-wav.mjs \
 *     --relay ws://localhost:5050/relay \
 *     --wav ./test.wav \
 *     --commit \
 *     --out ./out.json
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function arg(name, def) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return def;
  return v;
}

const relayUrl = arg("relay");
const wavPath = arg("wav");
const doCommit = process.argv.includes("--commit");
const chunkMs = Number(arg("chunk-ms", "20"));
const sampleRateExpected = Number(arg("rate", "16000"));
const timeoutMs = Number(arg("timeout", "30000"));
const outPath = arg("out", "");
const traceId = arg("trace", `golden_${randomUUID().slice(0, 10)}`);

if (!relayUrl) {
  console.error("Missing --relay <ws(s)://.../relay>");
  process.exit(2);
}
if (!wavPath) {
  console.error("Missing --wav <path.wav>");
  process.exit(2);
}

// Prefer Node 22+ built-in WebSocket.
const WebSocketCtor = globalThis.WebSocket;
if (!WebSocketCtor) {
  console.error("No global WebSocket found. Use Node 22+.");
  process.exit(2);
}

function readWavPcm16le(buf) {
  // Very small WAV parser: expects RIFF/WAVE, fmt chunk PCM, data chunk.
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let offset = 12;
  let fmt;
  let data;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > buf.length) break;

    if (id === "fmt ") {
      const audioFormat = buf.readUInt16LE(bodyStart + 0);
      const numChannels = buf.readUInt16LE(bodyStart + 2);
      const sampleRate = buf.readUInt32LE(bodyStart + 4);
      const bitsPerSample = buf.readUInt16LE(bodyStart + 14);
      fmt = { audioFormat, numChannels, sampleRate, bitsPerSample };
    }
    if (id === "data") {
      data = buf.subarray(bodyStart, bodyEnd);
    }

    // chunks are word-aligned
    offset = bodyEnd + (size % 2);
  }

  if (!fmt) throw new Error("Missing fmt chunk");
  if (!data) throw new Error("Missing data chunk");
  if (fmt.audioFormat !== 1) throw new Error(`Unsupported WAV audioFormat=${fmt.audioFormat} (expected PCM=1)`);
  if (fmt.bitsPerSample !== 16) throw new Error(`Unsupported bitsPerSample=${fmt.bitsPerSample} (expected 16)`);
  if (fmt.numChannels !== 1) throw new Error(`Unsupported numChannels=${fmt.numChannels} (expected mono=1)`);

  return { fmt, data };
}

const wavBuf = fs.readFileSync(wavPath);
const { fmt, data } = readWavPcm16le(wavBuf);
if (fmt.sampleRate !== sampleRateExpected) {
  throw new Error(`Unexpected sampleRate=${fmt.sampleRate}. Pass --rate or resample first.`);
}

const bytesPerMs = (fmt.sampleRate * 2) / 1000; // mono 16-bit
const chunkBytes = Math.max(2, Math.floor(bytesPerMs * chunkMs));
const alignedChunkBytes = chunkBytes - (chunkBytes % 2);

const startedAt = Date.now();
const run = {
  traceId,
  relayUrl,
  wav: path.resolve(wavPath),
  wavBytes: data.length,
  fmt,
  chunkMs,
  chunkBytes: alignedChunkBytes,
  events: [],
};

let sawReady = false;
let sawCompleted = false;
let audioDeltaChunks = 0;
let text = "";

const ws = new WebSocketCtor(relayUrl);

const die = (code, msg) => {
  try {
    console.error(msg);
    ws.close();
  } catch {}
  if (outPath) {
    try {
      fs.writeFileSync(outPath, JSON.stringify({ ...run, ok: false, error: msg }, null, 2));
    } catch {}
  }
  process.exit(code);
};

const timer = setTimeout(() => {
  die(1, `Timeout after ${timeoutMs}ms waiting for response_completed`);
}, timeoutMs);

ws.addEventListener("open", async () => {
  ws.send(JSON.stringify({ type: "start", traceId }));

  for (let off = 0; off < data.length; off += alignedChunkBytes) {
    const chunk = data.subarray(off, Math.min(off + alignedChunkBytes, data.length));
    ws.send(JSON.stringify({ type: "audio_chunk", traceId, audio: chunk.toString("base64") }));
    // small pacing to avoid overwhelming slower backends
    await new Promise((r) => setTimeout(r, 0));
  }

  if (doCommit) {
    ws.send(JSON.stringify({ type: "commit", traceId, reason: "golden_replay" }));
  }
});

ws.addEventListener("message", async (ev) => {
  let evt;
  try {
    let dataStr;
    if (typeof ev.data === "string") {
      dataStr = ev.data;
    } else if (ev.data instanceof ArrayBuffer) {
      dataStr = Buffer.from(ev.data).toString("utf8");
    } else if (ArrayBuffer.isView(ev.data)) {
      dataStr = Buffer.from(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength).toString("utf8");
    } else if (typeof ev.data?.text === "function") {
      dataStr = await ev.data.text();
    } else {
      dataStr = Buffer.from(ev.data).toString("utf8");
    }
    evt = JSON.parse(dataStr);
  } catch {
    return;
  }

  run.events.push({ t: Date.now() - startedAt, evt: evt.type });

  if (evt.type === "ready") sawReady = true;
  if (evt.type === "text_delta") text += evt.text;
  if (evt.type === "text_completed") text = evt.text;
  if (evt.type === "audio_delta") audioDeltaChunks += 1;

  if (evt.type === "response_completed") {
    sawCompleted = true;
    clearTimeout(timer);

    const out = {
      ...run,
      ok: true,
      ms: Date.now() - startedAt,
      sawReady,
      sawCompleted,
      text,
      audioDeltaChunks,
      responseId: evt.responseId,
    };

    if (outPath) {
      fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
      console.log(`OK: wrote run report to ${outPath}`);
    } else {
      console.log(JSON.stringify(out, null, 2));
    }

    ws.send(JSON.stringify({ type: "end", traceId }));
    ws.close();
    process.exit(0);
  }

  if (evt.type === "error") {
    clearTimeout(timer);
    die(1, `Server error: ${evt.error}`);
  }
});

ws.addEventListener("error", (err) => {
  clearTimeout(timer);
  die(1, `WS error: ${err?.message ?? String(err)}`);
});

ws.addEventListener("close", () => {
  if (!sawCompleted) {
    clearTimeout(timer);
    die(1, "WebSocket closed before response_completed");
  }
});
