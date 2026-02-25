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

      // whisper.cpp main CLI flags change across commits.
      // Prefer short flags that have been stable for a long time:
      //   -oj : output JSON
      //   -of : output file base path
      //   -nt : no timestamps
      const args = [
        "-m",
        this.opts.modelPath,
        "-f",
        wavPath,
        "-oj",
        "-of",
        outBase,
        "-nt",
      ];

      const started = Date.now();
      const res = await execFile(this.opts.binPath, args, { timeoutMs: 120_000 });
      const elapsedMs = Date.now() - started;

      if (res.code !== 0) {
        const stdoutPreview = (res.stdout ?? "").slice(0, 800);
        const stderrPreview = (res.stderr ?? "").slice(0, 800);
        log.warn("whisper.cpp exited non-zero", {
          code: res.code,
          stdout: stdoutPreview,
          stderr: stderrPreview,
        });

        // Fallback: some whisper.cpp builds don't support JSON output flags; try text output.
        // Use flags that have historically been common: -otxt (text), -of (output base), -nt (no timestamps).
        const argsTxt = [
          "-m",
          this.opts.modelPath,
          "-f",
          wavPath,
          "-otxt",
          "-of",
          outBase,
          "-nt",
        ];

        const res2 = await execFile(this.opts.binPath, argsTxt, { timeoutMs: 120_000 });
        if (res2.code !== 0) {
          const stdout2 = (res2.stdout ?? "").slice(0, 800);
          const stderr2 = (res2.stderr ?? "").slice(0, 800);
          throw new Error(
            `whisper.cpp failed (code ${res.code}). stdout=${stdoutPreview || "(empty)"} stderr=${stderrPreview || "(empty)"}. ` +
              `Fallback -otxt also failed (code ${res2.code}). stdout=${stdout2 || "(empty)"} stderr=${stderr2 || "(empty)"}`,
          );
        }

        const txtPath = `${outBase}.txt`;
        const text = String(await fs.readFile(txtPath, "utf8")).trim();
        return { text };
      }

      const jsonRaw = await fs.readFile(outJson, "utf8");
      const parsed = JSON.parse(jsonRaw) as any;

      // whisper.cpp JSON schema varies across builds.
      // Avoid String(object) -> "[object Object]" by extracting the actual text.
      const coerceText = (v: any): string => {
        if (!v) return "";
        if (typeof v === "string") return v;
        if (Array.isArray(v)) {
          // e.g. [{text:"..."}, ...]
          return v
            .map((x) => (typeof x === "string" ? x : typeof x?.text === "string" ? x.text : ""))
            .join(" ")
            .trim();
        }
        if (typeof v === "object") {
          if (typeof v.text === "string") return v.text;
          if (Array.isArray(v.segments)) {
            return v.segments.map((s: any) => String(s?.text ?? "").trim()).filter(Boolean).join(" ");
          }
        }
        return "";
      };

      const text = coerceText(parsed?.transcription) || coerceText(parsed?.text) || "";

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

      log.info("asr transcribed", {
        bytes: pcm16.length,
        elapsedMs,
        textPreview: text.slice(0, 80),
        schemaKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 20) : undefined,
        transcriptionType: typeof parsed?.transcription,
        textType: typeof parsed?.text,
      });

      return { text, segments };
    } finally {
      // best-effort cleanup
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
