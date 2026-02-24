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

const looksLikeBase64Audio = (s: string) => {
  // Very heuristic: long-ish, base64 charset, no whitespace.
  if (s.length < 256) return false;
  if (/\s/.test(s)) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) return false;
  return true;
};

const redactString = (value: string): string => {
  if (looksLikeBase64Audio(value)) return "[REDACTED_BASE64]";
  // conservative: redact anything that looks like a bearer token / api key-ish
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s\"']+)/gi, "$1[REDACTED]")
    .replace(/(token\s*[:=]\s*)([^\s\"']+)/gi, "$1[REDACTED]");
};

const redact = (key: string, value: unknown): unknown => {
  if (typeof value !== "string") return value;
  if (["audio", "payload", "pcm", "pcm16", "mulaw"].includes(key)) {
    return "[REDACTED_AUDIO]";
  }
  return redactString(value);
};

const safeJson = (meta: Record<string, unknown>) =>
  JSON.parse(
    JSON.stringify(meta, (k, v) => {
      if (!k) return v;
      return redact(k, v);
    }),
  );

const baseLog = (level: Level, msg: string, fields?: Record<string, unknown>) => {
  if (!shouldLog(level)) return;
  const payload = {
    t: nowIso(),
    level,
    msg,
    ...(fields ? safeJson(fields) : {}),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
};

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => baseLog("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => baseLog("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => baseLog("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => baseLog("error", msg, fields),
};
