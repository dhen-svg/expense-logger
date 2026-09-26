-- Expense Logger — Supabase schema
-- Run this whole file in Supabase → SQL Editor → New query

create table if not exists expense_categories (
  id serial primary key,
  name text not null unique
);

create table if not exists expense_subcategories (
  id serial primary key,
  category_id int not null references expense_categories(id) on delete cascade,
  name text not null
);

create table if not exists payment_accounts (
  id serial primary key,
  name text not null unique
);

create table if not exists expense_ledger (
  id bigserial primary key,
  expense_date date not null,
  category_id int not null references expense_categories(id),
  subcategory_id int not null references expense_subcategories(id),
  account_id int not null references payment_accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  description text,
  telegram_user_id bigint,
  source text not null default 'telegram',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Defense in depth: enable RLS with no policies at all.
-- Only requests using the SUPABASE_SECRET_KEY (server-side, in Cloudflare Functions)
-- bypass RLS and can read/write these tables. Anyone using the public anon key,
-- or hitting Supabase directly, gets nothing.
alter table expense_categories enable row level security;
alter table expense_subcategories enable row level security;
alter table payment_accounts enable row level security;
alter table expense_ledger enable row level security;

-- Starter data — edit freely in Supabase → Table Editor any time.
insert into expense_categories (name) values
  ('Food'), ('Transport'), ('Bills'), ('Health'), ('Shopping'), ('Entertainment'), ('Other')
on conflict (name) do nothing;

insert into expense_subcategories (category_id, name)
select c.id, s.name from expense_categories c
join (values
  ('Food','Dining'), ('Food','Groceries'),
  ('Transport','Fuel'), ('Transport','Parking'), ('Transport','Ride-hailing'),
  ('Bills','Electricity'), ('Bills','Water'), ('Bills','Internet'), ('Bills','Phone'),
  ('Health','Medical'), ('Health','Pharmacy'),
  ('Shopping','Household'), ('Shopping','Personal'),
  ('Entertainment','Recreation'),
  ('Other','Miscellaneous')
) as s(cat, name) on s.cat = c.name
where not exists (
  select 1 from expense_subcategories es where es.category_id = c.id and es.name = s.name
);

insert into payment_accounts (name) values
  ('Cash'), ('Bank Jago Syariah'), ('GoPay'), ('OVO')
on conflict (name) do nothing;
