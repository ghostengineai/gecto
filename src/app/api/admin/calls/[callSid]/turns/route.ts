import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

function assertAdminToken(request: Request) {
  const required = process.env.ADMIN_TOKEN;
  if (!required) return;

  const url = new URL(request.url);
  const token = request.headers.get("x-admin-token") ?? url.searchParams.get("token");
  if (token !== required) {
    throw new Error("Unauthorized");
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ callSid: string }> }) {
  try {
    assertAdminToken(request);
    const { callSid } = await params;

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("call_turns")
      .select(
        "id, created_at, call_sid, turn_index, trace_id, stream_sid, session_id, response_id, user_text, assistant_text"
      )
      .eq("call_sid", callSid)
      .order("turn_index", { ascending: true })
      .limit(200);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, turns: data ?? [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unauthorized";
    const status = msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
