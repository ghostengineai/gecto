import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

type ClientMsg =
  | { type: 'audio_chunk'; audio: string; traceId?: string }
  | { type: 'commit'; instructions?: string; traceId?: string }
  | { type: 'text'; text: string; traceId?: string }
  | { type: 'start'; traceId?: string }
  | { type: 'end'; traceId?: string };

type RelayEvent =
  | { type: 'ready' }
  | { type: 'transcript'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'text_completed'; text: string }
  | { type: 'audio_delta'; audio: string }
  | { type: 'response_completed'; responseId?: string }
  | { type: 'error'; error: string };

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

const PORT = Number(env('RAGNAR_BACKEND_REALTIME_PORT', env('PORT', '5053')));
const OPENAI_API_KEY = env('OPENAI_API_KEY');

// You can override the URL if OpenAI changes the endpoint or you want a proxy.
const OPENAI_REALTIME_URL = env(
  'OPENAI_REALTIME_URL',
  // Default chosen to match the historical OpenAI Realtime pattern.
  'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview'
)!;

const REALTIME_VOICE = env('REALTIME_VOICE', env('TALK_VOICE_ID', 'alloy'))!;
const REALTIME_INSTRUCTIONS = env(
  'REALTIME_INSTRUCTIONS',
  env('RAGNAR_PROMPT', 'You are Ragnar. Be calm, efficient, and helpful. No emojis.')
)!;

// OpenClaw Gateway (Ragnar-with-tools). We call its HTTP OpenResponses endpoint.
// Render will typically set OPENCLAW_GATEWAY_URL as wss://host:port; we derive http://host:port.
const OPENCLAW_GATEWAY_URL = env('OPENCLAW_GATEWAY_URL');
const OPENCLAW_GATEWAY_TOKEN = env('OPENCLAW_GATEWAY_TOKEN');
const OPENCLAW_AGENT_ID = env('OPENCLAW_AGENT_ID', 'main')!;

function gatewayHttpBase(): string | null {
  const raw = OPENCLAW_GATEWAY_URL;
  if (!raw) return null;
  // Accept wss/ws/https/http.
  if (raw.startsWith('wss://')) return 'https://' + raw.slice('wss://'.length);
  if (raw.startsWith('ws://')) return 'http://' + raw.slice('ws://'.length);
  return raw;
}

// Relay expects PCM16 base64 deltas. phone-bridge defaults to 16k input / 24k output.
const INPUT_SAMPLE_RATE = Number(env('RELAY_INPUT_SAMPLE_RATE', '16000'));
const OUTPUT_SAMPLE_RATE = Number(env('RELAY_OUTPUT_SAMPLE_RATE', '24000'));

if (!OPENAI_API_KEY) {
  // Don’t crash the process; expose a healthz that explains misconfig.
  console.warn(JSON.stringify({ level: 'warn', msg: 'OPENAI_API_KEY is missing; realtime backend will fail to connect.' }));
}

const app = express();
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    openaiRealtimeUrl: OPENAI_REALTIME_URL,
    hasOpenaiKey: Boolean(OPENAI_API_KEY),
    voice: REALTIME_VOICE,
    inputSampleRate: INPUT_SAMPLE_RATE,
    outputSampleRate: OUTPUT_SAMPLE_RATE,
    openclaw: {
      hasGatewayUrl: Boolean(OPENCLAW_GATEWAY_URL),
      hasGatewayToken: Boolean(OPENCLAW_GATEWAY_TOKEN),
      agentId: OPENCLAW_AGENT_ID,
      httpBase: gatewayHttpBase(),
    },
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/relay' });

function safeSend(ws: WebSocket, evt: RelayEvent) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(evt));
}

function nowMs() {
  return Date.now();
}

