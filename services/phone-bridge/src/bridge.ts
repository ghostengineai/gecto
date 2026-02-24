import WebSocket, { RawData } from "ws";
import { v4 as uuid } from "uuid";
import { decodeMuLaw, resampleLinear, int16ToBase64, encodeMuLaw, base64ToInt16, computeRms } from "./audio";
import type { BridgeConfig, OutboundPlan, TwilioEvent, TwilioMediaEvent, TwilioStartEvent, TwilioDtmfEvent } from "./types";

const TWILIO_SAMPLE_RATE = 8000;
const TWILIO_FRAME_MS = 20;
const TWILIO_FRAME_SAMPLES = (TWILIO_SAMPLE_RATE / 1000) * TWILIO_FRAME_MS; // 160

export type BridgeSession = {
  streamSid: string;
  callSid: string;
  twilioSocket: WebSocket;
  relaySocket?: WebSocket;
  relayId?: string;
  relayReady: boolean;
  relaySendQueue: string[];
  outgoingMuLawBuffer: Buffer;
  hasPendingAudio: boolean;
  greeted: boolean;
  outboundPlan?: OutboundPlan;
  silenceMs: number;
  lastSpeechAt: number;
  createdAt: number;
  audioInChunks: number;
  audioOutChunks: number;
};

function isStreamEvent(event: TwilioEvent): event is TwilioEvent & { streamSid: string } {
  return typeof (event as any)?.streamSid === "string";
}

export class PhoneBridgeManager {
  private sessions = new Map<string, BridgeSession>();
  private outboundPlans = new Map<string, OutboundPlan>(); // callSid -> plan

  constructor(private readonly config: BridgeConfig) {}

  public setOutboundPlan(callSid: string, plan: OutboundPlan) {
    if (!callSid) return;
    this.outboundPlans.set(callSid, plan);
  }

  public handleTwilioSocket(ws: WebSocket) {
    ws.on("message", (data: RawData) => {
      try {
        const payload = JSON.parse(data.toString()) as TwilioEvent;
        this.routeTwilioEvent(ws, payload);
      } catch (error) {
        console.error("[phone-bridge] failed to parse Twilio payload", error);
      }
    });

    ws.on("close", () => {
      const session = this.findSessionBySocket(ws);
      if (session) {
        this.teardown(session.streamSid, "twilio_close");
      }
    });

    ws.on("error", (err) => {
      console.error("[phone-bridge] Twilio socket error", err);
      const session = this.findSessionBySocket(ws);
      if (session) {
        this.teardown(session.streamSid, "twilio_error");
      }
    });
  }

  private routeTwilioEvent(ws: WebSocket, event: TwilioEvent) {
    if (event.event === "start") {
      this.startSession(ws, event as TwilioStartEvent);
      return;
    }

    if (!isStreamEvent(event)) {
      console.warn("[phone-bridge] Received streamless event", event.event);
      return;
    }

    const session = this.sessions.get(event.streamSid);
    if (!session) {
      console.warn("[phone-bridge] Received event for unknown stream", event.streamSid);
      return;
    }

    switch (event.event) {
      case "media":
        this.handleMedia(session, event as TwilioMediaEvent);
        break;
      case "mark":
        break; // ignore for now
      case "dtmf":
        this.handleDtmf(session, event as TwilioDtmfEvent);
        break;
      case "stop":
        this.teardown(session.streamSid, "twilio_stop");
        break;
      default:
        break;
    }
  }

  private startSession(ws: WebSocket, event: TwilioStartEvent) {
    const { streamSid, callSid } = event.start;
    if (this.sessions.has(streamSid)) {
      console.warn("[phone-bridge] stream already exists", streamSid);
      return;
    }

    const outboundPlan = this.outboundPlans.get(callSid);

    const session: BridgeSession = {
      streamSid,
      callSid,
      twilioSocket: ws,
      relayReady: false,
      relaySendQueue: [],
      outgoingMuLawBuffer: Buffer.alloc(0),
      hasPendingAudio: false,
      greeted: false,
      outboundPlan,
      silenceMs: 0,
      lastSpeechAt: Date.now(),
      createdAt: Date.now(),
      audioInChunks: 0,
      audioOutChunks: 0,
    };

    this.sessions.set(streamSid, session);
    console.log(`[phone-bridge] start call ${callSid} (${streamSid})`);
    this.connectRelay(session);
  }

