import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

type ClientMsg =
  | { type: 'audio_chunk'; audio: string; traceId?: string }
  | { type: 'commit'; instructions?: string; traceId?: string }
  | { type: 'text'; text: string; traceId?: string }
  | { type: 'start'; traceId?: string; agent?: string; metadata?: Record<string, string> }
  | { type: 'interrupt'; traceId?: string }
  | { type: 'end'; traceId?: string };

type RelayEvent =
  | { type: 'ready' }
  | { type: 'transcript'; text: string; turnId?: string }
  | { type: 'text_delta'; text: string; turnId?: string }
  | { type: 'text_completed'; text: string; turnId?: string }
  | { type: 'audio_delta'; audio: string; turnId?: string }
  | { type: 'response_completed'; responseId?: string; turnId?: string }
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
const TTS_VOICE = env('TTS_VOICE', REALTIME_VOICE)!;
const REALTIME_INSTRUCTIONS = env(
  'REALTIME_INSTRUCTIONS',
  env(
    'RAGNAR_PROMPT',
    'You are Ragnar. Respond in English unless the user explicitly asks for another language. Be calm, efficient, and helpful. No emojis.'
  )
)!;
const TRANSCRIPTION_LANGUAGE = env('TRANSCRIPTION_LANGUAGE', 'en')!;
const TURN_TIMEOUT_MS = Number(env('TURN_TIMEOUT_MS', '12000'));
const FALLBACK_REPLY =
  env('FALLBACK_REPLY', "I’m still here. I had trouble processing that. Please repeat your request in one short sentence.")!;

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

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object' && err !== null && 'name' in err) {
    return String((err as { name?: unknown }).name) === 'AbortError';
  }
  if (err instanceof Error) {
    return err.name === 'AbortError' || /aborted|abort/i.test(err.message);
  }
  return false;
}

function takeSpeakableChunk(text: string, force = false): { chunk: string | null; rest: string } {
  const trimmed = text.trimStart();
  if (!trimmed) return { chunk: null, rest: '' };
  const maxChunk = 220;
  const punctuation = /[.!?]\s|[,;:]\s|\n/;
  const punctMatch = punctuation.exec(trimmed);
  if (punctMatch && punctMatch.index >= 36) {
    const end = punctMatch.index + punctMatch[0].length;
    return { chunk: trimmed.slice(0, end).trim(), rest: trimmed.slice(end) };
  }
  if (trimmed.length >= maxChunk) {
    const splitAt = trimmed.lastIndexOf(' ', maxChunk);
    if (splitAt > 24) {
      return { chunk: trimmed.slice(0, splitAt).trim(), rest: trimmed.slice(splitAt + 1) };
    }
  }
  if (force && trimmed.length) {
    return { chunk: trimmed, rest: '' };
  }
  return { chunk: null, rest: trimmed };
}

