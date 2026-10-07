// Backend checks with a fake Supabase and a fake Telegram. Run: node test/backend.test.mjs
import crypto from "node:crypto";
import { onRequestPost as transfersPost } from "../functions/api/transfers.js";
import { onRequestPost as webhookPost } from "../functions/api/telegram-webhook.js";
import { onRequestGet as optionsGet } from "../functions/api/options.js";

const BOT = "123456:TESTTOKEN";
const env = { TELEGRAM_BOT_TOKEN: BOT, SUPABASE_URL: "http://sb", SUPABASE_SECRET_KEY: "k", NOTIFY_CHAT_ID: "-100", MINI_APP_LINK: "https://t.me/bot/app" };

function initData(userId = 7) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "Dheny" }) });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT).digest();
  p.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return p.toString();
}

let accounts, calls, sent, failLedger, ledgerFixture, transfersFixture, migrated;
function reset() {
  accounts = [
    { id: 1, name: "Jago", currency: "IDR", account_type: "spending", show_in_expense_form: true },
    { id: 2, name: "Stockbit", currency: "IDR", account_type: "investment", show_in_expense_form: false },
    { id: 3, name: "IBKR", currency: "USD", account_type: "investment", show_in_expense_form: false },
    { id: 4, name: "Livia_Duit_temporary", currency: "IDR", account_type: "liability", show_in_expense_form: true },
  ];
  calls = []; sent = []; failLedger = false; migrated = true;
  ledgerFixture = []; transfersFixture = [];
}
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, opts = {}) => {
  url = String(url); const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (url.startsWith("https://api.telegram.org")) { sent.push({ method: url.split("/").pop(), body }); return ok({ ok: true }); }
  const path = decodeURIComponent(url.replace("http://sb/rest/v1/", ""));
  calls.push({ method, path, body });
  if (path.startsWith("payment_accounts?id=in.")) {
    const ids = path.match(/in\.\(([\d,]+)\)/)[1].split(",").map(Number);
    return ok(accounts.filter((a) => ids.includes(a.id)));
  }
  if (path.startsWith("payment_accounts?select=id,name,currency,account_type&order")) return ok(accounts);
  if (path.startsWith("payment_accounts?select=id,name,currency,account_type,show_in_expense_form")) return migrated ? ok(accounts) : ok({ message: "column does not exist" }, 400);
  if (path.startsWith("payment_accounts?select=id,name&order")) return ok(accounts.map(({ id, name }) => ({ id, name })));
  if (path.startsWith("expense_subcategories?name=eq.Taxes & Fees")) return ok([{ id: 36, category_id: 15 }]);
  if (path.startsWith("rpc/next_txn_no")) return ok("26100099");
  if (method === "POST" && path === "expense_ledger") return failLedger ? ok({ message: "boom" }, 500) : ok([{ id: 500 }]);
  if (method === "POST" && path === "transfers") return ok([{ id: 1, txn_no: "T2610001", ...body }]);
  if (method === "PATCH" && path.startsWith("transfers?id=eq.")) return ok({});
  if (method === "DELETE") return ok({});
  if (path.startsWith("transfers?txn_no=eq.T2610001")) return ok([{ id: 1, txn_no: "T2610001", transfer_date: "2026-10-05", amount_out: 3000000 }]);
  if (path.startsWith("transfers?id=eq.1&select=id,fee_ledger_id")) return ok([{ id: 1, fee_ledger_id: 500 }]);
  if (path.startsWith("expense_categories?select=id,type")) return ok([{ id: 1, type: "income" }, { id: 15, type: "expense" }]);
  if (path.startsWith("expense_ledger?expense_date=gte")) return ok(ledgerFixture);
  if (path.startsWith("transfers?transfer_date=gte")) return ok(transfersFixture);
  if (path.startsWith("expense_categories?") || path.startsWith("expense_subcategories?") || path.startsWith("spenders?")) return ok([]);
  if (path.startsWith("tags?")) return ok([]);
  return ok({ message: "unexpected " + path }, 404);
};

const post = (handler, body, hdrs = { "X-Telegram-Init-Data": initData() }) =>
  handler({ request: new Request("http://x", { method: "POST", headers: hdrs, body: JSON.stringify(body) }), env });
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + extra)); };
const base = { transfer_date: "2026-10-05", transfer_time: "09:30", from_account_id: 1, to_account_id: 2, amount_out: 3000000 };

// a) IDR to IDR with fee
reset();
let r = await post(transfersPost, { ...base, fee_amount: 6500, description: "top up" });
check("a: 200 on IDR transfer with fee", r.status === 200);
const led = calls.find((c) => c.method === "POST" && c.path === "expense_ledger");
check("a: fee booked in Taxes & Fees on the source account", led && led.body.amount === 6500 && led.body.category_id === 15 && led.body.subcategory_id === 36 && led.body.account_id === 1);
check("a: transfer linked to the fee row", calls.some((c) => c.method === "PATCH" && c.body?.fee_ledger_id === 500));
check("a: amount_in equals amount_out for same currency", calls.find((c) => c.path === "transfers" && c.method === "POST").body.amount_in === 3000000);
check("a: group message names transfer number and fee booking", sent[0]?.body.text.includes("#T2610001") && sent[0].body.text.includes("booked as a Taxes &amp; Fees") === false && sent[0].body.text.includes("Taxes & Fees expense"));

