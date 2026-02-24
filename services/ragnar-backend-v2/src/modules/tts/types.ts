export interface TtsResult {
  pcm16: Buffer; // mono 16kHz PCM16
}

export interface TtsModule {
  ready(): Promise<{ ok: boolean; details?: Record<string, unknown> }>;
  synthesize(text: string): Promise<TtsResult>;
}
