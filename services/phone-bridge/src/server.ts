import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { Request, Response, NextFunction } from "express";
import twilio, { twiml } from "twilio";
import bodyParser from "body-parser";
import { PhoneBridgeManager } from "./bridge";
import type { BridgeConfig } from "./types";
import { log } from "./util/log";

const PORT = Number(process.env.PORT ?? 5060);
const RELAY_URL = process.env.VOICE_RELAY_URL ?? "ws://localhost:5050/relay";
const RELAY_INPUT_RATE = Number(process.env.RELAY_INPUT_SAMPLE_RATE ?? 16000);
const RELAY_OUTPUT_RATE = Number(process.env.RELAY_OUTPUT_SAMPLE_RATE ?? 24000);
const COMMIT_SILENCE_MS = Number(process.env.COMMIT_SILENCE_MS ?? 900);
const VAD_THRESHOLD = Number(process.env.VAD_THRESHOLD ?? 0.012);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const PUBLIC_WS_URL = process.env.PUBLIC_WS_URL ?? PUBLIC_BASE_URL?.replace(/^http/, "ws");
const TWILIO_WEBHOOK_PATH = process.env.TWILIO_WEBHOOK_PATH ?? "/twilio/voice";
const TWILIO_STREAM_PATH = process.env.TWILIO_STREAM_PATH ?? "/twilio/media";
const API_TOKEN = process.env.BRIDGE_API_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_CALLER_ID = process.env.TWILIO_CALLER_ID;
const STATUS_CALLBACK_URL = process.env.TWILIO_STATUS_CALLBACK_URL;

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const shouldValidateSignature = (() => {
  const raw = process.env.TWILIO_VALIDATE_SIGNATURE;
  if (!raw) return Boolean(TWILIO_AUTH_TOKEN);
  const normalized = raw.trim().toLowerCase();
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  return Boolean(TWILIO_AUTH_TOKEN);
})();

const config: BridgeConfig = {
  port: PORT,
  relayUrl: RELAY_URL,
  relayInputSampleRate: RELAY_INPUT_RATE,
  relayOutputSampleRate: RELAY_OUTPUT_RATE,
  commitSilenceMs: COMMIT_SILENCE_MS,
  vadThreshold: VAD_THRESHOLD,
  publicBaseUrl: PUBLIC_BASE_URL,
  twilioWebhookPath: TWILIO_WEBHOOK_PATH,
  outboundStatusCallback: STATUS_CALLBACK_URL,
  apiToken: API_TOKEN,
  twilioValidation: shouldValidateSignature,
};

if (!PUBLIC_WS_URL) {
  log.warn("PUBLIC_WS_URL or PUBLIC_BASE_URL is required so Twilio can reach the media stream", { component: "phone-bridge" });
}

const bridgeManager = new PhoneBridgeManager(config);

const app = express();
app.use(bodyParser.json());

function requireApiToken(req: Request, res: Response, next: NextFunction) {
  if (!API_TOKEN) return next();
  const header = req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  const token = header.slice("Bearer ".length);
  if (token !== API_TOKEN) {
    return res.status(403).json({ error: "Invalid token" });
  }
  return next();
}

const twilioRouter = express.Router();
twilioRouter.use(bodyParser.urlencoded({ extended: false }));

twilioRouter.post(
  TWILIO_WEBHOOK_PATH,
  maybeValidateTwilio,
  (req: Request, res: Response) => {
    if (!PUBLIC_WS_URL) {
      return res.status(500).send("Missing PUBLIC_WS_URL");
    }

    const streamUrl = new URL(PUBLIC_WS_URL);
    streamUrl.pathname = TWILIO_STREAM_PATH;

    const response = new twiml.VoiceResponse();
    const connect = response.connect();
    connect.stream({
      url: streamUrl.toString(),
      track: "inbound_track",
    });

    res.type("text/xml").send(response.toString());
  },
);

app.use(twilioRouter);

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    relayUrl: RELAY_URL,
    relayInputRate: RELAY_INPUT_RATE,
    relayOutputRate: RELAY_OUTPUT_RATE,
  });
});

app.post("/api/call", requireApiToken, async (req, res) => {
  if (!twilioClient) {
    return res.status(400).json({ error: "Twilio credentials are not configured" });
  }

  const to: string | undefined = req.body?.to;
  const from: string | undefined = req.body?.from ?? TWILIO_CALLER_ID ?? undefined;
  if (!to) {
    return res.status(400).json({ error: "Missing 'to' number" });
  }
  if (!from) {
    return res.status(400).json({ error: "Missing caller ID (set TWILIO_CALLER_ID or pass 'from')" });
  }
  if (!PUBLIC_BASE_URL) {
    return res.status(400).json({ error: "PUBLIC_BASE_URL required for voice webhook" });
  }

  try {
    const call = await twilioClient.calls.create({
      to,
      from,
      url: new URL(TWILIO_WEBHOOK_PATH, PUBLIC_BASE_URL).toString(),
      statusCallback: STATUS_CALLBACK_URL,
      statusCallbackEvent: STATUS_CALLBACK_URL
        ? ["initiated", "ringing", "answered", "completed"]
        : undefined,
    });

    res.json({ ok: true, callSid: call.sid });
  } catch (error) {
    log.error("failed to initiate call", {
      component: "phone-bridge",
      err: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: "Failed to initiate call" });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: TWILIO_STREAM_PATH });

wss.on("connection", (socket) => {
  log.info("twilio media stream connected", { component: "phone-bridge" });
  bridgeManager.handleTwilioSocket(socket);
});

server.listen(PORT, () => {
  log.info("listening", { component: "phone-bridge", url: `http://localhost:${PORT}` });
});

function maybeValidateTwilio(req: Request, res: Response, next: NextFunction) {
  if (!config.twilioValidation || !TWILIO_AUTH_TOKEN || !PUBLIC_BASE_URL) {
    return next();
  }
  const signature = req.header("x-twilio-signature") ?? "";
  const url = new URL(TWILIO_WEBHOOK_PATH, PUBLIC_BASE_URL).toString();
  const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body ?? {});
  if (!valid) {
    return res.status(403).send("Invalid Twilio signature");
  }
  return next();
}
