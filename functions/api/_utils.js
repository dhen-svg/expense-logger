// Shared helpers for all API functions.
// Verifies Telegram Mini App initData per Telegram's documented HMAC scheme,
// and wraps calls to the Supabase REST API using the server-only secret key.

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Verifies initData against the bot token. Returns { user, authDate } on
// success, or null if the signature is invalid, missing, or stale (>24h).
export async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const encoder = new TextEncoder();

  // secret_key = HMAC_SHA256(key="WebAppData", data=botToken)
  const secretKeyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const secretKeyBuffer = await crypto.subtle.sign("HMAC", secretKeyMaterial, encoder.encode(botToken));

  // computed_hash = HMAC_SHA256(key=secret_key, data=dataCheckString)
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    secretKeyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(dataCheckString));
  const computedHash = bufferToHex(sigBuffer);

  if (computedHash !== hash) return null;

  const authDate = parseInt(params.get("auth_date"), 10);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 86400) return null; // reject sessions older than 24h

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    user = null;
  }
  if (!user || !user.id) return null;

  return { user, authDate };
}

export async function requireAuth(request, env) {
  const initData = request.headers.get("X-Telegram-Init-Data") || "";
  return verifyInitData(initData, env.TELEGRAM_BOT_TOKEN);
}

export async function supabaseRequest(env, path, options = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Posts a message into the configured group/chat. Silently does nothing if
// NOTIFY_CHAT_ID isn't set, and never throws — a notification failure should
// never fail the actual expense save.
export async function notifyChat(env, text) {
  if (!env.NOTIFY_CHAT_ID || !env.TELEGRAM_BOT_TOKEN) return;
  try {
    await telegramApi(env, "sendMessage", {
      chat_id: env.NOTIFY_CHAT_ID,
      text,
      parse_mode: "HTML",
    });
  } catch {
    // best-effort only
  }
}

// Generic Telegram Bot API call. Never throws — callers that care about the
// result can inspect the return value; notifications are always best-effort.
export async function telegramApi(env, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch {
    return null;
  }
}

export function fmtIDR(n) {
  return "Rp " + Math.round(n).toLocaleString("id-ID");
}

export function fmtDateHuman(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Returns [monthStart, monthEnd] as YYYY-MM-DD for the given year/month (1-12).
export function monthRange(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return [iso(start), iso(end)];
}