function normalizeForSpeech(rawText: string): string {
  const collapsed = rawText.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const sentences = collapsed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const deduped: string[] = [];
  for (const sentence of sentences) {
    const norm = sentence.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
    if (!norm) continue;
    const duplicate = deduped.some((existing) => {
      const e = existing.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
      return e === norm || e.includes(norm) || norm.includes(e);
    });
    if (!duplicate) deduped.push(sentence);
  }

  const merged = deduped.join(' ').trim();
  if (merged.length <= 900) return merged;
  return merged.slice(0, 900).trim();
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
  let bufferedAudioMs = 0;
  const pendingAudio: string[] = [];
  let pendingCommit: { instructions?: string } | null = null;
  const pendingText: string[] = [];
  const pcmChunks: Buffer[] = [];
  let startInstructions: string | null = null;
  let turnInFlight = false;
  let generationAbort: AbortController | null = null;
  let speakingAbort: AbortController | null = null;
  let activeTurnId = 0;

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
        input_audio_transcription: { model: env('ASR_MODEL', 'whisper-1'), language: TRANSCRIPTION_LANGUAGE },
      }
    };
    openaiWs.send(JSON.stringify(sessionUpdate));

    // Flush any audio/text that arrived before OpenAI WS was ready.
    for (const b64 of pendingAudio.splice(0, pendingAudio.length)) {
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
      const bytes = Math.floor((b64.length * 3) / 4);
      const ms = (bytes / (2 * INPUT_SAMPLE_RATE)) * 1000;
      if (Number.isFinite(ms) && ms > 0) bufferedAudioMs += ms;
    }

    for (const text of pendingText.splice(0, pendingText.length)) {
      // Treat early text as user input.
      openaiWs.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        })
      );
    }

    if (pendingCommit) {
      const instr = pendingCommit.instructions;
      pendingCommit = null;
      // Trigger commit path by faking a commit message into the handler.
      clientWs.emit('message', Buffer.from(JSON.stringify({ type: 'commit', instructions: instr })));
    }

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

  const cancelActiveTurn = (reason: string) => {
    if (generationAbort) {
      generationAbort.abort();
      generationAbort = null;
    }
    if (speakingAbort) {
      speakingAbort.abort();
      speakingAbort = null;
    }
    turnInFlight = false;
    log({ stage: 'turn_canceled', reason });
  };

  const runTurn = (inputText: string, guidance?: string) => {
    if (turnInFlight) {
      log({ stage: 'turn_ignored_in_flight' });
      return;
    }
    const text = inputText.trim();
    if (!text) return;

    turnInFlight = true;
    const turnIndex = ++activeTurnId;
    const turnId = `turn_${turnIndex}_${Date.now()}`;
    const generationCtl = new AbortController();
    const speakingCtl = new AbortController();
    generationAbort = generationCtl;
    speakingAbort = speakingCtl;
    const timeoutHandle = setTimeout(() => {
      if (activeTurnId === turnIndex && !generationCtl.signal.aborted) {
        generationCtl.abort();
        speakingCtl.abort();
        log({ stage: 'turn_timeout', turnId, timeoutMs: TURN_TIMEOUT_MS });
      }
    }, Math.max(3000, TURN_TIMEOUT_MS));

    let ttsRemainder = '';
    const ttsQueue: string[] = [];
    let ttsWorker: Promise<void> | null = null;
    let lastDeltaNorm = '';

    const flushTtsQueue = () => {
      if (!ttsWorker) {
        ttsWorker = (async () => {
          while (ttsQueue.length && !speakingCtl.signal.aborted) {
            const next = ttsQueue.shift();
            if (!next) continue;
            await speakViaHttpTts(next, OUTPUT_SAMPLE_RATE, speakingCtl.signal, (b64) => {
              safeSend(clientWs, { type: 'audio_delta', audio: b64, turnId });
            });
          }
          ttsWorker = null;
        })();
      }
      return ttsWorker;
    };

    const enqueueSpeakable = (incoming: string, force = false) => {
      if (incoming) {
        ttsRemainder += incoming;
      }
      while (true) {
        const { chunk, rest } = takeSpeakableChunk(ttsRemainder, force);
        ttsRemainder = rest;
        if (!chunk) break;
        ttsQueue.push(chunk);
      }
      void flushTtsQueue();
    };

    (async () => {
      try {
        const finalText = await runOpenClawAgentStreaming(
          text,
          (delta) => {
            const norm = delta.replace(/\s+/g, ' ').trim().toLowerCase();
            if (norm && norm === lastDeltaNorm) {
              return;
            }
            if (norm) lastDeltaNorm = norm;
            safeSend(clientWs, { type: 'text_delta', text: delta, turnId });
            enqueueSpeakable(delta, false);
          },
          {
            extraGuidance: guidance,
            signal: generationCtl.signal,
          }
        );

        enqueueSpeakable('', true);
        if (ttsRemainder.trim()) {
          ttsQueue.push(ttsRemainder.trim());
          ttsRemainder = '';
        }
        const cleanedText = normalizeForSpeech(finalText);
        if (!cleanedText) {
          ttsQueue.push(FALLBACK_REPLY);
        }
        await flushTtsQueue();
        if (ttsWorker) {
          await ttsWorker;
        }
        safeSend(clientWs, { type: 'text_completed', text: cleanedText || FALLBACK_REPLY, turnId });
        safeSend(clientWs, { type: 'response_completed', responseId: `openclaw_${Date.now()}`, turnId });
      } catch (e) {
        if (!isAbortError(e)) {
          safeSend(clientWs, { type: 'error', error: e instanceof Error ? e.message : String(e) });
          try {
            await speakViaHttpTts(FALLBACK_REPLY, OUTPUT_SAMPLE_RATE, speakingCtl.signal, (b64) => {
              safeSend(clientWs, { type: 'audio_delta', audio: b64, turnId });
            });
            safeSend(clientWs, { type: 'text_completed', text: FALLBACK_REPLY, turnId });
            safeSend(clientWs, { type: 'response_completed', responseId: `fallback_${Date.now()}`, turnId });
          } catch {
            // ignore secondary fallback errors
          }
        } else {
          log({ stage: 'turn_aborted' });
        }
      } finally {
        clearTimeout(timeoutHandle);
        if (activeTurnId === turnIndex) {
          turnInFlight = false;
          generationAbort = null;
          speakingAbort = null;
        }
      }
    })();
  };

  clientWs.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (openaiWs.readyState !== WebSocket.OPEN) {
      // Buffer until OpenAI WS is ready. This avoids dropping early audio from Twilio.
      if (msg.type === 'audio_chunk') {
        if (msg.audio) pendingAudio.push(msg.audio);
      } else if (msg.type === 'commit') {
        pendingCommit = { instructions: msg.instructions };
      } else if (msg.type === 'text') {
        if (msg.text) pendingText.push(msg.text);
      }
      return;
    }

    switch (msg.type) {
      case 'start':
        startInstructions = msg.metadata?.instructions?.trim() || null;
        return;

      case 'audio_chunk': {
        const b64 = msg.audio || '';
        if (b64) {
          const buf = Buffer.from(b64, 'base64');
          pcmChunks.push(buf);

          const ms = (buf.length / (2 * INPUT_SAMPLE_RATE)) * 1000;
          if (Number.isFinite(ms) && ms > 0) bufferedAudioMs += ms;

          // Debug counters (log occasionally).
          (globalThis as any).__audioChunks = ((globalThis as any).__audioChunks ?? 0) + 1;
          if (((globalThis as any).__audioChunks as number) % 100 === 0) {
            log({ stage: 'audio_chunk', chunks: (globalThis as any).__audioChunks, bufferedAudioMs: Number(bufferedAudioMs.toFixed(0)), lastChunkB64Len: b64.length });
          }
        }
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
          pcmChunks.splice(0, pcmChunks.length);
          return;
        }

        if (turnInFlight) {
          log({ stage: 'commit_ignored_turn_in_flight' });
          return;
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

        log({ stage: 'commit_sent', bufferedAudioMs: Number(bufferedAudioMs.toFixed(0)) });

        // Transcribe buffered PCM via Whisper HTTP (reliable).
        const pcm = Buffer.concat(pcmChunks.splice(0, pcmChunks.length));
        bufferedAudioMs = 0;

        (async () => {
          try {
            const transcript = (await transcribePcm16WithWhisper(pcm, INPUT_SAMPLE_RATE)).trim();
            if (!transcript) {
              safeSend(clientWs, { type: 'error', error: 'No transcript captured' });
              const fallbackCtl = new AbortController();
              await speakViaHttpTts(FALLBACK_REPLY, OUTPUT_SAMPLE_RATE, fallbackCtl.signal, (b64) => {
                safeSend(clientWs, { type: 'audio_delta', audio: b64 });
              });
              safeSend(clientWs, { type: 'text_completed', text: FALLBACK_REPLY });
              safeSend(clientWs, { type: 'response_completed', responseId: `fallback_${Date.now()}` });
              return;
            }
            safeSend(clientWs, { type: 'transcript', text: transcript });
            runTurn(transcript, msg.instructions?.trim() || startInstructions || undefined);
          } catch (e) {
            safeSend(clientWs, { type: 'error', error: e instanceof Error ? e.message : String(e) });
          }
        })();

        return;
      }

      case 'text': {
        // Direct text input (useful for debugging without audio).
        accumulatedText = '';
        responseId = undefined;

        setTimeout(async () => {
          const text = (msg.text || '').trim();
          if (!text) return;
          try {
            runTurn(text, startInstructions || undefined);
          } catch (e) {
            safeSend(clientWs, { type: 'error', error: e instanceof Error ? e.message : String(e) });
          }
        }, 0);
        return;
      }

      case 'interrupt': {
        cancelActiveTurn('client_interrupt');
        return;
      }

      case 'end': {
        cancelActiveTurn('client_end');
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
    cancelActiveTurn('client_close');
    try {
      openaiWs.close();
    } catch {}
  });

  clientWs.on('error', (err) => {
    log({ stage: 'client_error', err: String(err) });
    cancelActiveTurn('client_error');
    try {
      openaiWs.close();
    } catch {}
  });
});

