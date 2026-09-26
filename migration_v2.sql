-- Migration v2 — run this whole file in Supabase → SQL Editor → New query
-- WARNING: this clears out expense_ledger and the old placeholder
-- categories/subcategories/accounts. If you care about the test row(s)
-- you already logged, note them down before running this.

delete from expense_ledger;
delete from expense_subcategories;
delete from expense_categories;
delete from payment_accounts;

-- 1. Categories now carry a type (income/expense)
alter table expense_categories
  add column if not exists type text not null default 'expense'
  check (type in ('income', 'expense'));

-- 2. New: who the transaction is attributed to
create table if not exists spenders (
  id serial primary key,
  name text not null unique
);
alter table spenders enable row level security;

insert into spenders (name) values ('Dheny'), ('Partner'), ('Shared')
on conflict (name) do nothing;

-- 3. New: reusable tags
create table if not exists tags (
  id serial primary key,
  name text not null unique
);
alter table tags enable row level security;

-- 4. New columns on the ledger
alter table expense_ledger add column if not exists expense_time time not null default '12:00:00';
alter table expense_ledger add column if not exists used_by_id int references spenders(id);
alter table expense_ledger add column if not exists tags text[] not null default '{}';

-- 5. Real categories + subcategories
insert into expense_categories (name, type) values
  ('Active Income', 'income'),
  ('Capital', 'income'),
  ('Debt Repayment', 'income'),
  ('Other Income', 'income'),
  ('Yield Income', 'income'),
  ('Entertainment & Lifestyle', 'expense'),
  ('Family & Social', 'expense'),
  ('Financial Obligations', 'expense'),
  ('Gadget & Connectivity', 'expense'),
  ('Giving', 'expense'),
  ('Health & Wellness', 'expense'),
  ('Household', 'expense'),
  ('Meals', 'expense'),
  ('Mobility', 'expense'),
  ('Others', 'expense'),
  ('Personal Care', 'expense'),
  ('Self Development', 'expense')
on conflict (name) do nothing;

insert into expense_subcategories (category_id, name)
select c.id, s.name from expense_categories c
join (values
  ('Active Income','Business Income'),
  ('Active Income','Routine Base Pay'),
  ('Active Income','Side Income'),
  ('Active Income','Variable Pay'),
  ('Capital','Asset Sale'),
  ('Debt Repayment','Debt Repayment'),
  ('Other Income','Cashback'),
  ('Other Income','Gift/Hibah'),
  ('Yield Income','Asset Rental'),
  ('Yield Income','Coupon'),
  ('Yield Income','Crypto Gains-on-Sale'),
  ('Yield Income','Dividend'),
  ('Entertainment & Lifestyle','Entertainment'),
  ('Entertainment & Lifestyle','Hobbies & Recreation'),
  ('Entertainment & Lifestyle','Memberships'),
  ('Family & Social','Family'),
  ('Family & Social','Social & Gifts'),
  ('Financial Obligations','Debt & Financing'),
  ('Financial Obligations','Insurance'),
  ('Financial Obligations','Investment Costs'),
  ('Financial Obligations','Taxes & Fees'),
  ('Gadget & Connectivity','Connectivity'),
  ('Gadget & Connectivity','Devices & Equipment'),
  ('Gadget & Connectivity','Digital Services'),
  ('Giving','Giving & Social'),
  ('Giving','Religious Giving'),
  ('Health & Wellness','Fitness & Wellness'),
  ('Health & Wellness','Medical & Healthcare'),
  ('Household','Household Consumption'),
  ('Household','Household Goods'),
  ('Household','Household Services'),
  ('Household','Housing'),
  ('Household','Maintenance & Improvement'),
  ('Household','Utilities & Bills'),
  ('Meals','Dining & Meals'),
  ('Meals','Groceries'),
  ('Mobility','Daily Transportation'),
  ('Mobility','Travel'),
  ('Mobility','Vehicle'),
  ('Others','Major One-Time Events'),
  ('Personal Care','Personal Goods'),
  ('Self Development','Learning & Education'),
  ('Self Development','Professional Development')
) as s(cat, name) on s.cat = c.name;

-- 6. Real payment accounts
insert into payment_accounts (name) values
  ('Jago'), ('Cash'), ('Gopay'), ('Bank BSI Mudharabah'), ('Bank DBS - Digibank'), ('Shopeepay')
on conflict (name) do nothing;
