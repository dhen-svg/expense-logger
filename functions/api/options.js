import { requireAuth, supabaseRequest, json } from "./_utils.js";

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireAuth(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const [catRes, subRes, accRes, spenderRes, tagRes] = await Promise.all([
    supabaseRequest(env, "expense_categories?select=id,name,type&order=type.asc,sort_order.asc,name.asc"),
    supabaseRequest(env, "expense_subcategories?select=id,category_id,name&order=sort_order.asc,name.asc"),
    supabaseRequest(env, "payment_accounts?select=id,name&order=sort_order.asc,name.asc"),
    supabaseRequest(env, "spenders?select=id,name&order=sort_order.asc,name.asc"),
    supabaseRequest(env, "tags?select=name&order=name.asc"),
  ]);

  if (!catRes.ok || !subRes.ok || !accRes.ok || !spenderRes.ok || !tagRes.ok) {
    return json({ error: "failed to load options" }, 502);
  }

  const [categories, subcategories, accounts, spenders, tagRows] = await Promise.all([
    catRes.json(),
    subRes.json(),
    accRes.json(),
    spenderRes.json(),
    tagRes.json(),
  ]);

  return json({
    categories,
    subcategories,
    accounts,
    spenders,
    tags: tagRows.map((t) => t.name),
  });
}
