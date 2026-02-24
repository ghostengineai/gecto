import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import dotenv from "dotenv";
import { log, newTraceId } from "./util/log";

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
  const startedAt = Date.now();
  let traceId: string | undefined;
  let sawStart = false;
  let clientMsgCount = 0;
  let backendMsgCount = 0;

  const backend = new WebSocket(BACKEND_URL);
  const pendingForBackend: RawData[] = [];
  let backendReady = false;

  const ensureTrace = () => {
    if (!traceId) traceId = newTraceId();
    return traceId;
  };

  log.info("client connected", {
    component: "voice-relay-server",
    stage: "client_connected",
    traceId: ensureTrace(),
    ms: Date.now() - startedAt,
  });

  const sendClientError = (error: string) => {
    log.warn("client error", {
      component: "voice-relay-server",
      traceId: ensureTrace(),
      stage: "client_error",
      ms: Date.now() - startedAt,
      err: error,
    });
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "error", error }));
    }
  };

  const closeBoth = () => {
    try {
      backend.close();
    } catch (err) {
      log.warn("failed to close backend socket", {
        component: "voice-relay-server",
        traceId: ensureTrace(),
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      client.close();
    } catch (err) {
      log.warn("failed to close client socket", {
        component: "voice-relay-server",
        traceId: ensureTrace(),
        err: err instanceof Error ? err.message : String(err),
      });
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
    log.info("backend ws open", {
      component: "voice-relay-server",
      traceId: ensureTrace(),
      stage: "backend_ws_open",
      ms: Date.now() - startedAt,
      backend: BACKEND_URL,
    });
    flushPending();
  });

  backend.on("message", (data: RawData) => {
    backendMsgCount += 1;
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });

  backend.on("close", () => {
    log.info("backend ws closed", {
      component: "voice-relay-server",
      traceId: ensureTrace(),
      stage: "backend_ws_closed",
      ms: Date.now() - startedAt,
      backendMsgCount,
      clientMsgCount,
    });
    sendClientError("Ragnar backend connection closed");
    if (client.readyState === WebSocket.OPEN) {
      client.close();
    }
  });

  backend.on("error", (error: Error) => {
    log.warn("backend ws error", {
      component: "voice-relay-server",
      traceId: ensureTrace(),
      stage: "backend_ws_error",
      ms: Date.now() - startedAt,
      err: error.message,
    });
    sendClientError("Unable to reach Ragnar backend");
    closeBoth();
  });

  client.on("message", (raw: RawData) => {
    clientMsgCount += 1;

    // Opportunistically sniff traceId from a JSON payload.
    try {
      const parsed = JSON.parse(raw.toString());
      if (typeof parsed?.traceId === "string" && parsed.traceId.trim()) {
        traceId = parsed.traceId.trim();
      }
      if (parsed?.type === "start") {
        sawStart = true;
      }
    } catch {
      // ignore
    }

    if (backendReady && backend.readyState === WebSocket.OPEN) {
      backend.send(raw);
    } else {
      pendingForBackend.push(raw);
    }
  });

  client.on("close", () => {
    log.info("client ws closed", {
      component: "voice-relay-server",
      traceId: ensureTrace(),
      stage: "client_ws_closed",
      ms: Date.now() - startedAt,
      clientMsgCount,
      backendMsgCount,
      sawStart,
    });
    backend.close();
  });

  client.on("error", (error: Error) => {
    log.warn("client ws error", {
      component: "voice-relay-server",
      traceId: ensureTrace(),
      stage: "client_ws_error",
      ms: Date.now() - startedAt,
      err: error.message,
    });
    closeBoth();
  });
});

server.listen(PORT, () => {
  log.info("listening", { component: "voice-relay-server", url: `http://localhost:${PORT}`, backend: BACKEND_URL });
});
