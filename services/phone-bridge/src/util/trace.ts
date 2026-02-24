import { v4 as uuid } from "uuid";

export type Trace = {
  traceId: string;
  startedAt: number;
  marks: Record<string, number>;
};

export const createTrace = (seed?: string): Trace => {
  const traceId = seed && seed.trim() ? seed.trim() : uuid();
  return { traceId, startedAt: Date.now(), marks: {} };
};

export const mark = (trace: Trace, stage: string) => {
  trace.marks[stage] = Date.now();
};

export const msSinceStart = (trace: Trace) => Date.now() - trace.startedAt;
