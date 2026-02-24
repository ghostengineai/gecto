const BASE64_CHUNK_SIZE = 0x8000;

export function floatToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    output[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return output;
}

export function resampleLinear(samples: Int16Array, inputRate: number, outputRate: number): Int16Array {
  if (!samples.length) return samples;
  if (inputRate === outputRate) {
    return samples;
  }

  const duration = samples.length / inputRate;
  const outputLength = Math.max(1, Math.round(duration * outputRate));
  const result = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const time = i / outputRate;
    const sourceIndex = time * inputRate;
    const index = Math.floor(sourceIndex);
    const frac = sourceIndex - index;
    const s0 = samples[index] ?? samples[samples.length - 1] ?? 0;
    const s1 = samples[index + 1] ?? s0;
    result[i] = s0 + (s1 - s0) * frac;
  }

  return result;
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

export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  return bytesToBase64(bytes);
}

export function base64ToFloat32(payload: string): Float32Array {
  const bytes = base64ToBytes(payload);
  const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
  const floats = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) {
    floats[i] = view[i] / 32768;
  }
  return floats;
}

export function cloneFloat32(samples: Float32Array): Float32Array {
  return new Float32Array(Array.from(samples));
}

export function concatInt16(first: Int16Array, second: Int16Array): Int16Array {
  if (!first.length) return second;
  if (!second.length) return first;
  const output = new Int16Array(first.length + second.length);
  output.set(first, 0);
  output.set(second, first.length);
  return output;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