wss.on('connection', (clientWs) => {
  const traceId = `trace_${Math.random().toString(16).slice(2)}`;
  const startedAt = nowMs();

  const openaiHeaders: Record<string, string> = {
    Authorization: `Bearer ${OPENAI_API_KEY ?? ''}`,
    'OpenAI-Beta': 'realtime=v1'
  };

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, { headers: openaiHeaders });

  let accumulatedText = '';
  let responseId: string | undefined;
  let lastTranscript = '';
  let speakingAbort: AbortController | null = null;
  let bufferedAudioMs = 0;

  function log(obj: Record<string, unknown>) {
    console.log(JSON.stringify({ traceId, ...obj }));
  }

  openaiWs.on('open', () => {
    log({ stage: 'openai_ws_open' });

    // Configure the session.
    // NOTE: The exact schema may evolve; we keep this minimal and tolerant.
    const sessionUpdate = {
      type: 'session.update',
      session: {
        instructions: REALTIME_INSTRUCTIONS,
        voice: REALTIME_VOICE,
        // Realtime expects string format names (sample rate is implied/handled by the model).
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        // Ask for input transcription when supported.
        input_audio_transcription: { model: env('ASR_MODEL', 'whisper-1') },
      }
    };
    openaiWs.send(JSON.stringify(sessionUpdate));

    safeSend(clientWs, { type: 'ready' });
  });

  openaiWs.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Common event shapes (subject to change). We forward what we can.
    switch (msg.type) {
      // Text streaming
      case 'response.text.delta':
      case 'response.output_text.delta': {
        const delta = msg.delta ?? msg.text ?? '';
        if (typeof delta === 'string' && delta.length) {
          accumulatedText += delta;
          safeSend(clientWs, { type: 'text_delta', text: delta });
        }
        break;
      }
      case 'response.text.done':
      case 'response.output_text.done': {
        if (accumulatedText.length) {
          safeSend(clientWs, { type: 'text_completed', text: accumulatedText });
        }
        break;
      }

      // Audio streaming
      case 'response.audio.delta':
      case 'response.output_audio.delta': {
        const b64 = msg.delta ?? msg.audio ?? '';
        if (typeof b64 === 'string' && b64.length) {
          safeSend(clientWs, { type: 'audio_delta', audio: b64 });
        }
        break;
      }

      // Transcription events (best-effort mapping)
      case 'conversation.item.input_audio_transcription.delta': {
        const t = msg.delta;
        if (typeof t === 'string' && t.length) {
          lastTranscript += t;
          safeSend(clientWs, { type: 'transcript', text: t });
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const t = msg.transcript ?? msg.text;
        if (typeof t === 'string' && t.length) {
          // Some providers send the full transcript here; if so, replace.
          if (t.length >= lastTranscript.length) lastTranscript = t;
          safeSend(clientWs, { type: 'transcript', text: t });
        }
        break;
      }

      // Response lifecycle
      case 'response.created': {
        responseId = msg.response?.id ?? msg.response_id;
        break;
      }
      case 'response.completed': {
        safeSend(clientWs, { type: 'response_completed', responseId });
        break;
      }

      case 'error': {
        const err = msg.error?.message ?? msg.message ?? 'OpenAI realtime error';
        safeSend(clientWs, { type: 'error', error: String(err) });
        log({ stage: 'openai_error', err });
        break;
      }
      default:
        // Ignore unknown events.
        break;
    }
  });

  openaiWs.on('close', (code, reason) => {
    log({ stage: 'openai_ws_close', code, reason: reason?.toString?.() });
    if (clientWs.readyState === WebSocket.OPEN) {
      safeSend(clientWs, { type: 'error', error: 'Realtime backend disconnected' });
      clientWs.close();
    }
  });

  openaiWs.on('error', (err) => {
    log({ stage: 'openai_ws_error', err: String(err) });
    safeSend(clientWs, { type: 'error', error: 'Realtime backend connection error' });
  });

  clientWs.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (openaiWs.readyState !== WebSocket.OPEN) {
      safeSend(clientWs, { type: 'error', error: 'Realtime session not ready yet' });
      return;
    }

    switch (msg.type) {
      case 'start':
        // no-op for now
        return;

      case 'audio_chunk': {
        // Append raw audio to OpenAI input buffer.
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.audio }));

        // Track how much audio we have so commit doesn't fail on short buffers.
        // base64 → bytes (approx exact for valid b64)
        const b64 = msg.audio || '';
        const bytes = Math.floor((b64.length * 3) / 4);
        const ms = (bytes / (2 * INPUT_SAMPLE_RATE)) * 1000;
        if (Number.isFinite(ms) && ms > 0) bufferedAudioMs += ms;

        return;
      }

      case 'commit': {
        // Commit buffered audio. We use OpenAI Realtime for transcription, but
        // the actual response generation comes from OpenClaw (tools + memory).
        accumulatedText = '';
        responseId = undefined;
        lastTranscript = '';

        if (bufferedAudioMs < 100) {
          safeSend(clientWs, { type: 'error', error: `Audio buffer too small (${bufferedAudioMs.toFixed(0)}ms). Speak a bit longer.` });
          bufferedAudioMs = 0;
          return;
        }

        // Cancel any in-flight speech (barge-in).
        if (speakingAbort) {
          speakingAbort.abort();
          speakingAbort = null;
        }

        // Optional per-turn instruction override affects transcription context.
        if (msg.instructions && msg.instructions.trim().length) {
          openaiWs.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                instructions: msg.instructions
              }
            })
          );
        }

        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        bufferedAudioMs = 0;

        // Wait a short moment for transcription to arrive; then run the agent.
        // We don't have a reliable server-side hook for "transcription done" across all models,
        // so this is best-effort.
        setTimeout(async () => {
          const text = (lastTranscript || '').trim();
          if (!text) {
            safeSend(clientWs, { type: 'error', error: 'No transcript captured' });
            return;
          }

          try {
            const agentText = await runOpenClawAgentStreaming(text, (delta) => {
              safeSend(clientWs, { type: 'text_delta', text: delta });
            });
            safeSend(clientWs, { type: 'text_completed', text: agentText });

            // Speak the agent response via OpenAI TTS HTTP (reliable) and stream PCM16 chunks.
            speakingAbort = new AbortController();
            await speakViaHttpTts(agentText, OUTPUT_SAMPLE_RATE, speakingAbort.signal, (b64) => {
              safeSend(clientWs, { type: 'audio_delta', audio: b64 });
            });
            safeSend(clientWs, { type: 'response_completed', responseId: `openclaw_${Date.now()}` });
          } catch (e) {
            safeSend(clientWs, { type: 'error', error: e instanceof Error ? e.message : String(e) });
          }
        }, 350);

        return;
      }

      case 'text': {
        // Direct text input (useful for debugging without audio).
        accumulatedText = '';
        responseId = undefined;

        // Cancel any in-flight speech.
        if (speakingAbort) {
          speakingAbort.abort();
          speakingAbort = null;
        }

        setTimeout(async () => {
          const text = (msg.text || '').trim();
          if (!text) return;
          try {
            const agentText = await runOpenClawAgentStreaming(text, (delta) => {
              safeSend(clientWs, { type: 'text_delta', text: delta });
            });
            safeSend(clientWs, { type: 'text_completed', text: agentText });
            speakingAbort = new AbortController();
            await speakViaHttpTts(agentText, OUTPUT_SAMPLE_RATE, speakingAbort.signal, (b64) => {
              safeSend(clientWs, { type: 'audio_delta', audio: b64 });
            });
            safeSend(clientWs, { type: 'response_completed', responseId: `openclaw_${Date.now()}` });
          } catch (e) {
            safeSend(clientWs, { type: 'error', error: e instanceof Error ? e.message : String(e) });
          }
        }, 0);
        return;
      }

      case 'end': {
        try {
          openaiWs.close();
        } catch {}
        try {
          clientWs.close();
        } catch {}
        return;
      }
    }
  });

  clientWs.on('close', () => {
    log({ stage: 'client_close', ms: nowMs() - startedAt });
    try {
      openaiWs.close();
    } catch {}
  });

  clientWs.on('error', (err) => {
    log({ stage: 'client_error', err: String(err) });
    try {
      openaiWs.close();
    } catch {}
  });
});

