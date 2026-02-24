import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { CallsListenInClient } from "./CallsListenInClient";

function assertAdminToken(searchParams: Record<string, string | string[] | undefined>) {
  const required = process.env.ADMIN_TOKEN;
  if (!required) return;
  const token = typeof searchParams.token === "string" ? searchParams.token : undefined;
  if (token !== required) {
    throw new Error("Unauthorized");
  }
}

export default async function CallListenInPage({
  params,
  searchParams,
}: {
  params: Promise<{ callSid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { callSid } = await params;
  const sp = await searchParams;

  try {
    assertAdminToken(sp);
  } catch {
    return (
      <main style={{ padding: 24 }}>
        <h1 style={{ fontSize: 18, fontWeight: 800 }}>Unauthorized</h1>
        <p style={{ opacity: 0.8 }}>
          This page requires <code>?token=...</code> (ADMIN_TOKEN).
        </p>
      </main>
    );
  }

  let call: any = null;

  try {
    const supabase = getSupabaseAdmin();
    const { data: callData } = await supabase
      .from("calls")
      .select(
        "call_sid, created_at, started_at, ended_at, trace_id, stream_sid, session_id, relay_input_sample_rate, relay_output_sample_rate"
      )
      .eq("call_sid", callSid)
      .maybeSingle();

    call = callData;

    // Turns are loaded client-side via /api/admin/... (polling + optional realtime).
  } catch {
    // if env vars aren't set, the client can still poll the API route (which will also fail)
  }

  const adminToken = typeof sp.token === "string" ? sp.token : undefined;

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Call: {callSid}</h1>
        {call ? (
          <div style={{ opacity: 0.8, fontSize: 12 }}>
            traceId: {call.trace_id ?? "—"} | streamSid: {call.stream_sid ?? "—"} | sessionId:{" "}
            {call.session_id ?? "—"}
          </div>
        ) : (
          <div style={{ opacity: 0.8, fontSize: 12 }}>
            (No call metadata found yet — waiting for first upsert.)
          </div>
        )}
      </div>

      {/* Client handles polling + optional realtime */}
      <CallsListenInClient callSid={callSid} adminToken={adminToken} />

    </main>
  );
}
