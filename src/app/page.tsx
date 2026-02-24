'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_REALTIME_MODEL =
  process.env.NEXT_PUBLIC_OPENAI_REALTIME_MODEL ?? 'gpt-4o-realtime-preview-2024-12-17';
const DEFAULT_CONNECT_URL =
  process.env.NEXT_PUBLIC_OPENAI_REALTIME_CONNECT_URL ??
  'https://api.openai.com/v1/realtime/sessions';

type SessionResponse = {
  client_secret?: { value: string } | null;
  model?: string | null;
  [key: string]: unknown;
};

type CallStatus = 'idle' | 'connecting' | 'connected' | 'error';

export default function Home() {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const connectUrlBase = useMemo(() => DEFAULT_CONNECT_URL, []);

  const cleanup = (resetStatus = true) => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (resetStatus) {
      setStatus('idle');
    }
  };

  const connect = async () => {
    if (status === 'connecting' || status === 'connected') return;

    setStatus('connecting');
    setError(null);

    try {
      const tokenResp = await fetch('/api/realtime-token', { method: 'POST' });
      if (!tokenResp.ok) {
        const errorBody = await tokenResp.text();
        throw new Error(`Token endpoint failed (${tokenResp.status}): ${errorBody}`);
      }
      const session: SessionResponse = await tokenResp.json();
      console.log('Realtime session response', session);
      const ephemeralKey =
        typeof session?.client_secret === 'object' && session.client_secret?.value
          ? session.client_secret.value
          : null;

      if (!ephemeralKey) {
        throw new Error('No client secret returned by session endpoint');
      }

      const targetModel = typeof session?.model === 'string' && session.model
        ? session.model
        : DEFAULT_REALTIME_MODEL;
      const sessionId = typeof session?.id === 'string' && session.id ? session.id : null;
      if (!sessionId) {
        throw new Error('No session id returned by token endpoint');
      }
      const connectUrl = new URL(`${connectUrlBase}/${sessionId}/connect`);
      connectUrl.searchParams.set('model', targetModel);

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
        ],
      });
      pcRef.current = pc;

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          setStatus('connected');
        } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          cleanup();
        }
      };

      pc.onicecandidateerror = (event) => {
        console.error('ICE candidate error', event.errorCode, event.errorText);
      };

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (remoteAudioRef.current && stream) {
          remoteAudioRef.current.srcObject = stream;
          remoteAudioRef.current
            .play()
            .catch(() => {
              /* autoplay restrictions */
            });
        }
      };

      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      pc.addTransceiver('audio', { direction: 'recvonly' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const apiResponse = await fetch(connectUrl.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          'Content-Type': 'application/sdp',
          'OpenAI-Beta': 'realtime=v1',
        },
        body: offer.sdp ?? '',
      });

      if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        throw new Error(`Realtime connect error (${apiResponse.status}): ${errorBody}`);
      }

      const answer = await apiResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      setStatus('connected');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      setError(message);
      setStatus('error');
      cleanup(false);
    }
  };

  const disconnect = () => {
    if (status === 'idle') return;
    cleanup();
  };

  useEffect(() => cleanup, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <audio ref={remoteAudioRef} autoPlay playsInline hidden />
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6">
        <div className="w-full rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl">
          <p className="text-sm uppercase tracking-[0.3em] text-blue-300">Voice Bridge</p>
          <h1 className="mt-2 text-4xl font-semibold">Live conversation with Ragnar</h1>
          <p className="mt-3 text-sm text-white/70">
            Click connect once, talk freely, and hang up when you’re done. The session stays live
            until you hit Hang Up.
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
        </div>
      </div>
    </div>
  );
}
