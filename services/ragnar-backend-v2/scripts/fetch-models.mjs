#!/usr/bin/env node
/**
 * Download default whisper.cpp + Piper models onto a persistent disk.
 *
 * Intended for Render builds where a Persistent Disk is mounted at /var/data.
 * Safe to run multiple times: it skips files that already exist.
 */

import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";

const DISK_ROOT = process.env.MODELS_ROOT ?? "/var/data/models";

const whisperDir = path.join(DISK_ROOT, "whisper");
const piperDir = path.join(DISK_ROOT, "piper");

const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH ?? path.join(whisperDir, "ggml-base.en.bin");
const PIPER_MODEL_PATH = process.env.PIPER_MODEL_PATH ?? path.join(piperDir, "en_US-lessac-medium.onnx");
const PIPER_CONFIG_PATH =
  process.env.PIPER_CONFIG_PATH ?? (process.env.PIPER_MODEL_PATH ? `${process.env.PIPER_MODEL_PATH}.json` : `${PIPER_MODEL_PATH}.json`);

// Default model URLs (overrideable)
const WHISPER_MODEL_URL =
  process.env.WHISPER_MODEL_URL ??
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

const PIPER_MODEL_URL =
  process.env.PIPER_MODEL_URL ??
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx";

const PIPER_CONFIG_URL =
  process.env.PIPER_CONFIG_URL ??
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json";

const ensureDir = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
};

const fileExistsNonEmpty = async (p) => {
  try {
    const st = await fs.stat(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
};

const downloadTo = async (url, outPath) => {
  const tmp = `${outPath}.tmp`;
  await ensureDir(path.dirname(outPath));

  console.log(`Downloading ${url}`);
  console.log(`       -> ${outPath}`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  }

  await new Promise((resolve, reject) => {
    const ws = createWriteStream(tmp);
    res.body.pipeTo(
      new WritableStream({
        write(chunk) {
          ws.write(Buffer.from(chunk));
        },
        close() {
          ws.end();
          resolve();
        },
        abort(err) {
          try { ws.destroy(); } catch {}
          reject(err);
        },
      }),
    ).catch(reject);

    ws.on("error", reject);
  });

  await fs.rename(tmp, outPath);
};

const main = async () => {
  await ensureDir(whisperDir);
  await ensureDir(piperDir);

  const items = [
    { name: "whisper", url: WHISPER_MODEL_URL, path: WHISPER_MODEL_PATH },
    { name: "piper", url: PIPER_MODEL_URL, path: PIPER_MODEL_PATH },
    { name: "piper-config", url: PIPER_CONFIG_URL, path: PIPER_CONFIG_PATH },
  ];

  for (const it of items) {
    if (await fileExistsNonEmpty(it.path)) {
      console.log(`OK: ${it.name} already present: ${it.path}`);
      continue;
    }
    await downloadTo(it.url, it.path);
    console.log(`OK: downloaded ${it.name}`);
  }

  console.log("Done.");
  console.log("Model paths:");
  console.log(`- WHISPER_MODEL_PATH=${WHISPER_MODEL_PATH}`);
  console.log(`- PIPER_MODEL_PATH=${PIPER_MODEL_PATH}`);
  console.log(`- PIPER_CONFIG_PATH=${PIPER_CONFIG_PATH}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
