import { requireAuth, supabaseRequest, json, monthRange } from "./_utils.js";

// PostgREST returns at most 1000 rows per request, so read in pages.
async function fetchAll(env, path) {
  const rows = [];
  for (let offset = 0; offset < 50000; offset += 1000) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await supabaseRequest(env, `${path}${sep}limit=1000&offset=${offset}`);
    if (!res.ok) return null;
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

const n = (v) => Number(v) || 0;

// GET /api/dashboard?year=2026&month=10
// Plan against actual for one month, a year-to-date line, and money in and out per account.
// Transfers are not income or expense, so they never enter the plan-versus-actual numbers.
export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await requireAuth(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const now = new Date(Date.now() + Number(env.TZ_OFFSET_HOURS ?? 8) * 3600 * 1000);
  const year = Number(url.searchParams.get("year")) || now.getUTCFullYear();
  const month = Number(url.searchParams.get("month")) || now.getUTCMonth() + 1;
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return json({ error: "year and month must be valid numbers" }, 400);
  }
  const [mStart, mEnd] = monthRange(year, month);

  const [cats, subs, budgets, ledger, transfers] = await Promise.all([
    fetchAll(env, "expense_categories?select=id,name,type"),
    fetchAll(env, "expense_subcategories?select=id,name,category_id"),
    fetchAll(env, `budgets?year=eq.${year}&select=category_id,subcategory_id,month,planned_amount`),
    fetchAll(env, `expense_ledger?expense_date=gte.${year}-01-01&expense_date=lte.${year}-12-31&select=expense_date,category_id,subcategory_id,account_id,amount`),
    fetchAll(env, `transfers?transfer_date=gte.${mStart}&transfer_date=lte.${mEnd}&select=from_account_id,to_account_id,amount_out,amount_in,fee_amount,fee_ledger_id`),
  ]);
  let accounts = await fetchAll(env, "payment_accounts?select=id,name,currency,account_type&order=sort_order.asc,name.asc");
  if (!accounts) accounts = await fetchAll(env, "payment_accounts?select=id,name&order=sort_order.asc,name.asc");
  if (!cats || !subs || !budgets || !ledger || !accounts) return json({ error: "could not load data" }, 502);

  const catById = new Map(cats.map((c) => [c.id, c]));
  const subById = new Map(subs.map((s) => [s.id, s]));
  const monthOf = (d) => Number(String(d).slice(5, 7));

  // Plan and actual, per month and per subcategory (expense side only; the plan table holds expenses).
  const planByMonth = Array(13).fill(0), actualExpByMonth = Array(13).fill(0);
  const planBySub = new Map(), actualBySub = new Map(), incomeByCat = new Map();
  for (const b of budgets) {
    const cat = catById.get(b.category_id);
    if (cat && cat.type === "income") continue;
    planByMonth[b.month] += n(b.planned_amount);
    if (b.month === month) planBySub.set(b.subcategory_id ?? `c${b.category_id}`, (planBySub.get(b.subcategory_id ?? `c${b.category_id}`) || 0) + n(b.planned_amount));
  }
  let firstActual = null;
  for (const r of ledger) {
    const m = monthOf(r.expense_date);
    const cat = catById.get(r.category_id);
    if (!firstActual || r.expense_date < firstActual) firstActual = r.expense_date;
    if (cat && cat.type === "income") {
      if (m === month) incomeByCat.set(r.category_id, (incomeByCat.get(r.category_id) || 0) + n(r.amount));
      continue;
    }
    actualExpByMonth[m] += n(r.amount);
    if (m === month) actualBySub.set(r.subcategory_id, (actualBySub.get(r.subcategory_id) || 0) + n(r.amount));
  }

  // Per expense category for the selected month, with its subcategories.
  const catRows = new Map();
  const subRows = [];
  const subIds = new Set([...planBySub.keys(), ...actualBySub.keys()]);
  for (const sid of subIds) {
    const plan = planBySub.get(sid) || 0, actual = actualBySub.get(sid) || 0;
    const s = subById.get(sid);
    if (!s) continue;
    const cat = catById.get(s.category_id);
    if (cat && cat.type === "income") continue;
    if (!catRows.has(s.category_id)) catRows.set(s.category_id, { id: s.category_id, name: cat?.name || "Other", plan: 0, actual: 0, variance: 0, subs: [] });
    const c = catRows.get(s.category_id);
    c.plan += plan; c.actual += actual; c.variance = c.actual - c.plan;
    c.subs.push({ id: sid, name: s.name, plan, actual, variance: actual - plan });
    subRows.push({ id: sid, name: s.name, category: cat?.name || "", plan, actual, variance: actual - plan });
  }
  const bySize = (a, b) => Math.max(b.plan, b.actual) - Math.max(a.plan, a.actual);
  const categories = [...catRows.values()].sort(bySize);
  for (const c of categories) c.subs.sort(bySize);
  const topVariances = subRows
    .filter((r) => r.variance !== 0)
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, 5)
    .map(({ name, category, plan, actual, variance }) => ({ name, category, plan, actual, variance }));
  const incomeActual = [...incomeByCat.values()].reduce((sum, v) => sum + v, 0);

  // Money in and out per account for the month.
  const accById = new Map(accounts.map((a) => [a.id, { name: a.name, currency: a.currency || "IDR", inflow: 0, outflow: 0 }]));
  let entriesInMonth = 0;
  for (const r of ledger) {
    if (monthOf(r.expense_date) !== month) continue;
    entriesInMonth++;
    const a = accById.get(r.account_id); if (!a) continue;
    if (catById.get(r.category_id)?.type === "income") a.inflow += n(r.amount); else a.outflow += n(r.amount);
  }
  for (const t of transfers || []) {
    const f = accById.get(t.from_account_id), to = accById.get(t.to_account_id);
    if (f) { f.outflow += n(t.amount_out); if (!t.fee_ledger_id) f.outflow += n(t.fee_amount); }
    if (to) to.inflow += n(t.amount_in);
  }
  const accountsOut = [...accById.values()].filter((a) => a.inflow || a.outflow).map((a) => ({ ...a, net: a.inflow - a.outflow }));

  // Year to date, cumulative. Actual stays null for months that have not happened yet.
  const shown = year < now.getUTCFullYear() ? 12 : year === now.getUTCFullYear() ? now.getUTCMonth() + 1 : 0;
  const ytd = [];
  let cp = 0, ca = 0;
  for (let m = 1; m <= 12; m++) {
    cp += planByMonth[m]; ca += actualExpByMonth[m];
    ytd.push({ month: m, plan: cp, actual: m <= shown ? ca : null });
  }

  const expensePlan = planByMonth[month], expenseActual = actualExpByMonth[month];
  return json({
    year, month,
    totals: { expense_plan: expensePlan, expense_actual: expenseActual, expense_variance: expenseActual - expensePlan, income_actual: incomeActual, net_actual: incomeActual - expenseActual },
    categories, top_variances: topVariances, ytd, accounts: accountsOut,
    meta: { entries_in_month: entriesInMonth, first_entry_date: firstActual, transfers_available: transfers !== null },
  });
}
