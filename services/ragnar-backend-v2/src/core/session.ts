import { randomUUID } from "node:crypto";

export interface SessionState {
  id: string;
  createdAt: number;
  bufferedPcm: Buffer[];
  bufferedBytes: number;
  bufferedChunks: number;
}

export const createSession = (): SessionState => ({
  id: `sess_${randomUUID().slice(0, 8)}`,
  createdAt: Date.now(),
  bufferedPcm: [],
  bufferedBytes: 0,
  bufferedChunks: 0,
});

export const appendAudioChunk = (s: SessionState, chunk: Buffer) => {
  s.bufferedPcm.push(chunk);
  s.bufferedBytes += chunk.length;
  s.bufferedChunks += 1;
};

export const consumeBufferedAudio = (s: SessionState): Buffer => {
  const joined = Buffer.concat(s.bufferedPcm);
  s.bufferedPcm = [];
  s.bufferedBytes = 0;
  s.bufferedChunks = 0;
  return joined;
};
