export interface AsrResult {
  text: string;
  confidence?: number;
  segments?: Array<{ startMs: number; endMs: number; text: string }>;
}

export interface AsrModule {
  ready(): Promise<{ ok: boolean; details?: Record<string, unknown> }>;
  transcribePcm16kMono(pcm16: Buffer): Promise<AsrResult>;
}
