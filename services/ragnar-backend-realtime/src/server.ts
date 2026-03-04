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
    outputSampleRate: OUTPUT_SAMPLE_RATE
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
        input_audio_format: { type: 'pcm16', sample_rate: INPUT_SAMPLE_RATE },
        output_audio_format: { type: 'pcm16', sample_rate: OUTPUT_SAMPLE_RATE }
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
        if (typeof t === 'string' && t.length) safeSend(clientWs, { type: 'transcript', text: t });
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const t = msg.transcript ?? msg.text;
        if (typeof t === 'string' && t.length) safeSend(clientWs, { type: 'transcript', text: t });
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
        return;
      }

      case 'commit': {
        // Commit buffered audio and ask for a response.
        accumulatedText = '';
        responseId = undefined;

        // Optional per-turn instruction override.
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
        openaiWs.send(JSON.stringify({ type: 'response.create' }));
        return;
      }

      case 'text': {
        accumulatedText = '';
        responseId = undefined;

        // Create a user message and ask for a response.
        // Keep it tolerant to schema changes.
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: msg.text }]
            }
          })
        );
        openaiWs.send(JSON.stringify({ type: 'response.create' }));
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

server.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'ragnar-backend-realtime listening', port: PORT }));
});
