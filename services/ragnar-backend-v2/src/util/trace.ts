import { randomUUID } from "node:crypto";

export type Trace = {
  traceId: string;
  startedAt: number;
  marks: Record<string, number>;
};

export const createTrace = (traceId?: string): Trace => {
  const id = traceId && traceId.trim() ? traceId.trim() : randomUUID();
  return { traceId: id, startedAt: Date.now(), marks: {} };
};

export const mark = (trace: Trace, stage: string) => {
  trace.marks[stage] = Date.now();
};

export const msSinceStart = (trace: Trace) => Date.now() - trace.startedAt;
