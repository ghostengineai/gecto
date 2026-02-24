export interface ConversationTurn {
  userText: string;
  instructions?: string;
}

export interface ConversationResponse {
  text: string;
}

// Minimal deterministic "reasoning" loop placeholder.
// Swap this with your real LLM/agent core.
export class ConversationCore {
  private turn = 0;

  respond(input: ConversationTurn): ConversationResponse {
    this.turn += 1;
    const u = input.userText.trim();
    const instruction = input.instructions?.trim();

    const preface = `Ragnar (${this.turn}): `;
    const base = u
      ? `I heard: "${u}".`
      : "I didn't catch that clearly.";

    const followUp = " What would you like to do next?";
    const extra = instruction ? ` (I also noted your instruction: ${instruction})` : "";

    return { text: `${preface}${base}${extra}${followUp}` };
  }

  chunkText(text: string, maxLen = 80): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let cur: string[] = [];
    for (const w of words) {
      const cand = cur.length ? `${cur.join(" ")} ${w}` : w;
      if (cand.length > maxLen && cur.length) {
        out.push(cur.join(" "));
        cur = [w];
      } else {
        cur.push(w);
      }
    }
    if (cur.length) out.push(cur.join(" "));
    return out;
  }
}
