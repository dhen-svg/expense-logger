# Transfers update: deploy and check

## 1. Database (once, before deploying the code)
Supabase, SQL Editor, New query: paste all of `migration_v3_transfers.sql` and run it.
It adds currency, account_type and show_in_expense_form to payment_accounts, creates the transfers table
(numbers look like T2610001), and adds Stockbit, KBVS-ARA, Bibit, IBKR, Binance and DBS USD Account.
Edit the account list at the bottom of the file first if it is not what you want.

## 2. Code
Replace these files in the repo, then let Cloudflare Pages redeploy:
- `index.html` (changed)
- `functions/api/transfers.js` (new)
- `functions/api/options.js`, `functions/api/telegram-webhook.js`, `functions/api/_utils.js` (changed)
`expenses.js` and `digest.js` are unchanged. The nested `expense-logger-v3` folder is not used and can be deleted.

## 3. Telegram commands (optional, BotFather > /setcommands)
transfer - Log a transfer between accounts
accounts - Money in and out per account this month

## 4. Check it works
1. Open the Mini App: a Transaction / Transfer switch appears at the top. `/transfer` opens the form in transfer mode.
2. Log a transfer Jago to Stockbit, amount 100000, fee 6500. The group gets "TRANSFER LOGGED #T26MM001".
3. Supabase: `select * from transfers;` shows the row. `select * from expense_ledger order by id desc limit 1;` shows the 6.500 fee under Taxes & Fees.
4. `/accounts` shows Jago out and Stockbit in. `/summary` expense totals include only the fee, not the 100000.
5. `/undo T26MM001` then confirm: the transfer and its fee expense are both deleted.

## Rules built in
- A transfer is never income or expense. Budgets, alerts and /summary ignore it.
- The fee is booked as a Taxes & Fees expense on the source account when that account is in IDR, and is stored once.
- Different currencies need both amounts (sent and received).
- Investment accounts show money in and out only. Market value stays in the asset registry.

## Not included yet
- No budget alert when a fee pushes Taxes & Fees over its budget (the fee still counts in totals).
- The weekly and monthly digest does not include account movement yet.
- A fee on a USD source account stays on the transfer only, because the expense ledger is IDR.
- No editing of a transfer: delete it with /undo and enter it again.
- `/undo` with no number still deletes only the latest expense, never a transfer.

## Tests (run locally, they use a fake database)
`node test/backend.test.mjs` and `python3 test/ui.test.py`
