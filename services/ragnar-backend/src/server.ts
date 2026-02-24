import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

dotenv.config();

const PORT = Number(process.env.RAGNAR_BACKEND_PORT ?? process.env.PORT ?? 5051);
const RAGNAR_PROMPT =
  process.env.RAGNAR_PROMPT ??
  "You are Ragnar, a calm, thoughtful AI guide. Keep responses concise, acknowledge what you heard, and offer helpful follow-ups.";

const app = express();
app.get("/healthz", (_, res) => {
  res.json({ ok: true, promptPreview: RAGNAR_PROMPT.slice(0, 60) });
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

interface AssistantResponse {
  text: string;
  audio: string;
  responseId: string;
}

class PlaceholderAssistant {
  private turnCounter = 0;

  generateResponse(userText: string, instructions?: string): AssistantResponse {
    this.turnCounter += 1;
    const trimmed = userText.trim() || "your last message";
    const extraInstruction = instructions?.trim()
      ? ` I also kept in mind: ${instructions.trim()}.`
      : "";
    const text = `Ragnar (${this.turnCounter}): I heard "${trimmed}" and I'm crafting a thoughtful follow-up.${extraInstruction} Here's a placeholder suggestion so you can wire up downstream flows.`;
    return {
      text,
      audio: this.buildAudioStub(),
      responseId: `resp_${this.turnCounter}_${randomUUID().slice(0, 8)}`,
    };
  }

  chunkText(text: string, maxLength = 80): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return [];
    }
    const chunks: string[] = [];
    let current: string[] = [];
    for (const word of words) {
      const candidate = current.length ? `${current.join(" ")} ${word}` : word;
      if (candidate.length > maxLength && current.length) {
        chunks.push(current.join(" "));
        current = [word];
      } else {
        current.push(word);
      }
    }
    if (current.length) {
      chunks.push(current.join(" "));
    }
    return chunks;
  }

  private buildAudioStub(): string {
    const sampleCount = 320; // ~20ms @ 16kHz mono PCM16
    const buffer = Buffer.alloc(sampleCount * 2);
    return buffer.toString("base64");
  }
}

const formatBytes = (bytes: number): string => {
  if (bytes <= 0) return "0 bytes";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

wss.on("connection", (socket: WebSocket) => {
  const assistant = new PlaceholderAssistant();
  let bufferedAudioBytes = 0;
  let bufferedChunks = 0;

  const sendEvent = (event: RelayEvent) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  };

  const handleTurn = (userText: string, instructions?: string) => {
    const transcript = userText.trim() || "(placeholder transcript)";
    sendEvent({ type: "transcript", text: transcript });
    const response = assistant.generateResponse(transcript, instructions);
    const deltas = assistant.chunkText(response.text);
    deltas.forEach((text) => {
      if (text) {
        sendEvent({ type: "text_delta", text });
      }
    });
    sendEvent({ type: "text_completed", text: response.text });
    if (response.audio) {
      sendEvent({ type: "audio_delta", audio: response.audio });
    }
    sendEvent({ type: "response_completed", responseId: response.responseId });
  };

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
          bufferedAudioBytes += chunk.byteLength;
          bufferedChunks += 1;
          break;
        }
        case "commit": {
          const transcriptText = bufferedAudioBytes
            ? `Placeholder transcript for ${formatBytes(bufferedAudioBytes)} across ${bufferedChunks} chunk(s).`
            : "No audio detected before commit; responding with an empty placeholder transcript.";
          handleTurn(transcriptText, payload.instructions);
          bufferedAudioBytes = 0;
          bufferedChunks = 0;
          break;
        }
        case "text": {
          const text = payload.text?.trim();
          if (!text) {
            throw new Error("text payload must include non-empty text field");
          }
          handleTurn(text);
          break;
        }
        case "end": {
          socket.close();
          break;
        }
        default:
          throw new Error("Unsupported payload type");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendEvent({ type: "error", error: message });
    }
  });

  socket.on("close", () => {
    bufferedAudioBytes = 0;
    bufferedChunks = 0;
  });

  socket.on("error", (error: Error) => {
    console.error("Client socket error", error);
    sendEvent({ type: "error", error: "Backend socket error" });
    socket.close();
  });
});

server.listen(PORT, () => {
  console.log(`Ragnar backend listening on http://localhost:${PORT}`);
});
