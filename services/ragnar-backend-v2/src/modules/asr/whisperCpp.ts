import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "../../util/exec";
import { log } from "../../util/log";
import { writeWav16kMono } from "../../util/audio";
import type { AsrModule, AsrResult } from "./types";

interface WhisperCppOptions {
  binPath: string;
  modelPath: string;
}

export class WhisperCppAsr implements AsrModule {
  constructor(private opts: WhisperCppOptions) {}

  async ready(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    try {
      await fs.access(this.opts.binPath);
      await fs.access(this.opts.modelPath);
      return { ok: true, details: { binPath: this.opts.binPath, modelPath: this.opts.modelPath } };
    } catch (e) {
      return {
        ok: false,
        details: {
          binPath: this.opts.binPath,
          modelPath: this.opts.modelPath,
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  async transcribePcm16kMono(pcm16: Buffer): Promise<AsrResult> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnar-asr-"));
    const id = randomUUID().slice(0, 8);
    const wavPath = path.join(tmpDir, `in_${id}.wav`);
    const outBase = path.join(tmpDir, `out_${id}`);
    const outJson = `${outBase}.json`;

    try {
      await writeWav16kMono(wavPath, pcm16);

      // whisper.cpp main usage varies by commit; these flags are widely supported.
      const args = [
        "-m",
        this.opts.modelPath,
        "-f",
        wavPath,
        "--output-json",
        "--output-file",
        outBase,
        "--no-timestamps",
      ];

      const started = Date.now();
      const res = await execFile(this.opts.binPath, args, { timeoutMs: 120_000 });
      const elapsedMs = Date.now() - started;

      if (res.code !== 0) {
        log.warn("whisper.cpp exited non-zero", { code: res.code, stderr: res.stderr.slice(0, 500) });
        throw new Error(`whisper.cpp failed (code ${res.code})`);
      }

      const jsonRaw = await fs.readFile(outJson, "utf8");
      const parsed = JSON.parse(jsonRaw) as any;
      const text = String(parsed?.transcription ?? parsed?.text ?? "").trim();

      // segments are optional / schema differs; best-effort
      const segments = Array.isArray(parsed?.transcription_segments)
        ? parsed.transcription_segments
            .map((s: any) => ({
              startMs: Math.round(Number(s?.t0 ?? 0) * 10),
              endMs: Math.round(Number(s?.t1 ?? 0) * 10),
              text: String(s?.text ?? "").trim(),
            }))
            .filter((s: any) => s.text)
        : undefined;

      log.info("asr transcribed", { bytes: pcm16.length, elapsedMs, textPreview: text.slice(0, 80) });

      return { text, segments };
    } finally {
      // best-effort cleanup
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
