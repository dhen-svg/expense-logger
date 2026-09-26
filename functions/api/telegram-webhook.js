import { supabaseRequest, json, telegramApi, fmtIDR, monthRange } from "./_utils.js";

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function thisMonth() {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function lastMonth() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function thisWeekRange() {
  const now = new Date();
  const day = now.getUTCDay() || 7; // Mon=1 ... Sun=7
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - day + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const iso = (d) => d.toISOString().slice(0, 10);
  return [iso(monday), iso(sunday)];
}

async function rpc(env, name, params) {
  const res = await supabaseRequest(env, `rpc/${name}`, { method: "POST", body: JSON.stringify(params) });
  if (!res.ok) return null;
  return res.json();
}

function totalsText(title, row) {
  if (!row) return `${title}\nNo data.`;
  return [
    `<b>${title}</b>`,
    `Income: ${fmtIDR(row.income)}`,
    `Expense: ${fmtIDR(row.expense)}`,
    `Net: ${fmtIDR(row.net)}`,
  ].join("\n");
}

function breakdownText(title, rows, labelKey) {
  if (!rows || rows.length === 0) return `${title}\nNo data.`;
  const lines = rows
    .slice(0, 10)
    .map((r) => `${escapeHtml(r[labelKey])}: ${fmtIDR(r.subtotal)}`);
  return [`<b>${title}</b>`, ...lines].join("\n");
}

const REPORT_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "This Month", callback_data: "sum_month_this" },
      { text: "Last Month", callback_data: "sum_month_last" },
    ],
    [
      { text: "This Week", callback_data: "sum_week_this" },
    ],
    [
      { text: "By Category (month)", callback_data: "sum_cat_this" },
      { text: "By Tag (month)", callback_data: "sum_tag_this" },
    ],
  ],
};

async function buildReport(env, key) {
  if (key === "sum_month_this") {
    const { year, month } = thisMonth();
    const rows = await rpc(env, "get_totals", { p_year: year, p_month: month });
    return totalsText(`This month (${month}/${year})`, rows?.[0]);
  }
  if (key === "sum_month_last") {
    const { year, month } = lastMonth();
    const rows = await rpc(env, "get_totals", { p_year: year, p_month: month });
    return totalsText(`Last month (${month}/${year})`, rows?.[0]);
  }
  if (key === "sum_week_this") {
    const [start, end] = thisWeekRange();
    const rows = await rpc(env, "get_totals_range", { p_start: start, p_end: end });
    return totalsText(`This week (${start} to ${end})`, rows?.[0]);
  }
  if (key === "sum_cat_this") {
    const { year, month } = thisMonth();
    const [start, end] = monthRange(year, month);
    const rows = await rpc(env, "summary_by_category", { p_start: start, p_end: end });
    return breakdownText(`By category (${month}/${year})`, rows, "category");
  }
  if (key === "sum_tag_this") {
    const { year, month } = thisMonth();
    const [start, end] = monthRange(year, month);
    const rows = await rpc(env, "summary_by_tag", { p_start: start, p_end: end });
    return breakdownText(`By tag (${month}/${year})`, rows, "tag");
  }
  return "Unknown report.";
}

async function handleUndo(env, chatId, explicitId) {
  const filter = explicitId
    ? `id=eq.${explicitId}`
    : "order=created_at.desc&limit=1";
  const query = explicitId
    ? `expense_ledger?${filter}&select=id,expense_date,amount,category_id,subcategory_id`
    : `expense_ledger?select=id,expense_date,amount,category_id,subcategory_id&${filter}`;

  const res = await supabaseRequest(env, query);
  if (!res.ok) return telegramApi(env, "sendMessage", { chat_id: chatId, text: "Could not look up that entry." });
  const rows = await res.json();
  if (rows.length === 0) {
    const msg = explicitId ? `No transaction with ID #${explicitId}.` : "Nothing to undo.";
    return telegramApi(env, "sendMessage", { chat_id: chatId, text: msg });
  }
  const row = rows[0];
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: `Delete transaction #${row.id}?\n${row.expense_date} · ${fmtIDR(row.amount)}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes, delete", callback_data: `undo_confirm_${row.id}` },
          { text: "Cancel", callback_data: "undo_cancel" },
        ],
      ],
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false }, 401);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true }); // ignore malformed bodies
  }

  // --- Button taps ---
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const data = cq.data || "";

    if (data.startsWith("sum_")) {
      const text = await buildReport(env, data);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
    } else if (data.startsWith("undo_confirm_")) {
      const id = data.replace("undo_confirm_", "");
      await supabaseRequest(env, `expense_ledger?id=eq.${id}`, { method: "DELETE" });
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Deleted." });
    } else if (data === "undo_cancel") {
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Cancelled." });
    }

    await telegramApi(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return json({ ok: true });
  }

  // --- Text commands ---
  const message = update.message;
  const text = (message?.text || "").trim().toLowerCase();
  const chatId = message?.chat?.id;
  if (!chatId) return json({ ok: true });

  if (text.startsWith("/summary")) {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "Which report?",
      reply_markup: REPORT_KEYBOARD,
    });
  } else if (text.startsWith("/undo") || text.startsWith("/cancel")) {
    const parts = text.split(/\s+/);
    const explicitId = parts.length > 1 && /^\d+$/.test(parts[1]) ? parts[1] : null;
    await handleUndo(env, chatId, explicitId);
  } else if (text.startsWith("/log")) {
    // NOTE: web_app-type buttons are rejected by Telegram in group chats
    // (BUTTON_TYPE_INVALID). MINI_APP_LINK must be the t.me/<bot>/<app>
    // direct link from BotFather's /newapp, used as a plain url button.
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "Tap to log a transaction:",
      reply_markup: {
        inline_keyboard: [[{ text: "Log Transaction", url: env.MINI_APP_LINK }]],
      },
    });
  }

  return json({ ok: true });
}
