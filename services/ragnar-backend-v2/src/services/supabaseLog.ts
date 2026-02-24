import { createClient, SupabaseClient } from "@supabase/supabase-js";

const ENABLED = process.env.SUPABASE_LOG_CALLS === "1";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!ENABLED) return null;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (_client) return _client;

  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

const truncate = (value: unknown, max = 2000) => {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
};

export type SupabaseCallMeta = {
  callSid?: string;
  streamSid?: string;
  traceId?: string;
  sessionId?: string;
  relayInputSampleRate?: number;
  relayOutputSampleRate?: number;
  startedAtMs?: number;
};

export async function supabaseUpsertCall(meta: SupabaseCallMeta): Promise<void> {
  const client = getClient();
  if (!client) return;

  const callSid = truncate(meta.callSid, 128);
  if (!callSid) return;

  const row = {
    call_sid: callSid,
    stream_sid: truncate(meta.streamSid, 128),
    trace_id: truncate(meta.traceId, 128),
    session_id: truncate(meta.sessionId, 128),
    relay_input_sample_rate: meta.relayInputSampleRate ?? null,
    relay_output_sample_rate: meta.relayOutputSampleRate ?? null,
    started_at: meta.startedAtMs ? new Date(meta.startedAtMs).toISOString() : null,
  };

  // Best-effort: avoid breaking call flow if Supabase is unavailable.
  try {
    await client.from("calls").upsert(row, { onConflict: "call_sid" });
  } catch {
    // ignore
  }
}

export async function supabaseMarkCallEnded(callSidRaw: string | undefined): Promise<void> {
  const client = getClient();
  if (!client) return;

  const callSid = truncate(callSidRaw, 128);
  if (!callSid) return;

  try {
    await client
      .from("calls")
      .update({ ended_at: new Date().toISOString() })
      .eq("call_sid", callSid);
  } catch {
    // ignore
  }
}

export type SupabaseTurn = {
  callSid?: string;
  traceId?: string;
  streamSid?: string;
  sessionId?: string;
  turnIndex: number;
  userText: string;
  assistantText: string;
  instructions?: string;
  responseId?: string;
};

export async function supabaseInsertTurn(turn: SupabaseTurn): Promise<void> {
  const client = getClient();
  if (!client) return;

  const callSid = truncate(turn.callSid, 128);
  if (!callSid) return;

  const row = {
    call_sid: callSid,
    turn_index: turn.turnIndex,
    trace_id: truncate(turn.traceId, 128),
    stream_sid: truncate(turn.streamSid, 128),
    session_id: truncate(turn.sessionId, 128),
    user_text: truncate(turn.userText, 4000),
    assistant_text: truncate(turn.assistantText, 8000),
    instructions: truncate(turn.instructions, 2000),
    response_id: truncate(turn.responseId, 128),
  };

  try {
    await client.from("call_turns").insert(row);
  } catch {
    // ignore
  }
}

export function supabaseLoggingEnabled(): boolean {
  return ENABLED && !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;
}
