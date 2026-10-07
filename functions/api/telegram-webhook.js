import { supabaseRequest, json, telegramApi, fmtIDR, fmtMoney, monthRange } from "./_utils.js";

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
    [
      { text: "Accounts (this month)", callback_data: "sum_acc_this" },
      { text: "Accounts (last month)", callback_data: "sum_acc_last" },
    ],
  ],
};

// Money in and out per account for one month: income and expenses from the ledger plus
// transfers in and out. The fee is already inside "expense" when it was booked as an
// expense; otherwise (non-IDR source account) it is added to the transfer's outflow here.
// Use it at month-end: opening balance + net = closing balance.
async function accountMovementText(env, year, month) {
  const [start, end] = monthRange(year, month);
  const get = async (path) => {
    const res = await supabaseRequest(env, path);
    return res.ok ? res.json() : null;
  };
  const [accounts, cats, ledger, transfers] = await Promise.all([
    get("payment_accounts?select=id,name,currency,account_type&order=sort_order.asc,name.asc"),
    get("expense_categories?select=id,type"),
    get(`expense_ledger?expense_date=gte.${start}&expense_date=lte.${end}&select=account_id,amount,category_id&limit=5000`),
    get(`transfers?transfer_date=gte.${start}&transfer_date=lte.${end}&select=from_account_id,to_account_id,amount_out,amount_in,fee_amount,fee_ledger_id&limit=5000`),
  ]);
  if (!accounts || !cats || !ledger || !transfers) {
    return "Could not load account movement. Has migration_v3_transfers.sql been run?";
  }

  const typeOf = new Map(cats.map((c) => [c.id, c.type]));
  const byId = new Map(accounts.map((a) => [a.id, { a, inflow: 0, outflow: 0 }]));
  for (const r of ledger) {
    const x = byId.get(r.account_id);
    if (!x) continue;
    if (typeOf.get(r.category_id) === "income") x.inflow += Number(r.amount);
    else x.outflow += Number(r.amount);
  }
  for (const t of transfers) {
    const from = byId.get(t.from_account_id);
    const to = byId.get(t.to_account_id);
    if (from) {
      from.outflow += Number(t.amount_out);
      if (!t.fee_ledger_id) from.outflow += Number(t.fee_amount);
    }
    if (to) to.inflow += Number(t.amount_in);
  }

  const lines = [`<b>Account movement (${month}/${year})</b>`];
  for (const { a, inflow, outflow } of byId.values()) {
    if (inflow === 0 && outflow === 0) continue;
    const cur = a.currency || "IDR";
    const net = inflow - outflow;
    const label =
      a.account_type === "liability"
        ? `owed ${net < 0 ? "+" : net > 0 ? "-" : ""}${fmtMoney(Math.abs(net), cur)}`
        : `net ${net < 0 ? "-" : ""}${fmtMoney(Math.abs(net), cur)}`;
    lines.push(`${escapeHtml(a.name)}: in ${fmtMoney(inflow, cur)}, out ${fmtMoney(outflow, cur)}, ${label}`);
  }
  if (lines.length === 1) return `${lines[0]}\nNo movement.`;
  lines.push("", "Flows only. Investment accounts show money in and out, not market value.");
  return lines.join("\n");
}

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
  if (key === "sum_acc_this") {
    const { year, month } = thisMonth();
    return accountMovementText(env, year, month);
  }
  if (key === "sum_acc_last") {
    const { year, month } = lastMonth();
    return accountMovementText(env, year, month);
  }
  if (key === "sum_tag_this") {
    const { year, month } = thisMonth();
    const [start, end] = monthRange(year, month);
    const rows = await rpc(env, "summary_by_tag", { p_start: start, p_end: end });
    return breakdownText(`By tag (${month}/${year})`, rows, "tag");
  }
  return "Unknown report.";
}

async function handleUndo(env, chatId, explicitTxnNo) {
  // explicitTxnNo is the YYMMNNNN number shown in the notification, not the
  // raw internal id — that's still used under the hood for the actual delete.
  const query = explicitTxnNo
    ? `expense_ledger?txn_no=eq.${explicitTxnNo}&select=id,txn_no,expense_date,amount,category_id,subcategory_id`
    : "expense_ledger?select=id,txn_no,expense_date,amount,category_id,subcategory_id&order=created_at.desc&limit=1";

  const res = await supabaseRequest(env, query);
  if (!res.ok) return telegramApi(env, "sendMessage", { chat_id: chatId, text: "Could not look up that entry." });
  const rows = await res.json();
  if (rows.length === 0) {
    const msg = explicitTxnNo ? `No transaction #${explicitTxnNo}.` : "Nothing to undo.";
    return telegramApi(env, "sendMessage", { chat_id: chatId, text: msg });
  }
  const row = rows[0];
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: `Delete transaction #${row.txn_no || row.id}?\n${row.expense_date} · ${fmtIDR(row.amount)}`,
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

// /undo T2610001 deletes a transfer (and the fee expense that was booked with it).
async function handleUndoTransfer(env, chatId, txnNo) {
  const res = await supabaseRequest(
    env,
    `transfers?txn_no=eq.${txnNo}&select=id,txn_no,transfer_date,amount_out,from_account_id,to_account_id`
  );
  const rows = res.ok ? await res.json() : [];
  if (rows.length === 0) {
    return telegramApi(env, "sendMessage", { chat_id: chatId, text: `No transfer #${txnNo}.` });
  }
  const row = rows[0];
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: `Delete transfer #${row.txn_no}?\n${row.transfer_date} · ${row.amount_out} (the fee expense is deleted too)`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes, delete", callback_data: `undo_t_confirm_${row.id}` },
          { text: "Cancel", callback_data: "undo_cancel" },
        ],
      ],
    },
  });
}

async function deleteTransfer(env, id) {
  const res = await supabaseRequest(env, `transfers?id=eq.${id}&select=id,fee_ledger_id`);
  const rows = res.ok ? await res.json() : [];
  if (rows.length === 0) return false;
  if (rows[0].fee_ledger_id) {
    await supabaseRequest(env, `expense_ledger?id=eq.${rows[0].fee_ledger_id}`, { method: "DELETE" });
  }
  const del = await supabaseRequest(env, `transfers?id=eq.${id}`, { method: "DELETE" });
  return del.ok;
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
    } else if (data.startsWith("undo_t_confirm_")) {
      const id = data.replace("undo_t_confirm_", "");
      const ok = await deleteTransfer(env, id);
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: ok ? "Transfer deleted." : "Could not delete that transfer." });
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
    if (parts.length > 1 && /^t\d{7}$/.test(parts[1])) {
      await handleUndoTransfer(env, chatId, parts[1].toUpperCase());
    } else {
      const explicitTxnNo = parts.length > 1 && /^\d{6,8}$/.test(parts[1]) ? parts[1] : null;
      await handleUndo(env, chatId, explicitTxnNo);
    }
  } else if (text.startsWith("/transfer")) {
    // Opens the same Mini App in transfer mode through the startapp parameter.
    const link = env.MINI_APP_LINK || "";
    const sep = link.includes("?") ? "&" : "?";
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: "Tap to log a transfer between accounts:",
      reply_markup: { inline_keyboard: [[{ text: "Log Transfer", url: `${link}${sep}startapp=transfer` }]] },
    });
  } else if (text.startsWith("/accounts")) {
    const { year, month } = thisMonth();
    const report = await accountMovementText(env, year, month);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: report, parse_mode: "HTML" });
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
