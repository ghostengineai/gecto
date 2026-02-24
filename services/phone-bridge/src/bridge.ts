import WebSocket, { RawData } from "ws";
import { v4 as uuid } from "uuid";
import { decodeMuLaw, resampleLinear, int16ToBase64, encodeMuLaw, base64ToInt16, computeRms } from "./audio";
import type { BridgeConfig, TwilioEvent, TwilioMediaEvent, TwilioStartEvent, TwilioDtmfEvent } from "./types";
import { log } from "./util/log";
import { createTrace, mark, msSinceStart, type Trace } from "./util/trace";

const TWILIO_SAMPLE_RATE = 8000;
const TWILIO_FRAME_MS = 20;
const TWILIO_FRAME_SAMPLES = (TWILIO_SAMPLE_RATE / 1000) * TWILIO_FRAME_MS; // 160

export type BridgeSession = {
  streamSid: string;
  callSid: string;
  trace: Trace;
  twilioSocket: WebSocket;
  relaySocket?: WebSocket;
  relayId?: string;
  relayReady: boolean;
  relaySendQueue: string[];
  outgoingMuLawBuffer: Buffer;
  hasPendingAudio: boolean;
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

  constructor(private readonly config: BridgeConfig) {}

  public handleTwilioSocket(ws: WebSocket) {
    ws.on("message", (data: RawData) => {
      try {
        const payload = JSON.parse(data.toString()) as TwilioEvent;
        this.routeTwilioEvent(ws, payload);
      } catch (error) {
        log.warn("twilio payload parse failed", {
          component: "phone-bridge",
          err: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ws.on("close", () => {
      const session = this.findSessionBySocket(ws);
      if (session) {
        this.teardown(session.streamSid, "twilio_close");
      }
    });

    ws.on("error", (err) => {
      log.warn("twilio socket error", {
        component: "phone-bridge",
        err: err instanceof Error ? err.message : String(err),
      });
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
      log.warn("streamless twilio event", { component: "phone-bridge", event: event.event });
      return;
    }

    const session = this.sessions.get(event.streamSid);
    if (!session) {
      log.warn("event for unknown stream", { component: "phone-bridge", streamSid: event.streamSid, event: event.event });
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
      log.warn("stream already exists", { component: "phone-bridge", streamSid, callSid });
      return;
    }

    const trace = createTrace(callSid);
    mark(trace, "twilio_start");

    const session: BridgeSession = {
      streamSid,
      callSid,
      trace,
      twilioSocket: ws,
      relayReady: false,
      relaySendQueue: [],
      outgoingMuLawBuffer: Buffer.alloc(0),
      hasPendingAudio: false,
      silenceMs: 0,
      lastSpeechAt: Date.now(),
      createdAt: Date.now(),
      audioInChunks: 0,
      audioOutChunks: 0,
    };

    this.sessions.set(streamSid, session);
    log.info("call started", {
      component: "phone-bridge",
      traceId: trace.traceId,
      stage: "twilio_start",
      ms: msSinceStart(trace),
      callSid,
      streamSid,
    });
    this.connectRelay(session);
  }

  private connectRelay(session: BridgeSession) {
    const relay = new WebSocket(this.config.relayUrl);
    session.relaySocket = relay;
    session.relayId = uuid();

    relay.on("open", () => {
      mark(session.trace, "relay_ws_open");
      log.info("relay ws open", {
        component: "phone-bridge",
        traceId: session.trace.traceId,
        stage: "relay_ws_open",
        ms: msSinceStart(session.trace),
        streamSid: session.streamSid,
      });

      // Backwards-compatible: servers not expecting this can ignore it.
      this.dispatchToRelay(
        session,
        JSON.stringify({
          type: "start",
          traceId: session.trace.traceId,
          callSid: session.callSid,
          streamSid: session.streamSid,
          startedAt: session.trace.startedAt,
        }),
      );
    });

    relay.on("message", (data: RawData) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handleRelayEvent(session, payload);
      } catch (error) {
        log.warn("relay payload parse failed", {
          component: "phone-bridge",
          traceId: session.trace.traceId,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    });

    relay.on("close", () => {
      if (this.sessions.has(session.streamSid)) {
        this.teardown(session.streamSid, "relay_close");
      }
    });

    relay.on("error", (error) => {
      log.warn("relay ws error", {
        component: "phone-bridge",
        traceId: session.trace.traceId,
        err: error instanceof Error ? error.message : String(error),
      });
      this.teardown(session.streamSid, "relay_error");
    });
  }

  private handleRelayEvent(session: BridgeSession, payload: any) {
    switch (payload.type) {
      case "ready":
        session.relayReady = true;
        mark(session.trace, "relay_ready");
        log.info("relay ready", {
          component: "phone-bridge",
          traceId: session.trace.traceId,
          stage: "relay_ready",
          ms: msSinceStart(session.trace),
          streamSid: session.streamSid,
        });
        this.flushQueue(session);
        break;
      case "audio_delta":
        this.pipeRelayAudioToTwilio(session, payload.audio as string);
        break;
      case "response_completed":
        session.outgoingMuLawBuffer = Buffer.alloc(0);
        log.info("response completed", {
          component: "phone-bridge",
          traceId: session.trace.traceId,
          stage: "relay_response_completed",
          ms: msSinceStart(session.trace),
          streamSid: session.streamSid,
          responseId: payload.responseId,
        });
        break;
      case "error":
        log.warn("relay error", {
          component: "phone-bridge",
          traceId: session.trace.traceId,
          streamSid: session.streamSid,
          err: String(payload.error ?? "unknown"),
        });
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
      traceId: session.trace.traceId,
    });
    this.dispatchToRelay(session, relayPayload);
  }

  private commit(session: BridgeSession, reason: string) {
    session.hasPendingAudio = false;
    session.silenceMs = 0;
    mark(session.trace, `commit_${reason}`);
    this.dispatchToRelay(
      session,
      JSON.stringify({ type: "commit", traceId: session.trace.traceId, reason }),
    );
    log.info("commit", {
      component: "phone-bridge",
      traceId: session.trace.traceId,
      stage: "commit",
      ms: msSinceStart(session.trace),
      streamSid: session.streamSid,
      reason,
    });
  }

  private interruptRelay(session: BridgeSession) {
    this.dispatchToRelay(session, JSON.stringify({ type: "end", traceId: session.trace.traceId }));
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

    log.info("teardown", {
      component: "phone-bridge",
      traceId: session.trace.traceId,
      stage: "teardown",
      ms: msSinceStart(session.trace),
      streamSid,
      callSid: session.callSid,
      reason,
      audioInChunks: session.audioInChunks,
      audioOutChunks: session.audioOutChunks,
    });
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
