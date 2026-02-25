import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { WhisperCppAsr } from "./modules/asr/whisperCpp";
import { PiperTts } from "./modules/tts/piper";
import { ConversationCore } from "./core/conversation";
import { appendAudioChunk, consumeBufferedAudio, createSession } from "./core/session";
import { chunkPcm16 } from "./util/audio";
import {
  supabaseInsertTurn,
  supabaseMarkCallEnded,
  supabaseUpsertCall,
  supabaseLoggingEnabled,
} from "./services/supabaseLog";

const relayInputSampleRate = Number(process.env.RELAY_INPUT_SAMPLE_RATE ?? 16000);
const defaultRelayOutputSampleRate = Number(process.env.RELAY_OUTPUT_SAMPLE_RATE ?? 24000);

import { log } from "./util/log";
import { createTrace, mark, msSinceStart } from "./util/trace";

dotenv.config();

const PORT = Number(process.env.RAGNAR_BACKEND_V2_PORT ?? process.env.PORT ?? 5052);

const WHISPER_CPP_BIN = process.env.WHISPER_CPP_BIN ?? "/opt/whispercpp/main";
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH;

const PIPER_BIN = process.env.PIPER_BIN ?? "/opt/piper/piper";
const PIPER_MODEL_PATH = process.env.PIPER_MODEL_PATH;
const PIPER_CONFIG_PATH =
  process.env.PIPER_CONFIG_PATH ?? (PIPER_MODEL_PATH ? `${PIPER_MODEL_PATH}.json` : undefined);

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";

if (!WHISPER_MODEL_PATH) {
  log.warn("WHISPER_MODEL_PATH is not set; /healthz will be not-ready until configured");
}
if (!PIPER_MODEL_PATH) {
  log.warn("PIPER_MODEL_PATH is not set; /healthz will be not-ready until configured");
}

const asr = new WhisperCppAsr({
  binPath: WHISPER_CPP_BIN,
  modelPath: WHISPER_MODEL_PATH ?? "",
});

const tts = new PiperTts({
  binPath: PIPER_BIN,
  modelPath: PIPER_MODEL_PATH ?? "",
  configPath: PIPER_CONFIG_PATH ?? "",
  ffmpegPath: FFMPEG_BIN,
  outputSampleRate: defaultRelayOutputSampleRate,
});

const app = express();

