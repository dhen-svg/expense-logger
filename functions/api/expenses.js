import {
  requireAuth,
  supabaseRequest,
  json,
  notifyChat,
  fmtIDR,
  fmtDateHuman,
  monthRange,
} from "./_utils.js";

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await requireAuth(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const {
    expense_date,
    expense_time,
    category_id,
    subcategory_id,
    account_id,
    used_by_ids,
    amount,
    description,
    tags,
  } = body || {};

  // --- Basic shape validation ---
  if (!expense_date || !/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
    return json({ error: "expense_date must be YYYY-MM-DD" }, 400);
  }
  const time = /^\d{2}:\d{2}(:\d{2})?$/.test(expense_time || "") ? expense_time : "12:00";

  const catId = Number(category_id);
  const subId = Number(subcategory_id);
  const accId = Number(account_id);
  const amt = Number(amount);
  const usedByIds = Array.isArray(used_by_ids)
    ? [...new Set(used_by_ids.map(Number).filter(Number.isInteger))]
    : [];

  if (!Number.isInteger(catId) || !Number.isInteger(subId) || !Number.isInteger(accId)) {
    return json({ error: "category_id, subcategory_id, account_id must be integers" }, 400);
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    return json({ error: "amount must be a positive number" }, 400);
  }
  const desc = typeof description === "string" ? description.slice(0, 500) : null;

  const tagNames = Array.isArray(tags)
    ? [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 10)
    : [];

  // --- Referential validation ---
  const lookups = [
    supabaseRequest(env, `expense_subcategories?id=eq.${subId}&select=id,category_id,name`),
    supabaseRequest(env, `expense_categories?id=eq.${catId}&select=id,name,type`),
    supabaseRequest(env, `payment_accounts?id=eq.${accId}&select=id,name`),
  ];
  if (usedByIds.length) {
    const idList = usedByIds.join(",");
    lookups.push(supabaseRequest(env, `spenders?id=in.(${idList})&select=id,name`));
  }

  const [subRes, catRes, accRes, spenderRes] = await Promise.all(lookups);
  if (!subRes.ok || !catRes.ok || !accRes.ok || (usedByIds.length && !spenderRes.ok)) {
    return json({ error: "validation lookup failed" }, 502);
  }

  const subRows = await subRes.json();
  const catRows = await catRes.json();
  const accRows = await accRes.json();
  const spenderRows = usedByIds.length ? await spenderRes.json() : [];

  if (subRows.length === 0 || subRows[0].category_id !== catId) {
    return json({ error: "subcategory does not belong to the given category" }, 400);
  }
  if (catRows.length === 0) return json({ error: "unknown category" }, 400);
  if (accRows.length === 0) return json({ error: "unknown payment account" }, 400);
  if (usedByIds.length && spenderRows.length !== usedByIds.length) {
    return json({ error: "one or more used_by_ids is unknown" }, 400);
  }

  // --- Generate the human-friendly YYMMNNNN transaction number ---
  const [txnYear, txnMonth] = expense_date.split("-").map(Number);
  const txnNoRes = await supabaseRequest(env, "rpc/next_txn_no", {
    method: "POST",
    body: JSON.stringify({ p_year: txnYear, p_month: txnMonth }),
  });
  const txnNo = txnNoRes.ok ? await txnNoRes.json() : null;

  // --- Upsert any brand-new tags so future dropdowns/autocomplete pick them up ---
  if (tagNames.length > 0) {
    await supabaseRequest(env, "tags", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify(tagNames.map((name) => ({ name }))),
    });
  }

  // --- Insert the ledger row ---
  const insertRes = await supabaseRequest(env, "expense_ledger", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      expense_date,
      expense_time: time,
      category_id: catId,
      subcategory_id: subId,
      account_id: accId,
      used_by_ids: usedByIds,
      amount: amt,
      description: desc,
      tags: tagNames,
      txn_no: txnNo,
      telegram_user_id: auth.user.id,
      source: "telegram",
    }),
  });

  if (!insertRes.ok) {
    const errText = await insertRes.text();
    return json({ error: "insert failed", detail: errText }, 502);
  }

  const [row] = await insertRes.json();

  // --- Notify the shared group (best-effort, never blocks the response) ---
  const category = catRows[0];
  const subcategory = subRows[0];
  const account = accRows[0];
  const submittedBy = auth.user.first_name || auth.user.username || "Someone";
  const usedByText = spenderRows.length ? spenderRows.map((s) => s.name).join(", ") : "—";

  const lines = [
    `<b>TRANSACTION LOGGED</b> · #${row.txn_no || row.id}`,
    `- at ${fmtDateHuman(expense_date)} ${time} by ${escapeHtml(submittedBy)}`,
    `- ${fmtIDR(amt)} on ${escapeHtml(account.name)}`,
    `- ${category.type === "income" ? "Income" : "Expense"} / ${escapeHtml(category.name)} / ${escapeHtml(subcategory.name)}`,
    `- Used by ${escapeHtml(usedByText)}`,
    `- Note: ${desc ? escapeHtml(desc) : "-"}`,
    `- Tags: ${tagNames.length ? tagNames.map((t) => "#" + t).join(" ") : "-"}`,
  ];
  await notifyChat(env, lines.join("\n"));

  // --- Budget-crossing alert (expense categories only) ---
  if (category.type === "expense") {
    await checkBudgetAlert(env, { catId, subId, category, subcategory, expense_date, amt });
  }

  return json({ ok: true, expense: row });
}

async function checkBudgetAlert(env, { catId, subId, category, subcategory, expense_date, amt }) {
  try {
    const [year, month] = expense_date.split("-").map(Number);

    // Prefer a subcategory-level budget; fall back to category-level.
    const budgetRes = await supabaseRequest(
      env,
      `budgets?category_id=eq.${catId}&year=eq.${year}&month=eq.${month}` +
        `&or=(subcategory_id.eq.${subId},subcategory_id.is.null)` +
        `&select=id,subcategory_id,planned_amount&order=subcategory_id.desc.nullslast&limit=1`
    );
    if (!budgetRes.ok) return;
    const budgetRows = await budgetRes.json();
    if (budgetRows.length === 0) return;

    const budget = budgetRows[0];
    const scopedToSub = budget.subcategory_id !== null;
    const [start, end] = monthRange(year, month);

    const filterClause = scopedToSub
      ? `category_id=eq.${catId}&subcategory_id=eq.${subId}`
      : `category_id=eq.${catId}`;

    const sumRes = await supabaseRequest(
      env,
      `expense_ledger?${filterClause}&expense_date=gte.${start}&expense_date=lte.${end}&select=amount`
    );
    if (!sumRes.ok) return;
    const rows = await sumRes.json();
    const total = rows.reduce((acc, r) => acc + Number(r.amount), 0);
    const previousTotal = total - amt;
    const planned = Number(budget.planned_amount);

    // Only fire the moment this transaction is the one that pushes it over.
    if (previousTotal < planned && total >= planned) {
      const pct = Math.round((total / planned) * 100);
      const label = scopedToSub ? subcategory.name : category.name;
      await notifyChat(
        env,
        `⚠️ <b>Budget alert</b>\n${label} has hit ${fmtIDR(total)} / ${fmtIDR(planned)} (${pct}%) for this month.`
      );
    }
  } catch {
    // best-effort only — never fail the transaction save over this
  }
}
