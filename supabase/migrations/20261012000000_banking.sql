-- Panalo Accounts, Phase 6: banking.
--
-- * Bank statement imports (CSV, OFX, QIF, parsed in the browser and checked
--   here): one row per statement line, with duplicates across overlapping
--   files skipped. An import can be undone until any of its lines is used.
-- * Matching: a statement line is matched to the ledger lines on that bank
--   account that it pays (receipts, supplier payments, pay runs, super,
--   journals), or a new entry is created from it ("spend or receive money",
--   a receipt against invoices, a payment of bills, a pay run payment).
--   Each ledger line matches one statement line at most.
-- * Bank rules suggest the account and tax code for repeating lines; a
--   person still accepts each suggestion.
-- * Reconciliation: at a statement date every statement line is matched or
--   excluded, and the statement balance equals the ledger balance less
--   unpresented items. Completed reconciliations lock their lines; the
--   latest one can be undone with a reason.
-- * Payment batches: approved bills paid by an ABA bank file. A second
--   person approves the batch before the file can be downloaded; supplier
--   bank details are fixed when the batch is made and checked again then.
-- * Company bank accounts get a link to their ledger account and ABA
--   settings (bank code, user name, balancing record).
--
-- Matched or reconciled ledger lines can't be reversed: unmatch first.

begin;

------------------------------------------------------------------------------
-- 1. Company bank accounts: ledger link and ABA settings
------------------------------------------------------------------------------

alter table public.company_bank_accounts
  add column ledger_account_id uuid references public.accounts(id) on delete restrict,
  add column aba_bank_code text check (aba_bank_code is null or aba_bank_code ~ '^[A-Z]{3}$'),
  add column aba_user_name text check (aba_user_name is null or length(aba_user_name) between 1 and 26),
  add column aba_balancing_record boolean not null default false;
create unique index company_bank_ledger_link on public.company_bank_accounts (ledger_account_id)
  where ledger_account_id is not null and status in ('pending', 'active');

alter table public.number_sequences drop constraint number_sequences_kind_check;
alter table public.number_sequences add constraint number_sequences_kind_check
  check (kind in ('invoice', 'quote', 'purchase_order', 'credit_note', 'bill', 'journal', 'pay_run', 'project', 'payment_batch'));
insert into public.number_sequences (organization_id, kind, prefix, next_number, padding)
select id, 'payment_batch', 'PB-', 1, 4 from public.organizations on conflict do nothing;

------------------------------------------------------------------------------
-- 2. Tables
------------------------------------------------------------------------------

create table public.bank_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  account_id uuid not null references public.accounts(id) on delete restrict,
  file_name text not null check (length(file_name) between 1 and 200),
  format text not null check (format in ('csv', 'ofx', 'qif')),
  rows_in_file integer not null default 0,
  rows_added integer not null default 0,
  first_date date,
  last_date date,
  statement_balance numeric(14,2),
  statement_balance_date date,
  imported_by uuid references public.training_profiles(id) on delete set null,
  imported_at timestamptz not null default now(),
  undone_by uuid references public.training_profiles(id) on delete set null,
  undone_at timestamptz
);
create index bank_imports_account_idx on public.bank_imports (account_id, imported_at desc);

create table public.bank_reconciliations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  account_id uuid not null references public.accounts(id) on delete restrict,
  statement_date date not null,
  statement_balance numeric(14,2) not null,
  ledger_balance numeric(14,2) not null,
  unpresented numeric(14,2) not null,
  recorded_early numeric(14,2) not null default 0,
  cleared_before date,
  status text not null default 'completed' check (status in ('completed', 'undone')),
  notes text not null default '' check (length(notes) <= 1000),
  completed_by uuid references public.training_profiles(id) on delete set null,
  completed_at timestamptz not null default now(),
  undone_by uuid references public.training_profiles(id) on delete set null,
  undone_at timestamptz,
  undo_reason text
);
create index bank_reconciliations_account_idx on public.bank_reconciliations (account_id, status, statement_date desc);

create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  account_id uuid not null references public.accounts(id) on delete restrict,
  import_id uuid not null references public.bank_imports(id) on delete cascade,
  txn_date date not null,
  description text not null check (length(description) between 1 and 300),
  reference text not null default '' check (length(reference) <= 120),
  amount numeric(14,2) not null check (amount <> 0),
  balance numeric(14,2),
  external_id text check (external_id is null or length(external_id) <= 120),
  dedupe_key text not null,
  status text not null default 'new' check (status in ('new', 'matched', 'excluded')),
  match_kind text check (match_kind in ('existing', 'created')),
  matched_by uuid references public.training_profiles(id) on delete set null,
  matched_at timestamptz,
  excluded_reason text,
  reconciliation_id uuid references public.bank_reconciliations(id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((status = 'excluded') = (excluded_reason is not null)),
  check ((status = 'matched') = (match_kind is not null))
);
create unique index bank_transactions_dedupe_idx on public.bank_transactions (account_id, dedupe_key);
create index bank_transactions_account_idx on public.bank_transactions (account_id, status, txn_date);

-- Which ledger lines a statement line pays. A ledger line is matched once.
create table public.bank_matches (
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  journal_line_id uuid not null unique references public.journal_lines(id) on delete restrict,
  primary key (bank_transaction_id, journal_line_id)
);

-- Ledger lines treated as already through the bank when reconciling starts
-- (entries from before the first imported statement).
create table public.bank_cleared_lines (
  journal_line_id uuid primary key references public.journal_lines(id) on delete restrict,
  reconciliation_id uuid not null references public.bank_reconciliations(id) on delete cascade
);

create table public.bank_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name text not null check (length(btrim(name)) between 2 and 80),
  bank_account_id uuid references public.accounts(id) on delete cascade,
  direction text not null default 'any' check (direction in ('in', 'out', 'any')),
  match_text text not null check (length(btrim(match_text)) between 2 and 100),
  amount_min numeric(14,2) check (amount_min is null or amount_min >= 0),
  amount_max numeric(14,2) check (amount_max is null or amount_max >= 0),
  target_account_id uuid not null references public.accounts(id) on delete restrict,
  tax_code_id uuid references public.tax_codes(id) on delete restrict,
  payee text not null default '' check (length(payee) <= 120),
  priority integer not null default 100 check (priority between 1 and 9999),
  active boolean not null default true,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (amount_min is null or amount_max is null or amount_max >= amount_min)
);
create index bank_rules_org_idx on public.bank_rules (organization_id, active, priority);

