import fs from "node:fs/promises";

export const PCM16_SAMPLE_RATE = 16_000;
export const PCM16_FRAME_SAMPLES_20MS = 320;
export const PCM16_FRAME_BYTES_20MS = PCM16_FRAME_SAMPLES_20MS * 2;

export const chunkPcm16 = (pcm: Buffer, frameBytes = PCM16_FRAME_BYTES_20MS): Buffer[] => {
  const chunks: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += frameBytes) {
    chunks.push(pcm.subarray(i, Math.min(i + frameBytes, pcm.length)));
  }
  return chunks;
};

// minimal WAV writer for PCM16 mono
export const writeWav16kMono = async (path: string, pcm16: Buffer): Promise<void> => {
  const numChannels = 1;
  const sampleRate = PCM16_SAMPLE_RATE;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const dataSize = pcm16.length;
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM
  buffer.writeUInt16LE(1, 20); // audio format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  await fs.writeFile(path, Buffer.concat([buffer, pcm16]));
};
