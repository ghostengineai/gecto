import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "../../util/exec";
import { log } from "../../util/log";
import type { TtsModule, TtsResult } from "./types";

interface PiperOptions {
  binPath: string;
  modelPath: string;
  configPath: string;
  ffmpegPath: string;
  outputSampleRate: number;
}

export class PiperTts implements TtsModule {
  constructor(private opts: PiperOptions) {}

  async ready(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    try {
      await fs.access(this.opts.binPath);
      await fs.access(this.opts.modelPath);
      await fs.access(this.opts.configPath);
      return {
        ok: true,
        details: {
          binPath: this.opts.binPath,
          modelPath: this.opts.modelPath,
          configPath: this.opts.configPath,
          ffmpegPath: this.opts.ffmpegPath,
          outputSampleRate: this.opts.outputSampleRate,
        },
      };
    } catch (e) {
      return {
        ok: false,
        details: {
          binPath: this.opts.binPath,
          modelPath: this.opts.modelPath,
          configPath: this.opts.configPath,
          ffmpegPath: this.opts.ffmpegPath,
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  async synthesize(text: string, outputSampleRate?: number): Promise<TtsResult> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragnar-tts-"));
    const id = randomUUID().slice(0, 8);
    const wavPath = path.join(tmpDir, `piper_${id}.wav`);
    const pcmPath = path.join(tmpDir, `piper_${id}.s16le`);

    try {
      const started = Date.now();

      // piper reads text from stdin
      const res = await execFile(
        this.opts.binPath,
        [
          "--model",
          this.opts.modelPath,
          "--config",
          this.opts.configPath,
          "--output_file",
          wavPath,
        ],
        { inputText: text + "\n", timeoutMs: 120_000 },
      );

      if (res.code !== 0) {
        log.warn("piper exited non-zero", { code: res.code, stderr: res.stderr.slice(0, 500) });
        throw new Error(`piper failed (code ${res.code})`);
      }

      const ff = await execFile(
        this.opts.ffmpegPath,
        [
          "-y",
          "-i",
          wavPath,
          "-ac",
          "1",
          "-ar",
          String(outputSampleRate ?? this.opts.outputSampleRate),
          "-f",
          "s16le",
          pcmPath,
        ],
        { timeoutMs: 60_000 },
      );
      if (ff.code !== 0) {
        log.warn("ffmpeg exited non-zero", { code: ff.code, stderr: ff.stderr.slice(0, 500) });
        throw new Error(`ffmpeg failed (code ${ff.code})`);
      }

      const pcm16 = await fs.readFile(pcmPath);
      log.info("tts synthesized", { elapsedMs: Date.now() - started, bytes: pcm16.length, textPreview: text.slice(0, 80) });
      return { pcm16 };
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
