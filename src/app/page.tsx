'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  base64ToFloat32,
  cloneFloat32,
  computeRms,
  concatInt16,
  floatToInt16,
  int16ToBase64,
  resampleLinear,
} from '@/lib/audio';

type CallStatus = 'idle' | 'connecting' | 'connected' | 'error';

type RelayClientMessage =
  | { type: 'audio_chunk'; audio: string }
  | { type: 'commit'; instructions?: string }
  | { type: 'text'; text: string }
  | { type: 'end' };

type RelayServerEvent =
  | { type: 'ready' }
  | { type: 'error'; error?: string }
  | { type: 'audio_delta'; audio: string }
  | { type: 'text_delta'; text: string }
  | { type: 'text_completed'; text: string }
  | { type: 'response_completed'; responseId?: string }
  | { type: 'transcript'; text: string };

const DEFAULT_RELAY_URL = process.env.NEXT_PUBLIC_VOICE_RELAY_URL ?? 'ws://localhost:5050/relay';
const RELAY_TOKEN = process.env.NEXT_PUBLIC_VOICE_RELAY_TOKEN;
const RELAY_INPUT_SAMPLE_RATE = Number(process.env.NEXT_PUBLIC_RELAY_INPUT_SAMPLE_RATE ?? 16000);
const RELAY_OUTPUT_SAMPLE_RATE = Number(process.env.NEXT_PUBLIC_RELAY_OUTPUT_SAMPLE_RATE ?? 24000);
const RELAY_CHUNK_MS = Number(process.env.NEXT_PUBLIC_RELAY_CHUNK_MS ?? 20);
const COMMIT_SILENCE_MS = Number(process.env.NEXT_PUBLIC_COMMIT_SILENCE_MS ?? 900);
const VAD_THRESHOLD = Number(process.env.NEXT_PUBLIC_VAD_THRESHOLD ?? 0.012);

