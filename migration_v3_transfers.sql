-- Migration v3: transfers between accounts
-- Run this whole file once in Supabase, SQL Editor, New query.
-- Run it BEFORE deploying the new code: the new code reads columns created here.

-- A. Account metadata. The expense form shows only accounts with show_in_expense_form = true.
alter table payment_accounts add column if not exists currency text not null default 'IDR';
alter table payment_accounts add column if not exists account_type text not null default 'spending';
alter table payment_accounts add column if not exists show_in_expense_form boolean not null default true;

-- B. Transfers. Safe to drop first because the table has never held real data.
drop table if exists transfers;

create table transfers (
  id bigserial primary key,
  txn_no text unique,
  transfer_date date not null,
  transfer_time time not null default '12:00:00',
  from_account_id integer not null references payment_accounts(id),
  to_account_id integer not null references payment_accounts(id),
  amount_out numeric(18,2) not null check (amount_out > 0),
  amount_in numeric(18,2) not null check (amount_in > 0),
  fee_amount numeric(14,2) not null default 0 check (fee_amount >= 0),
  -- The fee is also stored as a normal Taxes & Fees expense so every existing
  -- report, budget and alert includes it. Deleting the transfer deletes that row in the app.
  fee_ledger_id bigint references expense_ledger(id) on delete set null,
  description text,
  telegram_user_id bigint,
  created_at timestamptz not null default now(),
  check (from_account_id <> to_account_id)
);
alter table transfers enable row level security;

-- Transfer numbers look like T2610001: T, year and month, then a 3-digit sequence per month.
create or replace function set_transfer_txn_no() returns trigger language plpgsql as $$
begin
  if new.txn_no is null then
    select 'T' || to_char(new.transfer_date, 'YYMM')
           || lpad((coalesce(max(substr(txn_no, 6)::int), 0) + 1)::text, 3, '0')
      into new.txn_no
      from transfers
     where txn_no like 'T' || to_char(new.transfer_date, 'YYMM') || '%';
  end if;
  return new;
end $$;

create trigger transfers_txn_no before insert on transfers
  for each row execute function set_transfer_txn_no();

-- C. Accounts. Edit this list before running if it is not what you want.
insert into payment_accounts (name, sort_order, currency, account_type, show_in_expense_form)
select v.name, m.mx + v.n, v.cur, v.typ, false
from (values
  ('Stockbit',        1, 'IDR', 'investment'),
  ('KBVS-ARA',        2, 'IDR', 'investment'),
  ('Bibit',           3, 'IDR', 'investment'),
  ('IBKR',            4, 'USD', 'investment'),
  ('Binance',         5, 'USD', 'investment'),
  ('DBS USD Account', 6, 'USD', 'savings')
) as v(name, n, cur, typ),
(select coalesce(max(sort_order), 0) as mx from payment_accounts) m
where not exists (select 1 from payment_accounts p where p.name = v.name);

update payment_accounts set account_type = 'liability' where name = 'Livia_Duit_temporary';
