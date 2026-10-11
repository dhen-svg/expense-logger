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
const pad = (v) => String(v).padStart(2, "0");

// GET /api/dashboard?year=2026&month=10&period=month|year
// Real figures first (today, this month, this year), then composition and trend for the chosen
// period, then plan against actual. Transfers are not income or expense, and loan repayments
// received (category "Debt Repayment") are kept out of income.
export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await requireAuth(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const now = new Date(Date.now() + Number(env.TZ_OFFSET_HOURS ?? 8) * 3600 * 1000);
  const nowY = now.getUTCFullYear(), nowM = now.getUTCMonth() + 1, nowD = now.getUTCDate();
  const todayStr = `${nowY}-${pad(nowM)}-${pad(nowD)}`;
  const year = Number(url.searchParams.get("year")) || nowY;
  const month = Number(url.searchParams.get("month")) || nowM;
  const period = url.searchParams.get("period") === "year" ? "year" : "month";
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return json({ error: "year and month must be valid numbers" }, 400);
  }
  const [mStart, mEnd] = monthRange(year, month);
  const ledgerPath = (y) => `expense_ledger?expense_date=gte.${y}-01-01&expense_date=lte.${y}-12-31&select=expense_date,category_id,subcategory_id,account_id,amount`;

  const [cats, subs, budgets, ledger, transfers] = await Promise.all([
    fetchAll(env, "expense_categories?select=id,name,type"),
    fetchAll(env, "expense_subcategories?select=id,name,category_id"),
    fetchAll(env, `budgets?year=eq.${year}&select=category_id,subcategory_id,month,planned_amount`),
    fetchAll(env, ledgerPath(year)),
    fetchAll(env, `transfers?transfer_date=gte.${mStart}&transfer_date=lte.${mEnd}&select=from_account_id,to_account_id,amount_out,amount_in,fee_amount,fee_ledger_id`),
  ]);
  let accounts = await fetchAll(env, "payment_accounts?select=id,name,currency,account_type&order=sort_order.asc,name.asc");
  if (!accounts) accounts = await fetchAll(env, "payment_accounts?select=id,name&order=sort_order.asc,name.asc");
  if (!cats || !subs || !budgets || !ledger || !accounts) return json({ error: "could not load data" }, 502);
  // Optional: the income plan. If the table does not exist yet, the Budget view simply has no income plan.
  const incomePlan = await fetchAll(env, `income_plan?year=eq.${year}&select=category_id,subcategory_id,month,planned_amount`);
  // "Right now" always means the current year, whatever month is being explored.
  const ledgerNow = year === nowY ? ledger : await fetchAll(env, ledgerPath(nowY));
  if (!ledgerNow) return json({ error: "could not load data" }, 502);

  const catById = new Map(cats.map((c) => [c.id, c]));
  const subById = new Map(subs.map((s) => [s.id, s]));
  const monthOf = (d) => Number(String(d).slice(5, 7));
  const kindOf = (r) => {
    const c = catById.get(r.category_id);
    if (!c || c.type !== "income") return "expense";
    return c.name === "Debt Repayment" ? "repay" : "income";
  };

  // ---- Right now: today, this month, this year to date
  const zero = () => ({ income: 0, expense: 0 });
  const nowBlock = { date: todayStr, today: zero(), month: zero(), year: zero(), repay_year: 0 };
  for (const r of ledgerNow) {
    const k = kindOf(r), amt = n(r.amount);
    if (k === "repay") { nowBlock.repay_year += amt; continue; }
    nowBlock.year[k] += amt;
    if (monthOf(r.expense_date) === nowM) nowBlock.month[k] += amt;
    if (r.expense_date === todayStr) nowBlock.today[k] += amt;
  }

  // ---- Composition for the chosen period (month, or year to date through the chosen month)
  const inPeriod = (r) => (period === "month" ? monthOf(r.expense_date) === month : monthOf(r.expense_date) <= month);
  const compExp = new Map(), compInc = new Map();
  for (const r of ledger) {
    if (!inPeriod(r)) continue;
    const k = kindOf(r);
    if (k === "repay") continue;
    const target = k === "income" ? compInc : compExp;
    target.set(r.category_id, (target.get(r.category_id) || 0) + n(r.amount));
  }
  const toList = (m) => [...m.entries()].map(([id, amount]) => ({ name: catById.get(id)?.name || "Other", amount })).sort((a, b) => b.amount - a.amount);
  const composition = {
    period,
    label: period === "month" ? `${year}-${pad(month)}` : `${year}-01 to ${year}-${pad(month)}`,
    expense: toList(compExp),
    income: toList(compInc),
  };

  // ---- Trend: income and expense per month of the chosen year
  const trend = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: 0, expense: 0 }));
  for (const r of ledger) {
    const k = kindOf(r);
    if (k === "repay") continue;
    trend[monthOf(r.expense_date) - 1][k] += n(r.amount);
  }

  // ---- Plan against actual for the chosen period (expenses from budgets, income from income_plan)
  const inP = (m) => (period === "month" ? m === month : m <= month);
  const planByMonth = Array(13).fill(0), actualExpByMonth = Array(13).fill(0);
  const planBySub = new Map(), actualBySub = new Map(), incPlanCat = new Map(), incActCat = new Map();
  let incomeActual = 0, firstActual = null, entriesInMonth = 0;
  for (const b of budgets) {
    const cat = catById.get(b.category_id);
    if (cat && cat.type === "income") continue;
    planByMonth[b.month] += n(b.planned_amount);
    if (inP(b.month)) { const key = b.subcategory_id ?? `c${b.category_id}`; planBySub.set(key, (planBySub.get(key) || 0) + n(b.planned_amount)); }
  }
  if (incomePlan) {
    for (const b of incomePlan) {
      const cat = catById.get(b.category_id);
      if (!inP(b.month) || !cat || cat.name === "Debt Repayment") continue;
      incPlanCat.set(b.category_id, (incPlanCat.get(b.category_id) || 0) + n(b.planned_amount));
    }
  }
  for (const r of ledger) {
    const m = monthOf(r.expense_date);
    if (!firstActual || r.expense_date < firstActual) firstActual = r.expense_date;
    if (m === month) entriesInMonth++;
    const k = kindOf(r);
    if (k === "repay") continue;
    if (k === "income") {
      if (inP(m)) { incomeActual += n(r.amount); incActCat.set(r.category_id, (incActCat.get(r.category_id) || 0) + n(r.amount)); }
      continue;
    }
    actualExpByMonth[m] += n(r.amount);
    if (inP(m)) actualBySub.set(r.subcategory_id, (actualBySub.get(r.subcategory_id) || 0) + n(r.amount));
  }

  const catRows = new Map();
  const subRows = [];
  for (const sid of new Set([...planBySub.keys(), ...actualBySub.keys()])) {
    const plan = planBySub.get(sid) || 0, actual = actualBySub.get(sid) || 0;
    const s = subById.get(sid);
    if (!s) continue;
    const cat = catById.get(s.category_id);
    if (cat && cat.type === "income") continue;
    if (!catRows.has(s.category_id)) catRows.set(s.category_id, { id: s.category_id, name: cat?.name || "Other", plan: 0, actual: 0, variance: 0, subs: [] });
    const c = catRows.get(s.category_id);
    c.plan += plan; c.actual += actual; c.variance = c.actual - c.plan;
    c.subs.push({ id: sid, name: s.name, plan, actual, variance: actual - plan });
    subRows.push({ name: s.name, category: cat?.name || "", plan, actual, variance: actual - plan });
  }
  const bySize = (a, b) => Math.max(b.plan, b.actual) - Math.max(a.plan, a.actual);
  const categories = [...catRows.values()].sort(bySize);
  for (const c of categories) c.subs.sort(bySize);
  const topVariances = subRows.filter((r) => r.variance !== 0).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance)).slice(0, 5);

  // ---- Money in and out per account for the chosen month
  const accById = new Map(accounts.map((a) => [a.id, { name: a.name, currency: a.currency || "IDR", inflow: 0, outflow: 0 }]));
  for (const r of ledger) {
    if (monthOf(r.expense_date) !== month) continue;
    const a = accById.get(r.account_id); if (!a) continue;
    if (catById.get(r.category_id)?.type === "income") a.inflow += n(r.amount); else a.outflow += n(r.amount);
  }
  for (const t of transfers || []) {
    const f = accById.get(t.from_account_id), to = accById.get(t.to_account_id);
    if (f) { f.outflow += n(t.amount_out); if (!t.fee_ledger_id) f.outflow += n(t.fee_amount); }
    if (to) to.inflow += n(t.amount_in);
  }
  const accountsOut = [...accById.values()].filter((a) => a.inflow || a.outflow).map((a) => ({ ...a, net: a.inflow - a.outflow }));

  // ---- Plan year to date, cumulative; actual stays null for months that have not happened yet
  const shown = year < nowY ? 12 : year === nowY ? nowM : 0;
  const ytd = [];
  let cp = 0, ca = 0;
  for (let m = 1; m <= 12; m++) {
    cp += planByMonth[m]; ca += actualExpByMonth[m];
    ytd.push({ month: m, plan: cp, actual: m <= shown ? ca : null });
  }

  let expensePlan = 0, expenseActual = 0;
  for (let m = 1; m <= 12; m++) if (inP(m)) { expensePlan += planByMonth[m]; expenseActual += actualExpByMonth[m]; }
  let incomeBudget = null;
  if (incomePlan) {
    const ids = new Set([...incPlanCat.keys(), ...incActCat.keys()]);
    const catsOut = [...ids].map((id) => ({ name: catById.get(id)?.name || "Income", plan: incPlanCat.get(id) || 0, actual: incActCat.get(id) || 0 }))
      .map((c) => ({ ...c, variance: c.actual - c.plan })).sort((a, b) => Math.max(b.plan, b.actual) - Math.max(a.plan, a.actual));
    const planTotal = catsOut.reduce((sum, c) => sum + c.plan, 0);
    incomeBudget = { plan: planTotal, actual: incomeActual, variance: incomeActual - planTotal, categories: catsOut };
  }
  return json({
    year, month, period,
    now: nowBlock,
    composition, trend,
    totals: { expense_plan: expensePlan, expense_actual: expenseActual, expense_variance: expenseActual - expensePlan, income_actual: incomeActual, net_actual: incomeActual - expenseActual },
    categories, top_variances: topVariances, income_budget: incomeBudget, ytd, accounts: accountsOut,
    meta: { entries_in_month: entriesInMonth, first_entry_date: firstActual, transfers_available: transfers !== null },
  });
}