async function runOpenClawAgentStreaming(
  inputText: string,
  onDelta: (delta: string) => void,
  options?: { extraGuidance?: string; signal?: AbortSignal }
): Promise<string> {
  const base = gatewayHttpBase();
  if (!base) throw new Error('OPENCLAW_GATEWAY_URL is not set');
  if (!OPENCLAW_GATEWAY_TOKEN) throw new Error('OPENCLAW_GATEWAY_TOKEN is not set');

  // We rely on the Gateway OpenResponses HTTP endpoint.
  // It must be enabled: gateway.http.endpoints.responses.enabled=true
  const url = new URL('/v1/responses', base);

  const body = {
    model: `openclaw:${OPENCLAW_AGENT_ID}`,
    stream: true,
    // Some gateway builds ignore top-level `instructions`; include a system message too.
    instructions:
      'You are Ragnar (OpenClaw). Always respond in English unless the user explicitly asks for another language. Be calm, efficient, and helpful. No emojis.',
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'Always respond in English unless the user explicitly asks for another language. No emojis.',
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: options?.extraGuidance
              ? `${inputText}\n\nSystem guidance: ${options.extraGuidance}`
              : inputText,
          },
        ],
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
    signal: options?.signal,
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
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
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
              : undefined;

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

function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const chunkSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

async function transcribePcm16WithWhisper(pcm: Buffer, sampleRate: number): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
  if (!pcm.length) return '';

  // Guard: Whisper needs some audio.
  const ms = (pcm.length / (2 * sampleRate)) * 1000;
  if (ms < 120) return '';

  const wav = wavFromPcm16(pcm, sampleRate);

  const model = env('WHISPER_MODEL', 'whisper-1')!;

  const form = new FormData();
  form.set('model', model);
  form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  } as any);

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Whisper failed (${res.status}): ${err.slice(0, 300)}`);
  }

  const json: any = await res.json();
  return String(json.text ?? '').trim();
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
      voice: TTS_VOICE,
      input: text,
      // /v1/audio/speech expects "pcm" (not "pcm16").
      format: 'pcm',
      // Keep compatibility for providers expecting `response_format`.
      response_format: 'pcm',
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
