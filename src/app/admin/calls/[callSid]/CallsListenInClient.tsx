"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";

type Turn = {
  id: number;
  created_at: string;
  call_sid: string;
  turn_index: number;
  trace_id: string | null;
  stream_sid: string | null;
  session_id: string | null;
  response_id: string | null;
  user_text: string | null;
  assistant_text: string | null;
};

export function CallsListenInClient({ callSid, adminToken }: { callSid: string; adminToken?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<string>("loading");
  const lastIdRef = useRef<number>(0);

  const turnsUrl = useMemo(() => {
    const u = new URL(`/api/admin/calls/${encodeURIComponent(callSid)}/turns`, window.location.origin);
    if (adminToken) u.searchParams.set("token", adminToken);
    return u.toString();
  }, [callSid, adminToken]);

  const fetchTurns = async () => {
    const res = await fetch(turnsUrl, { cache: "no-store" });
    const json = await res.json();
    if (!json?.ok) throw new Error(json?.error ?? "Failed to load turns");
    const nextTurns = (json.turns ?? []) as Turn[];
    setTurns(nextTurns);
    const maxId = nextTurns.reduce((m, t) => Math.max(m, t.id ?? 0), 0);
    lastIdRef.current = maxId;
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setStatus("loading");
        await fetchTurns();
        if (!cancelled) setStatus("ok");
      } catch (e) {
        if (!cancelled) setStatus(e instanceof Error ? e.message : "error");
      }
    })();

    const poll = setInterval(async () => {
      try {
        await fetchTurns();
        if (!cancelled) setStatus("ok");
      } catch (e) {
        if (!cancelled) setStatus(e instanceof Error ? e.message : "error");
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnsUrl]);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    if (!supabase) return;

    // Realtime is optional; if it fails, polling continues.
    const channel = supabase
      .channel(`call_turns:${callSid}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "call_turns",
          filter: `call_sid=eq.${callSid}`,
        },
        async (payload) => {
          const id = (payload.new as any)?.id as number | undefined;
          if (id && id <= lastIdRef.current) return;
          try {
            await fetchTurns();
          } catch {
            // ignore
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callSid, turnsUrl]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div style={{ fontWeight: 700 }}>Listen-in</div>
          <div style={{ opacity: 0.8, fontSize: 12 }}>status: {status}</div>
        </div>
        <button
          onClick={() => fetchTurns().catch(() => {})}
          style={{ border: "1px solid #333", padding: "6px 10px", borderRadius: 6 }}
        >
          Refresh
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {turns.map((t) => (
          <div key={t.id} style={{ border: "1px solid #222", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>Turn {t.turn_index}</div>
              <div style={{ opacity: 0.7, fontSize: 12 }}>{new Date(t.created_at).toLocaleString()}</div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>User</div>
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{t.user_text ?? ""}</pre>
              </div>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Assistant</div>
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{t.assistant_text ?? ""}</pre>
              </div>
            </div>
          </div>
        ))}

        {!turns.length && <div style={{ opacity: 0.8 }}>No turns yet.</div>}
      </div>
    </div>
  );
}
