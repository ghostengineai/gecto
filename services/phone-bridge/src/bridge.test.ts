import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { PhoneBridgeManager } from "./bridge";
import type { BridgeConfig } from "./types";
import {
  encodeMuLaw,
  int16ToBase64,
  resampleLinear,
  base64ToInt16,
} from "./audio";

const STREAM_SID = "MS123";
const CALL_SID = "CAX123";

async function waitFor(predicate: () => boolean, timeout = 2000) {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PhoneBridgeManager", () => {
  let relayServer: WebSocketServer;
  let twilioServer: WebSocketServer;
  let twilioClient: WebSocket;
  let relayMessages: any[];
  let twilioMessages: any[];
  let relaySocket: WebSocket | null;
  let manager: PhoneBridgeManager;

  beforeEach(async () => {
    relayMessages = [];
    twilioMessages = [];
    relaySocket = null;

    relayServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => relayServer.on("listening", resolve));
    const relayPort = (relayServer.address() as AddressInfo).port;
    relayServer.on("connection", (socket) => {
      relaySocket = socket;
      socket.on("message", (data) => {
        relayMessages.push(JSON.parse(data.toString()));
      });
    });

    const config: BridgeConfig = {
      port: 0,
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      relayInputSampleRate: 16000,
      relayOutputSampleRate: 24000,
      commitSilenceMs: 900,
      vadThreshold: 0.012,
      publicBaseUrl: "https://example.com",
      twilioWebhookPath: "/twilio/voice",
    };

    manager = new PhoneBridgeManager(config);

    twilioServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => twilioServer.on("listening", resolve));
    const twilioPort = (twilioServer.address() as AddressInfo).port;

    twilioServer.on("connection", (socket) => {
      manager.handleTwilioSocket(socket);
    });

    twilioClient = new WebSocket(`ws://127.0.0.1:${twilioPort}`);
    await new Promise<void>((resolve) => twilioClient.on("open", resolve));
    twilioClient.on("message", (data) => {
      twilioMessages.push(JSON.parse(data.toString()));
    });

    twilioClient.send(
      JSON.stringify({
        event: "start",
        start: {
          streamSid: STREAM_SID,
          callSid: CALL_SID,
          accountSid: "AC123",
          mediaFormat: {
            encoding: "audio/pcmu",
            sampleRate: 8000,
            channels: 1,
          },
        },
      }),
    );

    await waitFor(() => relaySocket !== null);
  });

  afterEach(async () => {
    await delay(10);
    await Promise.all([
      new Promise<void>((resolve) => {
        if (!twilioClient || twilioClient.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        twilioClient.once("close", () => resolve());
        twilioClient.close();
      }),
      new Promise<void>((resolve) => {
        if (!relayServer) {
          resolve();
          return;
        }
        relayServer.close(() => resolve());
      }),
      new Promise<void>((resolve) => {
        if (!twilioServer) {
          resolve();
          return;
        }
        twilioServer.close(() => resolve());
      }),
    ]);
  });

  it("flushes queued Twilio audio into the relay once ready and commits via DTMF", async () => {
    const speechFrame = new Int16Array(160);
    for (let i = 0; i < speechFrame.length; i += 1) {
      speechFrame[i] = i % 2 === 0 ? 6000 : -6000;
    }
    const muLawPayload = encodeMuLaw(speechFrame).toString("base64");

    twilioClient.send(
      JSON.stringify({
        event: "media",
        streamSid: STREAM_SID,
        media: { payload: muLawPayload },
      }),
    );

    await delay(50);
    // We now send `start` immediately on relay WS open so it always arrives before audio/commit.
    // The important behavior is that audio is buffered until relay is ready.
    expect(relayMessages.some((m) => m.type === "audio_chunk")).toBe(false);

    relaySocket!.send(JSON.stringify({ type: "ready" }));

    await waitFor(() => relayMessages.some((msg) => msg.type === "audio_chunk"));
    const chunkEvent = relayMessages.find((msg) => msg.type === "audio_chunk");
    expect(chunkEvent).toBeDefined();
    const chunkPcm = base64ToInt16(chunkEvent.audio);
    expect(chunkPcm.length).toBe(320);

    twilioClient.send(
      JSON.stringify({
        event: "dtmf",
        streamSid: STREAM_SID,
        dtmf: { digits: "#" },
      }),
    );

    await waitFor(() => relayMessages.some((msg) => msg.type === "commit"));
    const commitEvent = relayMessages.find((msg) => msg.type === "commit");
    expect(commitEvent?.type).toBe("commit");
  });

  it("pipes relay audio deltas back to Twilio as outbound frames", async () => {
    relaySocket!.send(JSON.stringify({ type: "ready" }));

    const relayPcm = new Int16Array(480);
    for (let i = 0; i < relayPcm.length; i += 1) {
      relayPcm[i] = Math.round(Math.sin((Math.PI * 2 * i) / relayPcm.length) * 12000);
    }
    const base64Audio = int16ToBase64(relayPcm);

    relaySocket!.send(
      JSON.stringify({
        type: "audio_delta",
        audio: base64Audio,
      }),
    );

    await waitFor(() => twilioMessages.some((msg) => msg.event === "media"));
    const outboundFrame = twilioMessages.find((msg) => msg.event === "media");
    // Outbound injected frames should be minimal; do not require a track field.
    expect(outboundFrame.media.payload).toBeTypeOf("string");
    const payloadBuffer = Buffer.from(outboundFrame.media.payload, "base64");
    expect(payloadBuffer.length).toBe(160);

    const expectedResample = resampleLinear(relayPcm, 24000, 8000);
    const expectedMuLaw = encodeMuLaw(expectedResample);
    expect(payloadBuffer.equals(expectedMuLaw)).toBe(true);
  });
});
