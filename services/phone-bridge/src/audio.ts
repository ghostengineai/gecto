import { Buffer } from "node:buffer";

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export type SampleRate = 8000 | 16000 | 24000 | number;

export function decodeMuLaw(base64Payload: string): Int16Array {
  const muLawBuffer = Buffer.from(base64Payload, "base64");
  const pcm = new Int16Array(muLawBuffer.length);

  for (let i = 0; i < muLawBuffer.length; i += 1) {
    pcm[i] = muLawToLinear(muLawBuffer[i]);
  }

  return pcm;
}

export function encodeMuLaw(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = linearToMuLaw(samples[i]);
  }
  return out;
}

export function resampleLinear(
  samples: Int16Array,
  inputRate: SampleRate,
  outputRate: SampleRate,
): Int16Array {
  if (inputRate === outputRate) {
    return samples;
  }

  const duration = samples.length / inputRate;
  const outputLength = Math.max(1, Math.round(duration * outputRate));
  const result = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const t = i / outputRate;
    const sourceIndex = t * inputRate;
    const idx = Math.floor(sourceIndex);
    const frac = sourceIndex - idx;
    const s0 = samples[idx] ?? samples[samples.length - 1] ?? 0;
    const s1 = samples[idx + 1] ?? s0;
    result[i] = s0 + (s1 - s0) * frac;
  }

  return result;
}

export function int16ToBase64(samples: Int16Array): string {
  const buffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return buffer.toString("base64");
}

export function base64ToInt16(payload: string): Int16Array {
  const buffer = Buffer.from(payload, "base64");
  return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
}

export function computeRms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length) / 32768;
}

function muLawToLinear(muLawValue: number): number {
  let value = ~muLawValue & 0xff;
  const sign = value & 0x80;
  const exponent = (value & 0x70) >> 4;
  const mantissa = value & 0x0f;
  value = ((mantissa << 4) + 0x08) << (exponent + 3);
  value -= MULAW_BIAS;
  return sign ? -value : value;
}

function linearToMuLaw(sample: number): number {
  let value = sample;
  let sign = 0;
  if (value < 0) {
    sign = 0x80;
    value = -value;
  }

  if (value > MULAW_CLIP) {
    value = MULAW_CLIP;
  }

  value += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (value & expMask) === 0 && exponent > 0; exponent -= 1) {
    expMask >>= 1;
  }

  const mantissa = (value >> (exponent + 3)) & 0x0f;
  const muLawByte = ~(sign | (exponent << 4) | mantissa);
  return muLawByte & 0xff;
}
