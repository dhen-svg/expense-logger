import { requireAuth, supabaseRequest, json } from "./_utils.js";

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireAuth(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const [catRes, subRes, accRes] = await Promise.all([
    supabaseRequest(env, "expense_categories?select=id,name&order=name.asc"),
    supabaseRequest(env, "expense_subcategories?select=id,category_id,name&order=name.asc"),
    supabaseRequest(env, "payment_accounts?select=id,name&order=name.asc"),
  ]);

  if (!catRes.ok || !subRes.ok || !accRes.ok) {
    return json({ error: "failed to load options" }, 502);
  }

  const [categories, subcategories, accounts] = await Promise.all([
    catRes.json(),
    subRes.json(),
    accRes.json(),
  ]);

  return json({ categories, subcategories, accounts });
}