  private connectRelay(session: BridgeSession) {
    const relay = new WebSocket(this.config.relayUrl);
    session.relaySocket = relay;
    session.relayId = uuid();

    relay.on("open", () => {
      console.log(`[phone-bridge] relay socket ready for stream ${session.streamSid}`);
    });

    relay.on("message", (data: RawData) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handleRelayEvent(session, payload);
      } catch (error) {
        console.error("[phone-bridge] failed to parse relay payload", error);
      }
    });

    relay.on("close", () => {
      if (this.sessions.has(session.streamSid)) {
        this.teardown(session.streamSid, "relay_close");
      }
    });

    relay.on("error", (error) => {
      console.error("[phone-bridge] relay error", error);
      this.teardown(session.streamSid, "relay_error");
    });
  }

  private handleRelayEvent(session: BridgeSession, payload: any) {
    switch (payload.type) {
      case "ready":
        session.relayReady = true;
        this.flushQueue(session);

        // Outbound: speak first when we have an opener.
        if (!session.greeted && session.outboundPlan?.openerText) {
          session.greeted = true;
          const callerName = session.outboundPlan.callerName?.trim() || "Ragnar";
          const opener = session.outboundPlan.openerText.trim();
          const instructions =
            `You are ${callerName}. You placed this outbound phone call. ` +
            `Say the following opener exactly (then stop and wait for a reply): ${JSON.stringify(opener)}.`;
          this.dispatchToRelay(session, JSON.stringify({ type: "commit", instructions, reason: "outbound_greeting" }));
        }
        break;
      case "audio_delta":
        this.pipeRelayAudioToTwilio(session, payload.audio as string);
        break;
      case "response_completed":
        session.outgoingMuLawBuffer = Buffer.alloc(0);
        break;
      case "error":
        console.error(`[phone-bridge] relay error for ${session.streamSid}:`, payload.error);
        break;
      default:
        break;
    }
  }

  private pipeRelayAudioToTwilio(session: BridgeSession, base64Audio: string) {
    session.audioOutChunks += 1;
    const pcm = base64ToInt16(base64Audio);
    const downsampled = resampleLinear(
      pcm,
      this.config.relayOutputSampleRate,
      TWILIO_SAMPLE_RATE,
    );
    const muLaw = encodeMuLaw(downsampled);
    session.outgoingMuLawBuffer = Buffer.concat([session.outgoingMuLawBuffer, muLaw]);

    while (session.outgoingMuLawBuffer.length >= TWILIO_FRAME_SAMPLES) {
      const frame = session.outgoingMuLawBuffer.subarray(0, TWILIO_FRAME_SAMPLES);
      session.outgoingMuLawBuffer = session.outgoingMuLawBuffer.slice(TWILIO_FRAME_SAMPLES);
      this.sendTwilioMediaFrame(session, Buffer.from(frame));
    }
  }

  private sendTwilioMediaFrame(session: BridgeSession, frame: Buffer) {
    if (session.twilioSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    session.twilioSocket.send(
      JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: {
          payload: frame.toString("base64"),
          track: "outbound",
        },
      }),
    );
  }

  private handleMedia(session: BridgeSession, event: TwilioMediaEvent) {
    const samples8k = decodeMuLaw(event.media.payload);
    const samplesTarget = resampleLinear(
      samples8k,
      TWILIO_SAMPLE_RATE,
      this.config.relayInputSampleRate,
    );
    this.sendAudioChunk(session, samplesTarget);
    this.runVad(session, samples8k);
  }

  private runVad(session: BridgeSession, samples: Int16Array) {
    const rms = computeRms(samples);
    if (rms >= this.config.vadThreshold) {
      session.hasPendingAudio = true;
      session.silenceMs = 0;
      session.lastSpeechAt = Date.now();
      return;
    }

    session.silenceMs += TWILIO_FRAME_MS;
    if (
      session.hasPendingAudio &&
      session.silenceMs >= this.config.commitSilenceMs
    ) {
      this.commit(session, "silence");
    }
  }

  private handleDtmf(session: BridgeSession, event: TwilioDtmfEvent) {
    const digit = event.dtmf.digits;
    if (digit === "#") {
      this.commit(session, "dtmf");
    }
    if (digit === "*") {
      this.interruptRelay(session);
    }
  }

  private sendAudioChunk(session: BridgeSession, samples: Int16Array) {
    session.audioInChunks += 1;
    const relayPayload = JSON.stringify({
      type: "audio_chunk",
      audio: int16ToBase64(samples),
    });
    this.dispatchToRelay(session, relayPayload);
  }

  private commit(session: BridgeSession, reason: string, instructions?: string) {
    session.hasPendingAudio = false;
    session.silenceMs = 0;
    this.dispatchToRelay(
      session,
      JSON.stringify({ type: "commit", reason, instructions }),
    );
    console.log(`[phone-bridge] commit (${reason}) for stream ${session.streamSid}`);
  }

  private interruptRelay(session: BridgeSession) {
    this.dispatchToRelay(session, JSON.stringify({ type: "end" }));
  }

  private dispatchToRelay(session: BridgeSession, payload: string) {
    if (session.relayReady && session.relaySocket?.readyState === WebSocket.OPEN) {
      session.relaySocket.send(payload);
    } else {
      session.relaySendQueue.push(payload);
    }
  }

  private flushQueue(session: BridgeSession) {
    while (session.relayReady && session.relaySocket?.readyState === WebSocket.OPEN) {
      const payload = session.relaySendQueue.shift();
      if (!payload) break;
      session.relaySocket.send(payload);
    }
  }

  private teardown(streamSid: string, reason: string) {
    const session = this.sessions.get(streamSid);
    if (!session) return;

    console.log(`[phone-bridge] closing stream ${streamSid} (${reason})`);
    this.sessions.delete(streamSid);

    try {
      session.twilioSocket.close();
    } catch {}

    try {
      session.relaySocket?.close();
    } catch {}
  }

  private findSessionBySocket(ws: WebSocket): BridgeSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.twilioSocket === ws) {
        return session;
      }
    }
    return undefined;
  }
}
