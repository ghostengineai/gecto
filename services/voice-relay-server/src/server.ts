import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import dotenv from "dotenv";

dotenv.config();

const PORT = Number(process.env.VOICE_RELAY_PORT ?? process.env.PORT ?? 5050);
const BACKEND_URL = process.env.RAGNAR_BACKEND_URL ?? "ws://localhost:5051/relay";

const app = express();
app.get("/healthz", (_, res) => {
  res.json({ ok: true, backend: BACKEND_URL });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (client: WebSocket) => {
  const backend = new WebSocket(BACKEND_URL);
  const pendingForBackend: RawData[] = [];
  let backendReady = false;

  const sendClientError = (error: string) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "error", error }));
    }
  };

  const closeBoth = () => {
    try {
      backend.close();
    } catch (err) {
      console.error("Failed to close backend socket", err);
    }
    try {
      client.close();
    } catch (err) {
      console.error("Failed to close client socket", err);
    }
  };

  const flushPending = () => {
    while (backendReady && pendingForBackend.length) {
      const next = pendingForBackend.shift();
      if (next) {
        backend.send(next);
      }
    }
  };

  backend.on("open", () => {
    backendReady = true;
    flushPending();
  });

  backend.on("message", (data: RawData) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });

  backend.on("close", () => {
    sendClientError("Ragnar backend connection closed");
    if (client.readyState === WebSocket.OPEN) {
      client.close();
    }
  });

  backend.on("error", (error: Error) => {
    console.error("Backend socket error", error);
    sendClientError("Unable to reach Ragnar backend");
    closeBoth();
  });

  client.on("message", (raw: RawData) => {
    if (backendReady && backend.readyState === WebSocket.OPEN) {
      backend.send(raw);
    } else {
      pendingForBackend.push(raw);
    }
  });

  client.on("close", () => {
    backend.close();
  });

  client.on("error", (error: Error) => {
    console.error("Client socket error", error);
    closeBoth();
  });
});

server.listen(PORT, () => {
  console.log(`Voice relay server listening on http://localhost:${PORT}`);
});