export default function Home() {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [userTranscript, setUserTranscript] = useState<string>('');
  const [assistantText, setAssistantText] = useState<string>('');

  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const relayReadyRef = useRef(false);
  const pendingMessagesRef = useRef<string[]>([]);
  const pendingSamplesRef = useRef<Int16Array>(new Int16Array(0));
  const playbackOffsetRef = useRef(0);
  const assistantScratchRef = useRef('');
  const silenceMsRef = useRef(0);
  const hasPendingSpeechRef = useRef(false);
  const streamingActiveRef = useRef(false);

  const chunkSize = useMemo(
    () => Math.max(1, Math.round((RELAY_INPUT_SAMPLE_RATE / 1000) * RELAY_CHUNK_MS)),
    [],
  );

  const buildRelayUrl = useCallback(() => {
    const base = (DEFAULT_RELAY_URL ?? '').trim();
    if (!base) {
      throw new Error('NEXT_PUBLIC_VOICE_RELAY_URL is not configured');
    }
    let resolved: URL;
    if (base.startsWith('ws://') || base.startsWith('wss://')) {
      resolved = new URL(base);
    } else {
      const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
      const wsOrigin = origin.replace(/^http/, 'ws');
      resolved = new URL(base, wsOrigin);
    }
    if (RELAY_TOKEN) {
      resolved.searchParams.set('token', RELAY_TOKEN);
    }
    return resolved.toString();
  }, []);

  const flushPending = () => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (pendingMessagesRef.current.length) {
      const next = pendingMessagesRef.current.shift();
      if (!next) break;
      socket.send(next);
    }
  };

  const dispatchToRelay = (message: RelayClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      return;
    }
    const payload = JSON.stringify(message);
    if (relayReadyRef.current && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
      return;
    }
    if (pendingMessagesRef.current.length > 1000) {
      pendingMessagesRef.current.shift();
    }
    pendingMessagesRef.current.push(payload);
  };

  const ensureAudioContext = () => {
    const ctx = audioContextRef.current;
    return ctx ?? null;
  };

  const queuePlayback = (base64Audio: string) => {
    if (!base64Audio) return;
    const ctx = ensureAudioContext();
    if (!ctx) return;

    const floats = base64ToFloat32(base64Audio);
    if (!floats.length) return;

    const buffer = ctx.createBuffer(1, floats.length, RELAY_OUTPUT_SAMPLE_RATE);
    const normalized = cloneFloat32(floats);
    buffer.copyToChannel(normalized, 0, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime, playbackOffsetRef.current);
    source.start(startAt);
    playbackOffsetRef.current = startAt + buffer.duration;
  };

  const resetAssistantScratch = () => {
    assistantScratchRef.current = '';
    setAssistantText('');
  };

  const handleRelayEvent = (event: RelayServerEvent) => {
    switch (event.type) {
      case 'ready':
        relayReadyRef.current = true;
        flushPending();
        setStatus('connected');
        break;
      case 'audio_delta':
        queuePlayback(event.audio);
        break;
      case 'text_delta':
        assistantScratchRef.current += event.text ?? '';
        setAssistantText(assistantScratchRef.current);
        break;
      case 'text_completed':
        assistantScratchRef.current = event.text ?? assistantScratchRef.current;
        setAssistantText(assistantScratchRef.current);
        break;
      case 'response_completed':
        assistantScratchRef.current = '';
        break;
      case 'transcript':
        setUserTranscript((prev) => `${prev}${event.text ?? ''}`);
        break;
      case 'error':
        setError(event.error ?? 'Relay error');
        setStatus('error');
        cleanup(false);
        break;
      default:
        break;
    }
  };

  const maybeCommit = (chunk: Int16Array) => {
    const rms = computeRms(chunk);
    const chunkDurationMs = (chunk.length / RELAY_INPUT_SAMPLE_RATE) * 1000;
    if (rms >= VAD_THRESHOLD) {
      hasPendingSpeechRef.current = true;
      silenceMsRef.current = 0;
      return;
    }
    if (!hasPendingSpeechRef.current) {
      return;
    }
    silenceMsRef.current += chunkDurationMs;
    if (silenceMsRef.current >= COMMIT_SILENCE_MS) {
      hasPendingSpeechRef.current = false;
      silenceMsRef.current = 0;
      dispatchToRelay({ type: 'commit' });
    }
  };

  const handleSamples = (samples: Int16Array, inputSampleRate: number) => {
    if (!streamingActiveRef.current || !samples.length) {
      return;
    }
    const resampled = resampleLinear(samples, inputSampleRate, RELAY_INPUT_SAMPLE_RATE);
    if (!resampled.length) return;

    pendingSamplesRef.current = concatInt16(pendingSamplesRef.current, resampled);
    maybeCommit(resampled);

    while (pendingSamplesRef.current.length >= chunkSize) {
      const chunk = pendingSamplesRef.current.subarray(0, chunkSize);
      pendingSamplesRef.current = pendingSamplesRef.current.subarray(chunkSize);
      dispatchToRelay({ type: 'audio_chunk', audio: int16ToBase64(chunk) });
    }
  };

  const cleanup = (resetStatus = true) => {
    streamingActiveRef.current = false;
    relayReadyRef.current = false;
    pendingMessagesRef.current = [];
    pendingSamplesRef.current = new Int16Array(0);
    playbackOffsetRef.current = 0;
    silenceMsRef.current = 0;
    hasPendingSpeechRef.current = false;

    if (socketRef.current) {
      try {
        socketRef.current.close();
      } catch {}
    }
    socketRef.current = null;

    processorRef.current?.disconnect();
    processorRef.current = null;

    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    if (audioContextRef.current) {
      const ctx = audioContextRef.current;
      audioContextRef.current = null;
      ctx.close().catch(() => undefined);
    }

    if (resetStatus) {
      setStatus('idle');
    }
  };

  useEffect(() => () => cleanup(), []);

  const connect = async () => {
    if (status === 'connecting' || status === 'connected') return;

    setStatus('connecting');
    setError(null);
    setUserTranscript('');
    resetAssistantScratch();
    relayReadyRef.current = false;
    pendingMessagesRef.current = [];
    pendingSamplesRef.current = new Int16Array(0);
    playbackOffsetRef.current = 0;
    silenceMsRef.current = 0;
    hasPendingSpeechRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      localStreamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;

      const processor = audioContext.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        if (!streamingActiveRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        const int16 = floatToInt16(copy);
        handleSamples(int16, audioContext.sampleRate);
      };

      sourceNode.connect(processor);
      processor.connect(audioContext.destination);
      streamingActiveRef.current = true;

      const url = buildRelayUrl();
      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as RelayServerEvent;
          handleRelayEvent(payload);
        } catch (err) {
          console.error('Failed to parse relay event', err);
        }
      };

      ws.onerror = () => {
        setError('Relay connection failed');
        setStatus('error');
        cleanup(false);
      };

      ws.onclose = () => {
        cleanup(false);
        setStatus((prev) => (prev === 'error' ? prev : 'idle'));
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect';
      setError(message);
      setStatus('error');
      cleanup(false);
    }
  };

  const disconnect = () => {
    if (status === 'idle') return;
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'end' } satisfies RelayClientMessage));
      } catch {}
    }
    cleanup();
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6">
        <div className="w-full rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl">
          <p className="text-sm uppercase tracking-[0.3em] text-blue-300">Voice Bridge</p>
          <h1 className="mt-2 text-4xl font-semibold">Live conversation with Ragnar</h1>
          <p className="mt-3 text-sm text-white/70">
            Connect once, speak naturally, and Ragnar will respond as the relay streams audio in both
            directions. Silence detection automatically triggers replies when you pause.
          </p>

          <div className="mt-6 rounded-2xl border border-white/10 bg-black/40 p-5">
            <p className="text-sm text-white/60">Status</p>
            <p className="text-2xl font-semibold">
              {status === 'idle' && 'Idle'}
              {status === 'connecting' && 'Connecting…'}
              {status === 'connected' && 'Live'}
              {status === 'error' && 'Error'}
            </p>
            {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
          </div>

          <div className="mt-6 flex flex-col gap-4 sm:flex-row">
            <button
              onClick={connect}
              disabled={status === 'connecting' || status === 'connected'}
              className="flex-1 rounded-2xl bg-blue-600 px-6 py-4 text-lg font-semibold text-white transition disabled:opacity-40"
            >
              {status === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
            <button
              onClick={disconnect}
              disabled={status === 'idle'}
              className="flex-1 rounded-2xl border border-white/20 px-6 py-4 text-lg font-semibold text-white/90 transition disabled:opacity-40"
            >
              Hang Up
            </button>
          </div>

          <div className="mt-6 grid gap-4 rounded-2xl border border-white/10 bg-black/30 p-5 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">You said</p>
              <p className="mt-2 min-h-[4rem] whitespace-pre-wrap text-sm text-white/80">
                {userTranscript || 'Waiting for audio…'}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">Ragnar</p>
              <p className="mt-2 min-h-[4rem] whitespace-pre-wrap text-sm text-white">
                {assistantText || 'Listening…'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