// b) cross currency needs amount_in
reset(); r = await post(transfersPost, { ...base, to_account_id: 3 });
check("b: cross-currency without amount_in is rejected", r.status === 400);
// c) cross currency with amount_in
reset(); r = await post(transfersPost, { ...base, to_account_id: 3, amount_out: 1780000, amount_in: 100 });
check("c: cross-currency with amount_in saved", r.status === 200 && calls.find((c) => c.path === "transfers" && c.method === "POST").body.amount_in === 100);
check("c: message shows both currencies", sent[0].body.text.includes("USD 100.00") && sent[0].body.text.includes("Rp 1.780.000"));
// d) USD source with fee: no ledger row
reset(); r = await post(transfersPost, { ...base, from_account_id: 3, to_account_id: 1, amount_out: 100, amount_in: 1780000, fee_amount: 2.5 });
check("d: USD-source fee is not booked in the IDR ledger", r.status === 200 && !calls.some((c) => c.path === "expense_ledger"));
// e) validations
reset(); check("e: same account rejected", (await post(transfersPost, { ...base, to_account_id: 1 })).status === 400);
reset(); check("e: negative fee rejected", (await post(transfersPost, { ...base, fee_amount: -1 })).status === 400);
reset(); check("e: zero amount rejected", (await post(transfersPost, { ...base, amount_out: 0 })).status === 400);
reset(); check("e: unknown account rejected", (await post(transfersPost, { ...base, to_account_id: 99 })).status === 400);
reset(); check("e: bad date rejected", (await post(transfersPost, { ...base, transfer_date: "05/10/2026" })).status === 400);
reset(); check("e: missing auth rejected", (await post(transfersPost, base, {})).status === 401);
// f) rollback when the fee cannot be booked
reset(); failLedger = true; r = await post(transfersPost, { ...base, fee_amount: 6500 });
check("f: fee failure returns 502 and deletes the transfer", r.status === 502 && calls.some((c) => c.method === "DELETE" && c.path === "transfers?id=eq.1"));

// g) webhook: undo a transfer
const hook = (update) => webhookPost({ request: new Request("http://x", { method: "POST", body: JSON.stringify(update) }), env });
reset(); await hook({ message: { chat: { id: 5 }, text: "/undo T2610001" } });
check("g: /undo T2610001 asks for confirmation", sent[0]?.body.text.includes("Delete transfer #T2610001") && sent[0].body.reply_markup.inline_keyboard[0][0].callback_data === "undo_t_confirm_1");
reset(); await hook({ callback_query: { id: "q", data: "undo_t_confirm_1", message: { chat: { id: 5 } } } });
check("g: confirming deletes the fee expense first, then the transfer", calls.filter((c) => c.method === "DELETE").map((c) => c.path).join("|") === "expense_ledger?id=eq.500|transfers?id=eq.1");
reset(); await hook({ message: { chat: { id: 5 }, text: "/transfer" } });
check("g: /transfer opens the Mini App in transfer mode", sent[0]?.body.reply_markup.inline_keyboard[0][0].url === "https://t.me/bot/app?startapp=transfer");

// h) account movement report
reset();
ledgerFixture = [
  { account_id: 1, amount: 10000000, category_id: 1 },   // income on Jago
  { account_id: 1, amount: 2000000, category_id: 15 },   // expense on Jago
  { account_id: 1, amount: 6500, category_id: 15 },      // fee booked as expense
  { account_id: 4, amount: 500000, category_id: 15 },    // expense covered by Livia
];
transfersFixture = [
  { from_account_id: 1, to_account_id: 2, amount_out: 3000000, amount_in: 3000000, fee_amount: 6500, fee_ledger_id: 77 },
  { from_account_id: 1, to_account_id: 3, amount_out: 1780000, amount_in: 100, fee_amount: 0, fee_ledger_id: null },
  { from_account_id: 1, to_account_id: 4, amount_out: 500000, amount_in: 500000, fee_amount: 0, fee_ledger_id: null },
];
await hook({ message: { chat: { id: 5 }, text: "/accounts" } });
const t = sent[0].body.text;
check("h: Jago net = 10.000.000 - (2.000.000 + 6.500 + 3.000.000 + 1.780.000 + 500.000) = 2.713.500", t.includes("Jago: in Rp 10.000.000, out Rp 7.286.500, net Rp 2.713.500"), t);
check("h: Stockbit shows money in only", t.includes("Stockbit: in Rp 3.000.000, out Rp 0, net Rp 3.000.000"), t);
check("h: IBKR shows USD", t.includes("IBKR: in USD 100.00, out USD 0.00, net USD 100.00"), t);
check("h: Livia liability nets to zero after reimbursement", t.includes("Livia_Duit_temporary: in Rp 500.000, out Rp 500.000, owed Rp 0"), t);
check("h: note that investment accounts show flows, not market value", t.includes("not market value"));

// i) options: before and after the migration
reset(); let o = await (await optionsGet({ request: new Request("http://x", { headers: { "X-Telegram-Init-Data": initData() } }), env })).json();
check("i: options expose transfers_enabled and account fields", o.transfers_enabled === true && o.accounts[2].currency === "USD");
reset(); migrated = false; o = await (await optionsGet({ request: new Request("http://x", { headers: { "X-Telegram-Init-Data": initData() } }), env })).json();
check("i: before the migration options still load and transfers stay off", o.transfers_enabled === false && o.accounts.length === 4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
