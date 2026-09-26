import { requireAuth, supabaseRequest, json, notifyChat } from "./_utils.js";

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
    used_by_id,
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
  const usedById = used_by_id ? Number(used_by_id) : null;
  const amt = Number(amount);

  if (!Number.isInteger(catId) || !Number.isInteger(subId) || !Number.isInteger(accId)) {
    return json({ error: "category_id, subcategory_id, account_id must be integers" }, 400);
  }
  if (used_by_id && !Number.isInteger(usedById)) {
    return json({ error: "used_by_id must be an integer" }, 400);
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
  if (usedById) lookups.push(supabaseRequest(env, `spenders?id=eq.${usedById}&select=id,name`));

  const [subRes, catRes, accRes, spenderRes] = await Promise.all(lookups);
  if (!subRes.ok || !catRes.ok || !accRes.ok || (usedById && !spenderRes.ok)) {
    return json({ error: "validation lookup failed" }, 502);
  }

  const subRows = await subRes.json();
  const catRows = await catRes.json();
  const accRows = await accRes.json();
  const spenderRows = usedById ? await spenderRes.json() : [];

  if (subRows.length === 0 || subRows[0].category_id !== catId) {
    return json({ error: "subcategory does not belong to the given category" }, 400);
  }
  if (catRows.length === 0) return json({ error: "unknown category" }, 400);
  if (accRows.length === 0) return json({ error: "unknown payment account" }, 400);
  if (usedById && spenderRows.length === 0) return json({ error: "unknown used_by" }, 400);

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
      used_by_id: usedById,
      amount: amt,
      description: desc,
      tags: tagNames,
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
  const spenderName = spenderRows[0]?.name;
  const submittedBy = auth.user.first_name || auth.user.username || "Someone";
  const sign = category.type === "income" ? "+" : "-";

  const lines = [
    `<b>${sign}Rp ${amt.toLocaleString("id-ID")}</b> logged by ${escapeHtml(submittedBy)}`,
    `${escapeHtml(category.name)} / ${escapeHtml(subcategory.name || "")}`,
    `${expense_date} ${time} · ${escapeHtml(account.name)}`,
  ];
  if (spenderName) lines.push(`Used by: ${escapeHtml(spenderName)}`);
  if (desc) lines.push(`"${escapeHtml(desc)}"`);
  if (tagNames.length) lines.push(`Tags: ${tagNames.map((t) => "#" + t).join(" ")}`);

  await notifyChat(env, lines.join("\n"));

  return json({ ok: true, expense: row });
}