app.get("/healthz", async (_req, res) => {
  const asrReady = await asr.ready();
  const ttsReady = await tts.ready();
  const ok = asrReady.ok && ttsReady.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    asr: asrReady,
    tts: ttsReady,
    port: PORT,
    relay: {
      inputSampleRate: relayInputSampleRate,
      outputSampleRate: defaultRelayOutputSampleRate,
    },
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/relay" });

type ClientMessage =
  | {
      type: "start";
      traceId?: string;
      callSid?: string;
      streamSid?: string;
      startedAt?: number;
      inputSampleRate?: number;
      outputSampleRate?: number;
    }
  | { type: "audio_chunk"; audio: string; traceId?: string }
  | { type: "commit"; instructions?: string; traceId?: string; reason?: string }
  | { type: "text"; text: string; traceId?: string }
  | { type: "end"; traceId?: string };

type RelayEvent =
  | { type: "ready"; inputSampleRate: number; outputSampleRate: number }
  | { type: "error"; error: string }
  | { type: "text_delta"; text: string }
  | { type: "text_completed"; text: string }
  | { type: "audio_delta"; audio: string }
  | { type: "response_completed"; responseId: string }
  | { type: "transcript"; text: string };

wss.on("connection", (socket: WebSocket) => {
  const session = createSession();
  const convo = new ConversationCore();

  const trace = createTrace();
  let callSid: string | undefined;
  let streamSid: string | undefined;
  let audioChunksIn = 0;
  let turnIndex = 0;

  // Allow per-call output sample rate (e.g. 8000Hz for phone).
  let relayOutputSampleRate = defaultRelayOutputSampleRate;

  if (supabaseLoggingEnabled()) {
    log.info("supabase call logging enabled", {
      traceId: trace.traceId,
      stage: "supabase_enabled",
      ms: msSinceStart(trace),
      sessionId: session.id,
    });
  }

  mark(trace, "ws_connected");

  const sendEvent = (event: RelayEvent) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  };

  const fail = (message: string) => {
    sendEvent({ type: "error", error: message });
  };

  const handleTurnFromText = async (userText: string, instructions?: string) => {
    const transcript = userText.trim();

    // Skip silence/no-speech turns.
    if (!transcript) {
      const responseId = `resp_${randomUUID().slice(0, 10)}`;
      log.info("empty transcript: skipping response", {
        traceId: trace.traceId,
        stage: "empty_transcript",
        ms: msSinceStart(trace),
        sessionId: session.id,
        responseId,
      });
      sendEvent({ type: "response_completed", responseId });
      return;
    }

    sendEvent({ type: "transcript", text: transcript });

    mark(trace, "llm_start");
    const response = convo.respond({ userText: transcript, instructions });
    mark(trace, "llm_done");

    const responseId = `resp_${randomUUID().slice(0, 10)}`;

    // Persist transcript + response (text only) for "listen-in" UI.
    // Never store audio.
    turnIndex += 1;
    void supabaseUpsertCall({
      callSid,
      streamSid,
      traceId: trace.traceId,
      sessionId: session.id,
      relayInputSampleRate: relayInputSampleRate,
      relayOutputSampleRate: relayOutputSampleRate,
    });
    void supabaseInsertTurn({
      callSid,
      traceId: trace.traceId,
      streamSid,
      sessionId: session.id,
      turnIndex,
      userText: transcript,
      assistantText: response.text,
      instructions,
      responseId,
    });

    log.info("response text ready", {
      traceId: trace.traceId,
      stage: "llm_done",
      ms: msSinceStart(trace),
      sessionId: session.id,
      responseId,
      textLen: response.text.length,
    });

    for (const d of convo.chunkText(response.text)) {
      sendEvent({ type: "text_delta", text: d });
    }
    sendEvent({ type: "text_completed", text: response.text });

    // Reduce time-to-first-audio by synthesizing in chunks.
    const splitForTts = (text: string): string[] => {
      const t = text.trim();
      if (!t) return [];
      const sentences = t.split(/(?<=[.!?])\s+/g);
      const chunks: string[] = [];
      let cur = "";
      const maxLen = 180;
      for (const s of sentences) {
        const next = cur ? `${cur} ${s}` : s;
        if (next.length > maxLen && cur) {
          chunks.push(cur);
          cur = s;
        } else {
          cur = next;
        }
      }
      if (cur) chunks.push(cur);
      return chunks;
    };

    try {
      mark(trace, "tts_start");
      let audioChunksOut = 0;
      let totalPcmBytes = 0;
      let partIndex = 0;

      for (const part of splitForTts(response.text)) {
        partIndex += 1;
        const ttsRes = await tts.synthesize(part, relayOutputSampleRate);
        totalPcmBytes += ttsRes.pcm16.length;

        if (partIndex === 1) {
          mark(trace, "tts_first_audio");
          log.info("tts first audio", {
            traceId: trace.traceId,
            stage: "tts_first_audio",
            ms: msSinceStart(trace),
            sessionId: session.id,
            responseId,
            partLen: part.length,
            relayOutputSampleRate,
          });
        }

        for (const chunk of chunkPcm16(ttsRes.pcm16, relayOutputSampleRate)) {
          audioChunksOut += 1;
          sendEvent({ type: "audio_delta", audio: chunk.toString("base64") });
        }
      }

      mark(trace, "tts_done");
      log.info("tts complete", {
        traceId: trace.traceId,
        stage: "tts_done",
        ms: msSinceStart(trace),
        sessionId: session.id,
        responseId,
        audioChunksOut,
        pcmBytes: totalPcmBytes,
        relayOutputSampleRate,
      });
    } catch (e) {
      log.warn("tts failed", {
        traceId: trace.traceId,
        stage: "tts_error",
        ms: msSinceStart(trace),
        sessionId: session.id,
        err: e instanceof Error ? e.message : String(e),
      });
      // allow session to continue even if TTS fails
    }

    mark(trace, "response_completed");
    sendEvent({ type: "response_completed", responseId });
    log.info("response completed", {
      traceId: trace.traceId,
      stage: "response_completed",
      ms: msSinceStart(trace),
      sessionId: session.id,
      responseId,
    });
  };

  let inFlight = false;

  const handleCommit = async (instructions?: string) => {
    if (inFlight) {
      // Avoid interleaving responses if multiple commits arrive quickly (VAD + DTMF).
      log.warn("commit ignored: turn already in flight", {
        traceId: trace.traceId,
        stage: "commit_ignored",
        ms: msSinceStart(trace),
        sessionId: session.id,
      });
      return;
    }

    inFlight = true;
    try {
      const audio = consumeBufferedAudio(session);
      if (!audio.length) {
        await handleTurnFromText("", instructions);
        return;
      }

      try {
        mark(trace, "asr_start");
        log.info("asr start", {
          traceId: trace.traceId,
          stage: "asr_start",
          ms: msSinceStart(trace),
          sessionId: session.id,
          bytes: audio.length,
        });

        const asrRes = await asr.transcribePcm16kMono(audio);
        mark(trace, "asr_done");

        const text = asrRes.text || "";
        log.info("asr done", {
          traceId: trace.traceId,
          stage: "asr_done",
          ms: msSinceStart(trace),
          sessionId: session.id,
          textLen: text.length,
        });

        await handleTurnFromText(text, instructions);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "ASR error";
        log.warn("asr failed", {
          traceId: trace.traceId,
          stage: "asr_error",
          ms: msSinceStart(trace),
          sessionId: session.id,
          err: msg,
        });
        fail(msg);
      }
    } finally {
      inFlight = false;
    }
  };

  log.info("ws connected", {
    traceId: trace.traceId,
    stage: "ws_connected",
    ms: msSinceStart(trace),
    sessionId: session.id,
  });
  // Backwards-compatible: clients ignoring extra fields are fine.
  mark(trace, "ready_sent");
  sendEvent({
    type: "ready",
    inputSampleRate: relayInputSampleRate,
    outputSampleRate: relayOutputSampleRate,
  });
  log.debug("ready sent", {
    traceId: trace.traceId,
    stage: "ready_sent",
    ms: msSinceStart(trace),
    sessionId: session.id,
  });

  socket.on("message", (raw: RawData) => {
    try {
      const payload = JSON.parse(raw.toString()) as ClientMessage;

      const incomingTraceId = (payload as any)?.traceId;
      if (typeof incomingTraceId === "string" && incomingTraceId.trim()) {
        trace.traceId = incomingTraceId.trim();
      }

      switch (payload.type) {
        case "start": {
          if (payload.traceId && payload.traceId.trim()) trace.traceId = payload.traceId.trim();
          callSid = payload.callSid ?? callSid;
          streamSid = payload.streamSid ?? streamSid;

          // Negotiate per-call output sample rate (phone can request 8000Hz).
          const allowedOutputRates = new Set([8000, 16000, 24000]);
          const requestedOutputSampleRate = payload.outputSampleRate;
          if (typeof requestedOutputSampleRate === "number" && allowedOutputRates.has(requestedOutputSampleRate)) {
            relayOutputSampleRate = requestedOutputSampleRate;
          } else {
            relayOutputSampleRate = defaultRelayOutputSampleRate;
          }

          mark(trace, "start_received");
          log.info("start received", {
            traceId: trace.traceId,
            stage: "start_received",
            ms: msSinceStart(trace),
            sessionId: session.id,
            callSid,
            streamSid,
            requestedOutputSampleRate,
            relayOutputSampleRate,
          });

          // Re-advertise negotiated rates (backwards-compatible for clients that ignore extra fields).
          sendEvent({
            type: "ready",
            inputSampleRate: relayInputSampleRate,
            outputSampleRate: relayOutputSampleRate,
          });

          void supabaseUpsertCall({
            callSid,
            streamSid,
            traceId: trace.traceId,
            sessionId: session.id,
            relayInputSampleRate: relayInputSampleRate,
            relayOutputSampleRate: relayOutputSampleRate,
            startedAtMs: payload.startedAt,
          });
          break;
        }
        case "audio_chunk": {
          if (typeof payload.audio !== "string" || !payload.audio) {
            throw new Error("audio_chunk payload missing base64 audio field");
          }
          const chunk = Buffer.from(payload.audio, "base64");
          appendAudioChunk(session, chunk);
          audioChunksIn += 1;
          break;
        }
        case "commit": {
          mark(trace, "commit_received");
          log.info("commit received", {
            traceId: trace.traceId,
            stage: "commit_received",
            ms: msSinceStart(trace),
            sessionId: session.id,
            callSid,
            streamSid,
            audioChunksIn,
            reason: payload.reason,
          });
          void handleCommit(payload.instructions);
          break;
        }
        case "text": {
          const text = payload.text?.trim();
          if (!text) throw new Error("text payload must include non-empty text field");
          mark(trace, "text_received");
          log.info("text received", {
            traceId: trace.traceId,
            stage: "text_received",
            ms: msSinceStart(trace),
            sessionId: session.id,
            callSid,
            streamSid,
            textLen: text.length,
          });
          void handleTurnFromText(text);
          break;
        }
        case "end": {
          socket.close();
          break;
        }
        default:
          throw new Error("Unsupported payload type");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      log.warn("ws message handling failed", {
        traceId: trace.traceId,
        stage: "ws_message_error",
        ms: msSinceStart(trace),
        sessionId: session.id,
        err: msg,
      });
      fail(msg);
    }
  });

  socket.on("close", () => {
    void supabaseMarkCallEnded(callSid);
    log.info("ws closed", {
      traceId: trace.traceId,
      stage: "ws_closed",
      ms: msSinceStart(trace),
      sessionId: session.id,
      callSid,
      streamSid,
      audioChunksIn,
    });
  });

  socket.on("error", (error: Error) => {
    log.warn("ws error", {
      traceId: trace.traceId,
      stage: "ws_error",
      ms: msSinceStart(trace),
      sessionId: session.id,
      err: error.message,
    });
    socket.close();
  });
});

server.listen(PORT, () => {
  log.info("ragnar-backend-v2 listening", { url: `http://localhost:${PORT}`, ws: `/relay` });
});
