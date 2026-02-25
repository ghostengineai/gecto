export interface TtsResult {
  /** mono PCM16 (s16le). Sample rate is determined by the synthesize() call. */
  pcm16: Buffer;
}

export interface TtsModule {
  ready(): Promise<{ ok: boolean; details?: Record<string, unknown> }>;
  /** Optional outputSampleRate allows per-call tuning (e.g. 8000Hz for phone). */
  synthesize(text: string, outputSampleRate?: number): Promise<TtsResult>;
}
