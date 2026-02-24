type Level = "debug" | "info" | "warn" | "error";

const levelOrder: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LOG_LEVEL = (process.env.LOG_LEVEL as Level | undefined) ?? "info";
const minLevel = levelOrder[LOG_LEVEL] ?? levelOrder.info;

const nowIso = () => new Date().toISOString();

const shouldLog = (level: Level) => levelOrder[level] >= minLevel;

const redact = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  // conservative: redact anything that looks like a bearer token / api key-ish
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s"']+)/gi, "$1[REDACTED]")
    .replace(/(token\s*[:=]\s*)([^\s"']+)/gi, "$1[REDACTED]");
};

const baseLog = (level: Level, msg: string, meta?: Record<string, unknown>) => {
  if (!shouldLog(level)) return;
  const payload = {
    t: nowIso(),
    level,
    msg,
    ...(meta ? { meta: JSON.parse(JSON.stringify(meta, (_k, v) => redact(v))) } : {}),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
};

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => baseLog("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => baseLog("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => baseLog("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => baseLog("error", msg, meta),
};