async function runOpenClawAgentStreaming(inputText: string, onDelta: (delta: string) => void): Promise<string> {
  const base = gatewayHttpBase();
  if (!base) throw new Error('OPENCLAW_GATEWAY_URL is not set');
  if (!OPENCLAW_GATEWAY_TOKEN) throw new Error('OPENCLAW_GATEWAY_TOKEN is not set');

  // We rely on the Gateway OpenResponses HTTP endpoint.
  // It must be enabled: gateway.http.endpoints.responses.enabled=true
  const url = new URL('/v1/responses', base);

  const body = {
    model: `openclaw:${OPENCLAW_AGENT_ID}`,
    stream: true,
    // Use `user` to get a stable session per caller if you have a caller id.
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: inputText }],
      },
    ],
  };

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenClaw /v1/responses failed (${res.status}): ${text.slice(0, 400)}`);
  }

  // Parse SSE.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Split on double newline (SSE event separator).
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const lines = chunk.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice('data:'.length).trim();
        if (!data) continue;
        if (data === '[DONE]') return full;
        let evt: any;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }

        // OpenResponses-ish stream events: look for output_text deltas.
        // We stay permissive to schema drift.
        const delta =
          evt?.type === 'response.output_text.delta'
            ? evt.delta
            : evt?.type === 'response.text.delta'
              ? evt.delta
              : evt?.delta;

        if (typeof delta === 'string' && delta.length) {
          full += delta;
          onDelta(delta);
        }

        // Some implementations send a final item with full text.
        if (evt?.type === 'response.output_text.done' || evt?.type === 'response.text.done') {
          // no-op
        }
      }
    }
  }

  return full;
}

async function speakViaHttpTts(
  text: string,
  sampleRate: number,
  signal: AbortSignal,
  onAudioDeltaBase64: (b64Pcm16Chunk: string) => void
): Promise<void> {
  if (signal.aborted) return;
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');

  // Use OpenAI TTS HTTP because it is stable and returns raw PCM.
  // Note: model/params may be adjusted if your account has different TTS model names.
  const ttsModel = env('TTS_MODEL', 'gpt-4o-mini-tts')!;

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ttsModel,
      voice: REALTIME_VOICE,
      input: text,
      format: 'pcm16',
      // Some APIs use `response_format` instead of `format`; keep compatible by duplicating.
      response_format: 'pcm16',
      sample_rate: sampleRate,
    }),
    signal,
  } as any);

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`TTS failed (${res.status}): ${err.slice(0, 300)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());

  // Stream as 20ms PCM16 mono frames.
  const bytesPerSample = 2;
  const bytesPerSecond = sampleRate * bytesPerSample;
  const frameBytes = Math.max(1, Math.floor(bytesPerSecond * 0.02));

  for (let off = 0; off < buf.length; off += frameBytes) {
    if (signal.aborted) return;
    const chunk = buf.subarray(off, Math.min(buf.length, off + frameBytes));
    onAudioDeltaBase64(chunk.toString('base64'));
    // Small pacing to avoid flooding downstream.
    await new Promise((r) => setTimeout(r, 10));
  }
}

server.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'ragnar-backend-realtime listening', port: PORT }));
});