create table public.payment_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  number text not null,
  source_bank_id uuid not null references public.company_bank_accounts(id) on delete restrict,
  payment_date date not null,
  description text not null default 'SUPPLIERS' check (description ~ '^[A-Za-z0-9 &./-]{1,12}$'),
  status text not null default 'draft' check (status in ('draft', 'approved', 'paid', 'cancelled')),
  total numeric(14,2) not null default 0,
  item_count integer not null default 0,
  created_by uuid references public.training_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  approved_by uuid references public.training_profiles(id) on delete set null,
  approved_at timestamptz,
  file_downloaded_at timestamptz,
  file_downloaded_by uuid references public.training_profiles(id) on delete set null,
  paid_by uuid references public.training_profiles(id) on delete set null,
  paid_at timestamptz,
  cancelled_by uuid references public.training_profiles(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  unique (organization_id, number)
);

create table public.payment_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.payment_batches(id) on delete cascade,
  bill_id uuid not null references public.bills(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  account_name text not null,
  bsb text not null check (bsb ~ '^\d{6}$'),
  account_number text not null check (account_number ~ '^\d{5,9}$'),
  lodgement_ref text not null check (length(lodgement_ref) between 1 and 18),
  supplier_payment_id uuid references public.supplier_payments(id) on delete restrict,
  unique (batch_id, bill_id)
);
create index payment_batch_items_bill_idx on public.payment_batch_items (bill_id);

------------------------------------------------------------------------------
-- 3. Guards
------------------------------------------------------------------------------

-- A journal whose bank lines are matched to the statement, or cleared when
-- reconciling started, can't be reversed: the money really moved.
create or replace function public.bank_reversal_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'posted' and new.status = 'reversed' and exists (
    select 1 from public.journal_lines jl
    where jl.journal_id = old.id
      and (exists (select 1 from public.bank_matches m where m.journal_line_id = jl.id)
           or exists (select 1 from public.bank_cleared_lines c where c.journal_line_id = jl.id))) then
    raise exception 'This entry is matched to a bank statement line. Unmatch it in Reconciliation first, or record a refund instead.' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger journal_entries_bank_reversal before update on public.journal_entries
  for each row execute function public.bank_reversal_guard();

------------------------------------------------------------------------------
-- 4. Ledger lines on a bank account, and the reconciliation sums
------------------------------------------------------------------------------

-- Ledger lines on a bank account up to a date, with whether each has been
-- through the bank by then. Lines of a reversed entry and its reversal both
-- dated by then cancel out and are left out.
create or replace function public.bank_ledger_lines(p_account uuid, p_as_at date)
returns table (journal_line_id uuid, journal_id uuid, number text, entry_date date, memo text, source_type text, source_id uuid,
  description text, amount numeric, cleared boolean, matched_txn uuid, matched_txn_date date)
language sql
stable
security definer
set search_path = ''
as $$
  select jl.id, je.id, je.number, je.entry_date, je.memo, je.source_type, je.source_id, jl.description, jl.debit - jl.credit,
    (exists (select 1 from public.bank_cleared_lines c where c.journal_line_id = jl.id)
      or exists (select 1 from public.bank_matches m join public.bank_transactions t on t.id = m.bank_transaction_id
                 where m.journal_line_id = jl.id and t.txn_date <= p_as_at)),
    (select m.bank_transaction_id from public.bank_matches m where m.journal_line_id = jl.id),
    (select t.txn_date from public.bank_matches m join public.bank_transactions t on t.id = m.bank_transaction_id where m.journal_line_id = jl.id)
  from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_id
  where jl.account_id = p_account and je.status in ('posted', 'reversed') and je.entry_date <= p_as_at
    and not (je.status = 'reversed' and coalesce((select r.entry_date <= p_as_at from public.journal_entries r where r.id = je.reversed_by_id), false))
    and not (je.reverses_id is not null and coalesce((select o.entry_date <= p_as_at from public.journal_entries o where o.id = je.reverses_id), false));
$$;

-- The reconciliation for an account at a statement date.
create or replace function public.bank_reconcile_summary(p_account uuid, p_as_at date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ledgerBalance', coalesce((select sum(jl.debit - jl.credit) from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_id
                                where jl.account_id = p_account and je.status in ('posted', 'reversed') and je.entry_date <= p_as_at), 0),
    'unpresented', coalesce((select sum(amount) from public.bank_ledger_lines(p_account, p_as_at) where not cleared), 0),
    -- In the bank by the date but entered in the ledger after it.
    'recordedEarly', coalesce((select sum(jl.debit - jl.credit) from public.bank_matches m join public.bank_transactions t on t.id = m.bank_transaction_id
                               join public.journal_lines jl on jl.id = m.journal_line_id join public.journal_entries je on je.id = jl.journal_id
                               where t.account_id = p_account and t.txn_date <= p_as_at and je.entry_date > p_as_at), 0),
    'openLines', (select count(*) from public.bank_transactions where account_id = p_account and status = 'new' and txn_date <= p_as_at),
    'lastReconciled', (select max(statement_date) from public.bank_reconciliations where account_id = p_account and status = 'completed'),
    'firstReconciliation', not exists (select 1 from public.bank_reconciliations where account_id = p_account and status = 'completed'));
$$;

------------------------------------------------------------------------------
-- 5. Company bank account settings
------------------------------------------------------------------------------

