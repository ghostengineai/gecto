import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in env");
  process.exit(1);
}

const client = twilio(accountSid, authToken);

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k] ?? null;
  return out;
}

(async () => {
  const numbers = await client.incomingPhoneNumbers.list({ limit: 50 });

  const out = [];
  for (const n of numbers) {
    const entry = {
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      sid: n.sid,
      voice: pick(n, [
        "voiceUrl",
        "voiceMethod",
        "voiceApplicationSid",
        "statusCallback",
        "statusCallbackMethod",
      ]),
      sms: pick(n, ["smsUrl", "smsMethod"]),
    };

    if (n.voiceApplicationSid) {
      try {
        const app = await client.applications(n.voiceApplicationSid).fetch();
        entry.voiceApplication = pick(app, ["sid", "friendlyName", "voiceUrl", "voiceMethod", "statusCallback", "statusCallbackMethod"]);
      } catch (e) {
        entry.voiceApplication = { error: e?.message ?? String(e) };
      }
    }

    out.push(entry);
  }

  console.log(JSON.stringify({ ok: true, count: out.length, numbers: out }, null, 2));
})().catch((err) => {
  console.error("inspect failed:", err?.message ?? err);
  process.exit(1);
});
