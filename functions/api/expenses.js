import { requireAuth, supabaseRequest, json } from "./_utils.js";

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

  const { expense_date, category_id, subcategory_id, account_id, amount, description } = body || {};

  // --- Basic shape validation ---
  if (!expense_date || !/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
    return json({ error: "expense_date must be YYYY-MM-DD" }, 400);
  }
  const catId = Number(category_id);
  const subId = Number(subcategory_id);
  const accId = Number(account_id);
  const amt = Number(amount);
  if (!Number.isInteger(catId) || !Number.isInteger(subId) || !Number.isInteger(accId)) {
    return json({ error: "category_id, subcategory_id, account_id must be integers" }, 400);
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    return json({ error: "amount must be a positive number" }, 400);
  }
  const desc = typeof description === "string" ? description.slice(0, 500) : null;

  // --- Referential validation: subcategory must belong to category, account must exist ---
  const [subRes, accRes] = await Promise.all([
    supabaseRequest(env, `expense_subcategories?id=eq.${subId}&select=id,category_id`),
    supabaseRequest(env, `payment_accounts?id=eq.${accId}&select=id`),
  ]);
  if (!subRes.ok || !accRes.ok) return json({ error: "validation lookup failed" }, 502);

  const subRows = await subRes.json();
  const accRows = await accRes.json();

  if (subRows.length === 0 || subRows[0].category_id !== catId) {
    return json({ error: "subcategory does not belong to the given category" }, 400);
  }
  if (accRows.length === 0) {
    return json({ error: "unknown payment account" }, 400);
  }

  // --- Insert ---
  const insertRes = await supabaseRequest(env, "expense_ledger", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      expense_date,
      category_id: catId,
      subcategory_id: subId,
      account_id: accId,
      amount: amt,
      description: desc,
      telegram_user_id: auth.user.id,
      source: "telegram",
    }),
  });

  if (!insertRes.ok) {
    const errText = await insertRes.text();
    return json({ error: "insert failed", detail: errText }, 502);
  }

  const [row] = await insertRes.json();
  return json({ ok: true, expense: row });
}
