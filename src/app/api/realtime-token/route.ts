import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const REALTIME_SESSION_URL = "https://api.openai.com/v1/realtime/sessions";
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview-2024-12-17";

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing OPENAI_API_KEY" },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(REALTIME_SESSION_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: REALTIME_MODEL,
        voice: process.env.OPENAI_REALTIME_VOICE ?? "verse",
        modalities: ["text", "audio"],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json(
        { error: "Failed to create session", details: error },
        { status: response.status }
      );
    }

    const session = await response.json();
    return NextResponse.json(session);
  } catch (error) {
    console.error("realtime token error", error);
    return NextResponse.json(
      { error: "Unexpected error creating session" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return POST();
}