create or replace function public.company_bank_settings(p_actor uuid, p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v record;
  v_ledger uuid := nullif(p->>'ledger_account_id', '')::uuid;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v from public.company_bank_accounts where id = p_id and organization_id = v_org for update;
  if not found then raise exception 'Bank account not found.' using errcode = 'P0002'; end if;
  if v.status not in ('pending', 'active') then raise exception 'This bank account is no longer in use.' using errcode = '22023'; end if;
  if v_ledger is not null and not exists (select 1 from public.accounts where id = v_ledger and organization_id = v_org and subtype = 'bank' and status = 'active') then
    raise exception 'Choose a bank account from the chart of accounts.' using errcode = '22023';
  end if;
  if coalesce(nullif(regexp_replace(p->>'apca_user_id', '\s', '', 'g'), ''), '000000') !~ '^\d{6}$' then
    raise exception 'An APCA user ID (direct entry user ID) is 6 digits. Your bank gives it to you.' using errcode = '22023';
  end if;
  if coalesce(nullif(upper(btrim(p->>'aba_bank_code')), ''), 'AAA') !~ '^[A-Z]{3}$' then
    raise exception 'The bank code is the 3-letter code your bank gives you, like CBA, WBC, NAB or ANZ.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p->>'aba_user_name', ''))) > 26 then
    raise exception 'The user name for bank files is at most 26 characters.' using errcode = '22023';
  end if;
  if v_ledger is not null and exists (select 1 from public.company_bank_accounts where ledger_account_id = v_ledger and id <> p_id and status in ('pending', 'active')) then
    raise exception 'That ledger account is already linked to another bank account.' using errcode = '22023';
  end if;
  update public.company_bank_accounts set
    ledger_account_id = case when p ? 'ledger_account_id' then v_ledger else ledger_account_id end,
    aba_bank_code = case when p ? 'aba_bank_code' then nullif(upper(btrim(p->>'aba_bank_code')), '') else aba_bank_code end,
    aba_user_name = case when p ? 'aba_user_name' then nullif(btrim(p->>'aba_user_name'), '') else aba_user_name end,
    aba_balancing_record = coalesce((p->>'aba_balancing_record')::boolean, aba_balancing_record),
    apca_user_id = case when p ? 'apca_user_id' then nullif(regexp_replace(p->>'apca_user_id', '\s', '', 'g'), '') else apca_user_id end
  where id = p_id;
  perform public.app_audit(p_actor, 'company_bank_settings_changed', 'company_bank_account', p_id::text,
    jsonb_build_object('ledger', v.ledger_account_id, 'bankCode', v.aba_bank_code, 'userName', v.aba_user_name, 'balancing', v.aba_balancing_record, 'apca', v.apca_user_id),
    (select jsonb_build_object('ledger', ledger_account_id, 'bankCode', aba_bank_code, 'userName', aba_user_name, 'balancing', aba_balancing_record, 'apca', apca_user_id)
     from public.company_bank_accounts where id = p_id));
end;
$$;

------------------------------------------------------------------------------
-- 6. Statement import
------------------------------------------------------------------------------

-- Rows: [{date, description, reference, amount, balance, externalId}], from
-- the browser's parser. Lines already imported (same date, amount and
-- description, or the same bank id) are skipped; two identical lines in a
-- file are both kept, and a later file with the same two adds neither.
create or replace function public.bank_import(p_actor uuid, p_account uuid, p_file_name text, p_format text, p_rows jsonb,
  p_statement_balance numeric, p_balance_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_id uuid;
  v_rows int;
  v_added int;
  r jsonb;
  v_i int := 0;
  v_date date; v_amount numeric; v_desc text;
begin
  perform public.app_require(p_actor, 'bank.manage');
  if not exists (select 1 from public.accounts where id = p_account and organization_id = v_org and subtype = 'bank' and status = 'active') then
    raise exception 'Choose the bank account this statement is for.' using errcode = '22023';
  end if;
  if p_format not in ('csv', 'ofx', 'qif') then raise exception 'Unknown statement format.' using errcode = '22023'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no transactions.' using errcode = '22023';
  end if;
  v_rows := jsonb_array_length(p_rows);
  if v_rows > 5000 then raise exception 'Import at most 5,000 lines at a time.' using errcode = '22023'; end if;
  if p_statement_balance is not null and p_statement_balance <> round(p_statement_balance, 2) then
    raise exception 'The statement balance can have at most 2 decimal places.' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    begin
      v_date := (r->>'date')::date;
      v_amount := (r->>'amount')::numeric;
    exception when others then
      raise exception 'Line %: the date or amount isn''t readable.', v_i using errcode = '22023';
    end;
    v_desc := btrim(coalesce(r->>'description', ''));
    if v_date is null or v_date < current_date - 3650 or v_date > current_date + 31 then
      raise exception 'Line %: the date % is out of range.', v_i, r->>'date' using errcode = '22023';
    end if;
    if v_amount is null or v_amount = 0 or v_amount <> round(v_amount, 2) or abs(v_amount) >= 1e11 then
      raise exception 'Line %: the amount must be a non-zero number of dollars and cents.', v_i using errcode = '22023';
    end if;
    if length(v_desc) = 0 then raise exception 'Line %: there is no description.', v_i using errcode = '22023'; end if;
  end loop;

  insert into public.bank_imports (organization_id, account_id, file_name, format, rows_in_file, statement_balance, statement_balance_date, imported_by)
  values (v_org, p_account, left(btrim(p_file_name), 200), p_format, v_rows, p_statement_balance, p_balance_date, p_actor)
  returning id into v_id;

  with src as (
    select ord, (x->>'date')::date as d, (x->>'amount')::numeric as amt, left(regexp_replace(btrim(x->>'description'), '\s+', ' ', 'g'), 300) as descr,
      left(btrim(coalesce(x->>'reference', '')), 120) as ref, nullif(x->>'balance', '')::numeric as bal, nullif(left(btrim(coalesce(x->>'externalId', '')), 120), '') as ext
    from jsonb_array_elements(p_rows) with ordinality as t(x, ord)
  ), keyed as (
    select *, coalesce('id:' || ext, d::text || '|' || amt::text || '|' || lower(descr)) as k from src
  ), numbered as (
    select *, k || '#' || row_number() over (partition by k order by ord) as dk from keyed
  ), ins as (
    insert into public.bank_transactions (organization_id, account_id, import_id, txn_date, description, reference, amount, balance, external_id, dedupe_key)
    select v_org, p_account, v_id, d, descr, ref, amt, round(bal, 2), ext, dk from numbered order by ord
    on conflict (account_id, dedupe_key) do nothing
    returning txn_date
  )
  select count(*) into v_added from ins;

  update public.bank_imports set rows_added = v_added,
    first_date = (select min(txn_date) from public.bank_transactions where import_id = v_id),
    last_date = (select max(txn_date) from public.bank_transactions where import_id = v_id)
  where id = v_id;
  perform public.app_audit(p_actor, 'bank_statement_imported', 'bank_import', v_id::text, null,
    jsonb_build_object('account', (select code from public.accounts where id = p_account), 'file', p_file_name, 'lines', v_rows, 'added', v_added));
  return jsonb_build_object('id', v_id, 'rows', v_rows, 'added', v_added, 'skipped', v_rows - v_added);
end;
$$;

-- Removes an import's lines, if none of them has been used yet.
create or replace function public.bank_import_undo(p_actor uuid, p_import uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v from public.bank_imports where id = p_import and organization_id = public.app_org_of(p_actor) for update;
  if not found or v.undone_at is not null then raise exception 'Import not found.' using errcode = 'P0002'; end if;
  if exists (select 1 from public.bank_transactions where import_id = p_import and status <> 'new') then
    raise exception 'Some lines from this file are already matched or excluded. Undo those first.' using errcode = '22023';
  end if;
  delete from public.bank_transactions where import_id = p_import;
  update public.bank_imports set undone_at = now(), undone_by = p_actor where id = p_import;
  perform public.app_audit(p_actor, 'bank_import_undone', 'bank_import', p_import::text, jsonb_build_object('added', v.rows_added), null);
end;
$$;

------------------------------------------------------------------------------
-- 7. Matching
------------------------------------------------------------------------------

-- Matches a statement line to ledger lines on the same bank account whose
-- total is the line's amount.
create or replace function public.bank_match(p_actor uuid, p_txn uuid, p_lines uuid[], p_kind text default 'existing')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  v_sum numeric;
  v_n int;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into t from public.bank_transactions where id = p_txn and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Statement line not found.' using errcode = 'P0002'; end if;
  if t.status <> 'new' then raise exception 'This statement line is already matched or excluded.' using errcode = '22023'; end if;
  if p_lines is null or cardinality(p_lines) = 0 then raise exception 'Choose what this statement line pays.' using errcode = '22023'; end if;
  perform 1 from public.journal_lines where id = any(p_lines) for update;
  select count(*), coalesce(sum(jl.debit - jl.credit), 0) into v_n, v_sum
  from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_id
  where jl.id = any(p_lines) and jl.account_id = t.account_id and je.status = 'posted' and je.reverses_id is null
    and not exists (select 1 from public.bank_matches m where m.journal_line_id = jl.id)
    and not exists (select 1 from public.bank_cleared_lines c where c.journal_line_id = jl.id);
  if v_n <> cardinality(p_lines) then
    raise exception 'Some of those entries aren''t on this bank account, or are already matched.' using errcode = '22023';
  end if;
  if v_sum <> t.amount then
    raise exception 'The entries total %, but the statement line is %.', to_char(v_sum, 'FM$999,999,990.00'), to_char(t.amount, 'FM$999,999,990.00') using errcode = '22023';
  end if;
  insert into public.bank_matches (bank_transaction_id, journal_line_id) select p_txn, x from unnest(p_lines) x;
  update public.bank_transactions set status = 'matched', match_kind = p_kind, matched_by = p_actor, matched_at = now() where id = p_txn;
  perform public.app_audit(p_actor, 'bank_line_matched', 'bank_transaction', p_txn::text, null,
    jsonb_build_object('date', t.txn_date, 'amount', t.amount, 'journals', (select jsonb_agg(distinct je.number) from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_id where jl.id = any(p_lines)),
      'kind', p_kind));
end;
$$;

-- Matches a statement line to every line of one journal on its bank account.
create or replace function public.bank_match_journal(p_actor uuid, p_txn uuid, p_journal uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.bank_match(p_actor, p_txn,
    (select array_agg(jl.id) from public.journal_lines jl where jl.journal_id = p_journal
       and jl.account_id = (select account_id from public.bank_transactions where id = p_txn)), p_kind);
end;
$$;

-- Undoes a match. An entry created from the statement line is reversed;
-- receipts and payments stay (void them in their own screen if wrong).
create or replace function public.bank_unmatch(p_actor uuid, p_txn uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  v_journals uuid[];
  j uuid;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into t from public.bank_transactions where id = p_txn and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Statement line not found.' using errcode = 'P0002'; end if;
  if t.reconciliation_id is not null then raise exception 'This line is in a completed reconciliation. Undo that reconciliation first.' using errcode = '22023'; end if;
  if t.status = 'excluded' then
    update public.bank_transactions set status = 'new', excluded_reason = null, matched_by = null, matched_at = null where id = p_txn;
    perform public.app_audit(p_actor, 'bank_line_restored', 'bank_transaction', p_txn::text, jsonb_build_object('reason', t.excluded_reason), null);
    return;
  end if;
  if t.status <> 'matched' then raise exception 'This statement line isn''t matched.' using errcode = '22023'; end if;
  select array_agg(distinct jl.journal_id) into v_journals from public.bank_matches m join public.journal_lines jl on jl.id = m.journal_line_id where m.bank_transaction_id = p_txn;
  delete from public.bank_matches where bank_transaction_id = p_txn;
  update public.bank_transactions set status = 'new', match_kind = null, matched_by = null, matched_at = null where id = p_txn;
  if t.match_kind = 'created' then
    foreach j in array v_journals loop
      if (select source_type from public.journal_entries where id = j) = 'bank_transaction' then
        perform public.ledger_reverse_entry(p_actor, j, null, 'Unmatched from the bank statement');
      end if;
    end loop;
  end if;
  perform public.app_audit(p_actor, 'bank_line_unmatched', 'bank_transaction', p_txn::text, jsonb_build_object('kind', t.match_kind), null);
end;
$$;

create or replace function public.bank_exclude(p_actor uuid, p_txn uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into t from public.bank_transactions where id = p_txn and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Statement line not found.' using errcode = 'P0002'; end if;
  if t.status <> 'new' then raise exception 'Only an unmatched line can be excluded.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why this line is excluded (for example, a duplicate).' using errcode = '22023'; end if;
  update public.bank_transactions set status = 'excluded', excluded_reason = left(btrim(p_reason), 300), matched_by = p_actor, matched_at = now() where id = p_txn;
  perform public.app_audit(p_actor, 'bank_line_excluded', 'bank_transaction', p_txn::text, null,
    jsonb_build_object('date', t.txn_date, 'amount', t.amount, 'description', t.description, 'reason', btrim(p_reason)));
end;
$$;

-- "Spend or receive money": posts an entry from a statement line and matches
-- it. Lines: [{accountId, taxCodeId, amount, description}], GST inclusive,
-- adding up to the statement amount. Control accounts (receivables,
-- payables) can't be used: record a receipt or payment instead.
create or replace function public.bank_create_entry(p_actor uuid, p_txn uuid, p_payee text, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  v_total numeric := 0;
  l jsonb;
  v_amt numeric;
  v_side text;
  v_lines jsonb := '[]'::jsonb;
  v_j uuid;
  v_payee text := nullif(btrim(coalesce(p_payee, '')), '');
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into t from public.bank_transactions where id = p_txn and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Statement line not found.' using errcode = 'P0002'; end if;
  if t.status <> 'new' then raise exception 'This statement line is already matched or excluded.' using errcode = '22023'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Choose the account (or accounts) this money is for.' using errcode = '22023';
  end if;
  v_side := case when t.amount > 0 then 'credit' else 'debit' end;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_amt := nullif(l->>'amount', '')::numeric;
    if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then raise exception 'Each line needs a positive amount.' using errcode = '22023'; end if;
    if (l->>'accountId')::uuid = t.account_id then raise exception 'Choose an account other than this bank account.' using errcode = '22023'; end if;
    v_total := v_total + v_amt;
    v_lines := v_lines || jsonb_build_object('accountId', l->>'accountId', 'taxCodeId', nullif(l->>'taxCodeId', ''),
      'debit', case when v_side = 'debit' then v_amt else 0 end, 'credit', case when v_side = 'credit' then v_amt else 0 end,
      'description', left(coalesce(nullif(btrim(l->>'description'), ''), v_payee, t.description), 300));
  end loop;
  if v_total <> abs(t.amount) then
    raise exception 'The lines add up to %, but the statement line is %.', to_char(v_total, 'FM$999,999,990.00'), to_char(abs(t.amount), 'FM$999,999,990.00') using errcode = '22023';
  end if;
  v_lines := jsonb_build_array(jsonb_build_object('accountId', t.account_id, 'debit', greatest(t.amount, 0), 'credit', greatest(-t.amount, 0),
    'description', left(coalesce(v_payee, t.description), 300))) || v_lines;
  v_j := public.ledger_post_entry(p_actor, t.txn_date, left(coalesce(v_payee || ': ', '') || t.description, 500), 'bank_transaction', p_txn,
    nullif(t.reference, ''), v_lines, 'inclusive', true);
  perform public.bank_match_journal(p_actor, p_txn, v_j, 'created');
  return v_j;
end;
$$;

-- Records a customer receipt from a statement line (applied to invoices) and matches it.
create or replace function public.bank_receive_payment(p_actor uuid, p_txn uuid, p_customer uuid, p_allocations jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  v_pay uuid;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into t from public.bank_transactions where id = p_txn and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Statement line not found.' using errcode = 'P0002'; end if;
  if t.status <> 'new' then raise exception 'This statement line is already matched or excluded.' using errcode = '22023'; end if;
  if t.amount <= 0 then raise exception 'Only money in can be a customer receipt.' using errcode = '22023'; end if;
  v_pay := public.customer_payment_record(p_actor, p_customer, t.txn_date, t.amount, t.account_id, left(coalesce(nullif(t.reference, ''), t.description), 120),
    'bank_transfer', p_allocations);
  perform public.bank_match_journal(p_actor, p_txn, (select journal_id from public.customer_payments where id = v_pay), 'created');
  return v_pay;
end;
$$;

-- Records a supplier payment from a statement line (for bills) and matches it.
create or replace function public.bank_pay_bills(p_actor uuid, p_txn uuid, p_supplier uuid, p_allocations jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  v_pay uuid;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into t from public.bank_transactions where id = p_txn and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Statement line not found.' using errcode = 'P0002'; end if;
  if t.status <> 'new' then raise exception 'This statement line is already matched or excluded.' using errcode = '22023'; end if;
  if t.amount >= 0 then raise exception 'Only money out can pay bills.' using errcode = '22023'; end if;
  v_pay := public.supplier_payment_record(p_actor, p_supplier, t.txn_date, t.account_id, left(coalesce(nullif(t.reference, ''), t.description), 120),
    'bank_transfer', p_allocations);
  perform public.bank_match_journal(p_actor, p_txn, (select journal_id from public.supplier_payments where id = v_pay), 'created');
  return v_pay;
end;
$$;

-- Records a pay run's net pay or super as paid from a statement line and matches it.
create or replace function public.bank_pay_run(p_actor uuid, p_txn uuid, p_run uuid, p_what text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
  v_j uuid;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into t from public.bank_transactions where id = p_txn and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Statement line not found.' using errcode = 'P0002'; end if;
  if t.status <> 'new' then raise exception 'This statement line is already matched or excluded.' using errcode = '22023'; end if;
  if t.amount >= 0 then raise exception 'Pay runs are money out.' using errcode = '22023'; end if;
  if p_what = 'net' then
    perform public.pay_run_record_payment(p_actor, p_run, t.account_id, t.txn_date);
    v_j := (select payment_journal_id from public.pay_runs where id = p_run);
  elsif p_what = 'super' then
    perform public.pay_run_record_super(p_actor, p_run, t.account_id, t.txn_date);
    v_j := (select super_journal_id from public.pay_runs where id = p_run);
  else
    raise exception 'Choose net pay or super.' using errcode = '22023';
  end if;
  perform public.bank_match_journal(p_actor, p_txn, v_j, 'created');
end;
$$;

------------------------------------------------------------------------------
-- 8. Bank rules
------------------------------------------------------------------------------

create or replace function public.bank_rule_save(p_actor uuid, p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_id uuid := p_id;
  v_target uuid := nullif(p->>'target_account_id', '')::uuid;
  v_tax uuid := nullif(p->>'tax_code_id', '')::uuid;
  v_bank uuid := nullif(p->>'bank_account_id', '')::uuid;
  v_old jsonb;
begin
  perform public.app_require(p_actor, 'bank.manage');
  if not exists (select 1 from public.accounts where id = v_target and organization_id = v_org and status = 'active' and allow_manual and subtype <> 'bank') then
    raise exception 'Choose the account the rule codes to (not a bank or control account).' using errcode = '22023';
  end if;
  if v_tax is not null and not exists (select 1 from public.tax_codes where id = v_tax and organization_id = v_org and active) then
    raise exception 'Choose an active tax code.' using errcode = '22023';
  end if;
  if v_bank is not null and not exists (select 1 from public.accounts where id = v_bank and organization_id = v_org and subtype = 'bank') then
    raise exception 'Choose a bank account, or leave it for all bank accounts.' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.bank_rules (organization_id, name, bank_account_id, direction, match_text, amount_min, amount_max, target_account_id, tax_code_id, payee, priority, active, created_by)
    values (v_org, btrim(p->>'name'), v_bank, coalesce(nullif(p->>'direction', ''), 'any'), btrim(p->>'match_text'), nullif(p->>'amount_min', '')::numeric,
      nullif(p->>'amount_max', '')::numeric, v_target, v_tax, left(btrim(coalesce(p->>'payee', '')), 120), coalesce(nullif(p->>'priority', '')::int, 100),
      coalesce((p->>'active')::boolean, true), p_actor)
    returning id into v_id;
  else
    select to_jsonb(r) into v_old from public.bank_rules r where id = v_id and organization_id = v_org;
    if v_old is null then raise exception 'Rule not found.' using errcode = 'P0002'; end if;
    update public.bank_rules set name = btrim(p->>'name'), bank_account_id = v_bank, direction = coalesce(nullif(p->>'direction', ''), 'any'),
      match_text = btrim(p->>'match_text'), amount_min = nullif(p->>'amount_min', '')::numeric, amount_max = nullif(p->>'amount_max', '')::numeric,
      target_account_id = v_target, tax_code_id = v_tax, payee = left(btrim(coalesce(p->>'payee', '')), 120),
      priority = coalesce(nullif(p->>'priority', '')::int, 100), active = coalesce((p->>'active')::boolean, true), updated_at = now()
    where id = v_id;
  end if;
  perform public.app_audit(p_actor, case when v_old is null then 'bank_rule_created' else 'bank_rule_updated' end, 'bank_rule', v_id::text, v_old,
    (select to_jsonb(r) from public.bank_rules r where id = v_id));
  return v_id;
end;
$$;

create or replace function public.bank_rule_delete(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select to_jsonb(r) into v_old from public.bank_rules r where id = p_id and organization_id = public.app_org_of(p_actor);
  if v_old is null then raise exception 'Rule not found.' using errcode = 'P0002'; end if;
  delete from public.bank_rules where id = p_id;
  perform public.app_audit(p_actor, 'bank_rule_deleted', 'bank_rule', p_id::text, v_old, null);
end;
$$;

------------------------------------------------------------------------------
-- 9. Reconciliation
------------------------------------------------------------------------------

-- Completes a reconciliation. The first one for an account can treat ledger
-- lines dated before a cut-off as already through the bank.
create or replace function public.bank_reconcile(p_actor uuid, p_account uuid, p_date date, p_balance numeric, p_cleared_before date, p_notes text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_last date;
  v_first boolean;
  v_id uuid;
  s jsonb;
  v_expected numeric;
begin
  perform public.app_require(p_actor, 'bank.manage');
  if not exists (select 1 from public.accounts where id = p_account and organization_id = v_org and subtype = 'bank') then
    raise exception 'Choose a bank account.' using errcode = '22023';
  end if;
  perform 1 from public.accounts where id = p_account for update;
  if p_date is null or p_date > current_date + 366 then raise exception 'Enter the statement date.' using errcode = '22023'; end if;
  if p_balance is null or p_balance <> round(p_balance, 2) then raise exception 'Enter the statement''s closing balance.' using errcode = '22023'; end if;
  select max(statement_date) into v_last from public.bank_reconciliations where account_id = p_account and status = 'completed';
  v_first := v_last is null;
  if not v_first and p_date <= v_last then
    raise exception 'This account is reconciled to %. Choose a later statement date.', to_char(v_last, 'DD Mon YYYY') using errcode = '22023';
  end if;
  if p_cleared_before is not null and not v_first then
    raise exception 'Earlier entries can only be cleared on the first reconciliation.' using errcode = '22023';
  end if;
  if p_cleared_before is not null and p_cleared_before > p_date then
    raise exception 'The cut-off for earlier entries can''t be after the statement date.' using errcode = '22023';
  end if;
  if exists (select 1 from public.bank_transactions where account_id = p_account and status = 'new' and txn_date <= p_date) then
    raise exception 'Some statement lines up to % aren''t matched or excluded yet.', to_char(p_date, 'DD Mon YYYY') using errcode = '22023';
  end if;

  insert into public.bank_reconciliations (organization_id, account_id, statement_date, statement_balance, ledger_balance, unpresented, cleared_before, notes, completed_by)
  values (v_org, p_account, p_date, p_balance, 0, 0, p_cleared_before, left(coalesce(p_notes, ''), 1000), p_actor) returning id into v_id;
  if p_cleared_before is not null then
    insert into public.bank_cleared_lines (journal_line_id, reconciliation_id)
    select l.journal_line_id, v_id from public.bank_ledger_lines(p_account, p_cleared_before - 1) l where not l.cleared and l.matched_txn is null;
  end if;
  s := public.bank_reconcile_summary(p_account, p_date);
  v_expected := (s->>'ledgerBalance')::numeric - (s->>'unpresented')::numeric + (s->>'recordedEarly')::numeric;
  if v_expected <> p_balance then
    raise exception 'Out of balance by %: the ledger says the statement should show %.', to_char(p_balance - v_expected, 'FM$999,999,990.00'),
      to_char(v_expected, 'FM$999,999,990.00') using errcode = '22023';
  end if;
  update public.bank_reconciliations set ledger_balance = (s->>'ledgerBalance')::numeric, unpresented = (s->>'unpresented')::numeric,
    recorded_early = (s->>'recordedEarly')::numeric where id = v_id;
  update public.bank_transactions set reconciliation_id = v_id where account_id = p_account and txn_date <= p_date and reconciliation_id is null and status <> 'new';
  perform public.app_audit(p_actor, 'bank_reconciled', 'bank_reconciliation', v_id::text, null,
    jsonb_build_object('account', (select code from public.accounts where id = p_account), 'date', p_date, 'balance', p_balance,
      'unpresented', (s->>'unpresented')::numeric, 'clearedBefore', p_cleared_before));
  return v_id;
end;
$$;

-- Undoes the latest reconciliation for an account.
create or replace function public.bank_reconcile_undo(p_actor uuid, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v from public.bank_reconciliations where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found or v.status <> 'completed' then raise exception 'Reconciliation not found.' using errcode = 'P0002'; end if;
  if exists (select 1 from public.bank_reconciliations where account_id = v.account_id and status = 'completed' and statement_date > v.statement_date) then
    raise exception 'Undo the later reconciliations first.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why it''s being undone.' using errcode = '22023'; end if;
  update public.bank_transactions set reconciliation_id = null where reconciliation_id = p_id;
  delete from public.bank_cleared_lines where reconciliation_id = p_id;
  update public.bank_reconciliations set status = 'undone', undone_by = p_actor, undone_at = now(), undo_reason = btrim(p_reason) where id = p_id;
  perform public.app_audit(p_actor, 'bank_reconciliation_undone', 'bank_reconciliation', p_id::text, jsonb_build_object('status', 'completed'),
    jsonb_build_object('status', 'undone', 'reason', btrim(p_reason)));
end;
$$;

------------------------------------------------------------------------------
-- 10. Payment batches (ABA)
------------------------------------------------------------------------------

-- Items: [{billId, amount}]. Supplier bank details are copied now and
-- checked again at approval.
create or replace function public.payment_batch_create(p_actor uuid, p_source uuid, p_date date, p_description text, p_items jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.app_org_of(p_actor);
  v_src record;
  v_id uuid;
  i jsonb;
  b record;
  s record;
  v_amt numeric;
  v_ref text;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v_src from public.company_bank_accounts where id = p_source and organization_id = v_org;
  if not found or v_src.status <> 'active' then raise exception 'Choose an approved company bank account to pay from.' using errcode = '22023'; end if;
  if v_src.ledger_account_id is null or v_src.apca_user_id is null or v_src.aba_bank_code is null or v_src.aba_user_name is null then
    raise exception 'Set up % for bank files first: its ledger account, APCA user ID, bank code and user name.', v_src.nickname using errcode = '22023';
  end if;
  if p_date is null then raise exception 'Choose the payment date.' using errcode = '22023'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Choose the bills to pay.' using errcode = '22023'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'A batch can pay at most 500 bills.' using errcode = '22023'; end if;
  insert into public.payment_batches (organization_id, number, source_bank_id, payment_date, description, created_by)
  values (v_org, public.next_document_number(v_org, 'payment_batch'), p_source, p_date,
    coalesce(nullif(btrim(left(regexp_replace(upper(btrim(coalesce(p_description, ''))), '[^A-Z0-9 &./-]', '', 'g'), 12)), ''), 'SUPPLIERS'), p_actor)
  returning id into v_id;
  for i in select * from jsonb_array_elements(p_items) loop
    select * into b from public.bills where id = (i->>'billId')::uuid and organization_id = v_org and kind = 'bill' for update;
    if b.id is null or b.status <> 'approved' then raise exception 'Only approved bills can be paid.' using errcode = '22023'; end if;
    v_amt := coalesce(nullif(i->>'amount', '')::numeric, public.bill_outstanding(b.id));
    if v_amt <= 0 or v_amt <> round(v_amt, 2) or v_amt > public.bill_outstanding(b.id) then
      raise exception 'Bill %: the amount is more than what is owing.', b.number using errcode = '22023';
    end if;
    if exists (select 1 from public.payment_batch_items pi join public.payment_batches pb on pb.id = pi.batch_id
               where pi.bill_id = b.id and pb.status in ('draft', 'approved') and pb.id <> v_id) then
      raise exception 'Bill % is already in another batch waiting to be paid.', b.number using errcode = '22023';
    end if;
    select * into s from public.suppliers where id = b.supplier_id;
    if s.bank_bsb is null or s.bank_account_number is null then
      raise exception '% has no approved bank account.', s.name using errcode = '22023';
    end if;
    if length(s.bank_account_number) > 9 then
      raise exception '% has a 10-digit account number, which bank files can''t carry. Pay them separately.', s.name using errcode = '22023';
    end if;
    v_ref := left(regexp_replace(coalesce(nullif(btrim(b.supplier_reference), ''), b.number), '[^A-Za-z0-9 &./-]', '', 'g'), 18);
    insert into public.payment_batch_items (batch_id, bill_id, supplier_id, amount, account_name, bsb, account_number, lodgement_ref)
    values (v_id, b.id, s.id, v_amt, coalesce(nullif(s.bank_account_name, ''), s.name), s.bank_bsb, s.bank_account_number, coalesce(nullif(v_ref, ''), b.number));
  end loop;
  update public.payment_batches set total = (select sum(amount) from public.payment_batch_items where batch_id = v_id),
    item_count = (select count(*) from public.payment_batch_items where batch_id = v_id) where id = v_id;
  perform public.app_notify_holders(v_org, 'bank.manage', p_actor, 'payment_batch_created', 'Payment batch to approve: ' || (select number from public.payment_batches where id = v_id),
    to_char((select total from public.payment_batches where id = v_id), 'FM$999,999,990.00') || ' to pay on ' || to_char(p_date, 'DD Mon YYYY'), 'payment-batches');
  perform public.app_audit(p_actor, 'payment_batch_created', 'payment_batch', v_id::text, null,
    (select jsonb_build_object('number', number, 'total', total, 'items', item_count, 'date', payment_date) from public.payment_batches where id = v_id));
  return v_id;
end;
$$;

-- A second person approves the batch: bills still owing, bank details unchanged.
create or replace function public.payment_batch_approve(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  i record;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v from public.payment_batches where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Payment batch not found.' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'Only a batch waiting for approval can be approved.' using errcode = '22023'; end if;
  if v.created_by = p_actor then raise exception 'Someone other than the person who made the batch must approve it.' using errcode = '42501'; end if;
  for i in select pi.*, b.number as bill_number, b.status as bill_status, s.name as supplier, s.bank_bsb, s.bank_account_number
           from public.payment_batch_items pi join public.bills b on b.id = pi.bill_id join public.suppliers s on s.id = pi.supplier_id where pi.batch_id = p_id loop
    if i.bill_status <> 'approved' or i.amount > public.bill_outstanding(i.bill_id) then
      raise exception 'Bill % is no longer owing that much. Cancel this batch and make a new one.', i.bill_number using errcode = '22023';
    end if;
    if i.bank_bsb is distinct from i.bsb or i.bank_account_number is distinct from i.account_number then
      raise exception '%''s bank details changed after the batch was made. Cancel it and make a new one.', i.supplier using errcode = '22023';
    end if;
  end loop;
  update public.payment_batches set status = 'approved', approved_by = p_actor, approved_at = now() where id = p_id;
  if v.created_by is not null then
    insert into public.notifications (organization_id, profile_id, kind, title, body, link)
    values (v.organization_id, v.created_by, 'payment_batch_approved', 'Payment batch approved: ' || v.number, 'Download the bank file and upload it to the bank.', 'payment-batches');
  end if;
  perform public.app_audit(p_actor, 'payment_batch_approved', 'payment_batch', p_id::text, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'approved', 'total', v.total));
end;
$$;

create or replace function public.payment_batch_file_downloaded(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v from public.payment_batches where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Payment batch not found.' using errcode = 'P0002'; end if;
  if v.status not in ('approved', 'paid') then raise exception 'The bank file is available once the batch is approved.' using errcode = '22023'; end if;
  update public.payment_batches set file_downloaded_at = now(), file_downloaded_by = p_actor where id = p_id;
  perform public.app_audit(p_actor, 'payment_batch_file_downloaded', 'payment_batch', p_id::text, null,
    jsonb_build_object('number', v.number, 'total', v.total, 'again', v.file_downloaded_at is not null));
end;
$$;

-- After the bank has processed the file: one supplier payment per supplier.
create or replace function public.payment_batch_mark_paid(p_actor uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_ledger uuid;
  s record;
  v_pay uuid;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v from public.payment_batches where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Payment batch not found.' using errcode = 'P0002'; end if;
  if v.status <> 'approved' then raise exception 'Only an approved batch can be marked as paid.' using errcode = '22023'; end if;
  if v.file_downloaded_at is null then raise exception 'Download the bank file and send it to the bank first.' using errcode = '22023'; end if;
  v_ledger := (select ledger_account_id from public.company_bank_accounts where id = v.source_bank_id);
  for s in select supplier_id, jsonb_agg(jsonb_build_object('billId', bill_id, 'amount', amount)) as allocations
           from public.payment_batch_items where batch_id = p_id group by supplier_id loop
    v_pay := public.supplier_payment_record(p_actor, s.supplier_id, v.payment_date, v_ledger, v.number, 'bank_transfer', s.allocations);
    update public.payment_batch_items set supplier_payment_id = v_pay where batch_id = p_id and supplier_id = s.supplier_id;
  end loop;
  update public.payment_batches set status = 'paid', paid_by = p_actor, paid_at = now() where id = p_id;
  perform public.app_audit(p_actor, 'payment_batch_paid', 'payment_batch', p_id::text, jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'paid', 'total', v.total));
end;
$$;

create or replace function public.payment_batch_cancel(p_actor uuid, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public.app_require(p_actor, 'bank.manage');
  select * into v from public.payment_batches where id = p_id and organization_id = public.app_org_of(p_actor) for update;
  if not found then raise exception 'Payment batch not found.' using errcode = 'P0002'; end if;
  if v.status not in ('draft', 'approved') then raise exception 'Only a batch that hasn''t been paid can be cancelled.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why the batch is cancelled.' using errcode = '22023'; end if;
  update public.payment_batches set status = 'cancelled', cancelled_by = p_actor, cancelled_at = now(), cancel_reason = btrim(p_reason) where id = p_id;
  perform public.app_audit(p_actor, 'payment_batch_cancelled', 'payment_batch', p_id::text, jsonb_build_object('status', v.status),
    jsonb_build_object('status', 'cancelled', 'reason', btrim(p_reason), 'fileDownloaded', v.file_downloaded_at is not null));
end;
$$;

------------------------------------------------------------------------------
-- 11. Lock down
------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['bank_imports', 'bank_reconciliations', 'bank_transactions', 'bank_matches', 'bank_cleared_lines', 'bank_rules',
    'payment_batches', 'payment_batch_items']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to service_role', t);
  end loop;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'bank_ledger_lines(uuid, date)', 'bank_reconcile_summary(uuid, date)', 'company_bank_settings(uuid, uuid, jsonb)',
    'bank_import(uuid, uuid, text, text, jsonb, numeric, date)', 'bank_import_undo(uuid, uuid)',
    'bank_match(uuid, uuid, uuid[], text)', 'bank_match_journal(uuid, uuid, uuid, text)', 'bank_unmatch(uuid, uuid)', 'bank_exclude(uuid, uuid, text)',
    'bank_create_entry(uuid, uuid, text, jsonb)', 'bank_receive_payment(uuid, uuid, uuid, jsonb)', 'bank_pay_bills(uuid, uuid, uuid, jsonb)',
    'bank_pay_run(uuid, uuid, uuid, text)', 'bank_rule_save(uuid, uuid, jsonb)', 'bank_rule_delete(uuid, uuid)',
    'bank_reconcile(uuid, uuid, date, numeric, date, text)', 'bank_reconcile_undo(uuid, uuid, text)',
    'payment_batch_create(uuid, uuid, date, text, jsonb)', 'payment_batch_approve(uuid, uuid)', 'payment_batch_file_downloaded(uuid, uuid)',
    'payment_batch_mark_paid(uuid, uuid)', 'payment_batch_cancel(uuid, uuid, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

commit;
