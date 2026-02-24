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
import { log } from "./util/log";

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
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/relay" });

type ClientMessage =
  | { type: "audio_chunk"; audio: string }
  | { type: "commit"; instructions?: string }
  | { type: "text"; text: string }
  | { type: "end" };

type RelayEvent =
  | { type: "ready" }
  | { type: "error"; error: string }
  | { type: "text_delta"; text: string }
  | { type: "text_completed"; text: string }
  | { type: "audio_delta"; audio: string }
  | { type: "response_completed"; responseId: string }
  | { type: "transcript"; text: string };

wss.on("connection", (socket: WebSocket) => {
  const session = createSession();
  const convo = new ConversationCore();

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
    sendEvent({ type: "transcript", text: transcript });

    const response = convo.respond({ userText: transcript, instructions });
    const responseId = `resp_${randomUUID().slice(0, 10)}`;

    for (const d of convo.chunkText(response.text)) {
      sendEvent({ type: "text_delta", text: d });
    }
    sendEvent({ type: "text_completed", text: response.text });

    // synthesize after text is complete (keeps implementation simple)
    try {
      const ttsRes = await tts.synthesize(response.text);
      for (const chunk of chunkPcm16(ttsRes.pcm16)) {
        sendEvent({ type: "audio_delta", audio: chunk.toString("base64") });
      }
    } catch (e) {
      log.warn("tts failed", { err: e instanceof Error ? e.message : String(e) });
      // allow session to continue even if TTS fails
    }

    sendEvent({ type: "response_completed", responseId });
  };

  const handleCommit = async (instructions?: string) => {
    const audio = consumeBufferedAudio(session);
    if (!audio.length) {
      await handleTurnFromText("", instructions);
      return;
    }

    try {
      const asrRes = await asr.transcribePcm16kMono(audio);
      const text = asrRes.text || "";
      await handleTurnFromText(text, instructions);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "ASR error";
      log.warn("asr failed", { err: msg });
      fail(msg);
    }
  };

  log.info("ws connected", { sessionId: session.id });
  sendEvent({ type: "ready" });

  socket.on("message", (raw: RawData) => {
    try {
      const payload = JSON.parse(raw.toString()) as ClientMessage;

      switch (payload.type) {
        case "audio_chunk": {
          if (typeof payload.audio !== "string" || !payload.audio) {
            throw new Error("audio_chunk payload missing base64 audio field");
          }
          const chunk = Buffer.from(payload.audio, "base64");
          appendAudioChunk(session, chunk);
          break;
        }
        case "commit": {
          void handleCommit(payload.instructions);
          break;
        }
        case "text": {
          const text = payload.text?.trim();
          if (!text) throw new Error("text payload must include non-empty text field");
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
      fail(msg);
    }
  });

  socket.on("close", () => {
    log.info("ws closed", { sessionId: session.id });
  });

  socket.on("error", (error: Error) => {
    log.warn("ws error", { sessionId: session.id, err: error.message });
    socket.close();
  });
});

server.listen(PORT, () => {
  log.info("ragnar-backend-v2 listening", { url: `http://localhost:${PORT}`, ws: `/relay` });
});
