import { supabaseRequest, json, notifyChat, fmtIDR, monthRange } from "./_utils.js";

async function rpc(env, name, params) {
  const res = await supabaseRequest(env, `rpc/${name}`, { method: "POST", body: JSON.stringify(params) });
  if (!res.ok) return null;
  return res.json();
}

function thisWeekRange() {
  const now = new Date();
  const day = now.getUTCDay() || 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - day + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const iso = (d) => d.toISOString().slice(0, 10);
  return [iso(monday), iso(sunday)];
}

// Cloudflare Pages has no built-in scheduler, so this endpoint is meant to
// be triggered by a free external cron service (e.g. cron-job.org) hitting:
//   /api/digest?period=week&secret=<DIGEST_SECRET>
//   /api/digest?period=month&secret=<DIGEST_SECRET>
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.DIGEST_SECRET || url.searchParams.get("secret") !== env.DIGEST_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const period = url.searchParams.get("period") === "month" ? "month" : "week";

  let start, end, label;
  if (period === "month") {
    const now = new Date();
    [start, end] = monthRange(now.getUTCFullYear(), now.getUTCMonth() + 1);
    label = `Monthly digest (${start} to ${end})`;
  } else {
    [start, end] = thisWeekRange();
    label = `Weekly digest (${start} to ${end})`;
  }

  const [totalsRows, catRows] = await Promise.all([
    rpc(env, "get_totals_range", { p_start: start, p_end: end }),
    rpc(env, "summary_by_category", { p_start: start, p_end: end }),
  ]);

  const totals = totalsRows?.[0];
  const lines = [`<b>${label}</b>`];
  if (totals) {
    lines.push(`Income: ${fmtIDR(totals.income)}`, `Expense: ${fmtIDR(totals.expense)}`, `Net: ${fmtIDR(totals.net)}`);
  } else {
    lines.push("No data.");
  }
  if (catRows && catRows.length) {
    lines.push("", "Top categories:");
    for (const r of catRows.slice(0, 5)) lines.push(`${r.category}: ${fmtIDR(r.subtotal)}`);
  }

  await notifyChat(env, lines.join("\n"));
  return json({ ok: true, period, start, end });
}
