/*
  Simple local simulation:
  - connects to relay websocket
  - sends either a text message, or a WAV file as audio chunks

  Examples:
    npm run simulate -- --relay ws://localhost:5050/relay --text "hello"
    npm run simulate -- --relay ws://localhost:5050/relay --wav ./testdata/hello.wav
*/

import WebSocket from "ws";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "../src/util/exec";
import { chunkPcm16 } from "../src/util/audio";

const arg = (name: string): string | undefined => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
};

const relay = arg("--relay") ?? "ws://localhost:5050/relay";
const text = arg("--text");
const wav = arg("--wav");

const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";

const wavToPcm16k = async (wavPath: string): Promise<Buffer> => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnar-sim-"));
  const out = path.join(tmpDir, "out.s16le");
  try {
    const res = await execFile(ffmpeg, ["-y", "-i", wavPath, "-ac", "1", "-ar", "16000", "-f", "s16le", out], {
      timeoutMs: 60_000,
    });
    if (res.code !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
    return await fs.readFile(out);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const main = async () => {
  if (!text && !wav) {
    throw new Error("Provide --text or --wav");
  }

  const ws = new WebSocket(relay);

  ws.on("message", (data) => {
    try {
      const evt = JSON.parse(data.toString());
      process.stdout.write(`\n< ${evt.type}${evt.text ? `: ${evt.text}` : ""}${evt.error ? `: ${evt.error}` : ""}`);
    } catch {
      process.stdout.write(`\n< [non-json] ${data.toString().slice(0, 80)}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (e) => reject(e));
  });

  if (text) {
    ws.send(JSON.stringify({ type: "text", text }));
    ws.send(JSON.stringify({ type: "commit" }));
  } else if (wav) {
    const pcm = await wavToPcm16k(wav);
    const chunks = chunkPcm16(pcm, 16000);
    for (const chunk of chunks) {
      ws.send(JSON.stringify({ type: "audio_chunk", audio: chunk.toString("base64") }));
      // avoid flooding
      await new Promise((r) => setTimeout(r, 5));
    }
    ws.send(JSON.stringify({ type: "commit" }));
  }

  // close after a short wait
  await new Promise((r) => setTimeout(r, 4000));
  ws.send(JSON.stringify({ type: "end" }));
  ws.close();
};

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
