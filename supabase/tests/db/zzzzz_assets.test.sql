-- Behavioural tests for Phase 8: fixed assets. Works in July to October 2027
-- (no earlier test posts there). Rolled back at the end.
--   Tools FA-1: cost 6,000, straight line 60 months (100.00 a month), in service 15 July 2027.
--   Vehicle FA-2: cost 48,000, diminishing value 96 months (2/96 of book value a month), in service 1 August 2027.
begin;

create or replace function pg_temp.p(p text) returns uuid language sql as $$ select id from public.training_profiles where email = p || '@fin.test' $$;
create or replace function pg_temp.acc(p text) returns uuid language sql as $$
  select id from public.accounts where organization_id = '00000000-0000-4000-8000-000000000001' and code = p $$;
create or replace function pg_temp.cat(p text) returns uuid language sql as $$ select id from public.asset_categories where name = p $$;
create or replace function pg_temp.expect_error(p_sql text, p_pattern text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm !~* p_pattern then
      raise exception 'Expected error matching "%", got "%"', p_pattern, sqlerrm;
    end if;
    return;
  end;
  raise exception 'Expected error matching "%", but the statement succeeded: %', p_pattern, p_sql;
end $$;
create or replace function pg_temp.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception '% : expected %, got %', p_label, p_expected, p_actual;
  end if;
end $$;
create or replace function pg_temp.dr(p_journal uuid, p_acc text) returns numeric language sql as $$
  select coalesce(sum(debit), 0) from public.journal_lines where journal_id = p_journal and account_id = pg_temp.acc(p_acc) $$;
create or replace function pg_temp.cr(p_journal uuid, p_acc text) returns numeric language sql as $$
  select coalesce(sum(credit), 0) from public.journal_lines where journal_id = p_journal and account_id = pg_temp.acc(p_acc) $$;

do $$
declare v_t uuid; v_v uuid; v_r uuid; v_j uuid; v_journals int; v_ret jsonb;
begin
  perform pg_temp.eq((select count(*)::int from public.asset_categories), 4, 'categories seeded from the chart');
  perform pg_temp.expect_error(format('select public.asset_save(%L, null, %L)', pg_temp.p('staff'), '{}'), 'Fixed assets');
  perform pg_temp.expect_error(format('select public.asset_save(%L, null, %L)', pg_temp.p('finance'),
    jsonb_build_object('name', 'Welder', 'category_id', pg_temp.cat('Tools and equipment'), 'purchase_date', '2027-07-15', 'cost', 100, 'residual_value', 200)), 'residual');

  v_journals := (select count(*) from public.journal_entries);
  v_t := public.asset_save(pg_temp.p('finance'), null, jsonb_build_object('name', 'MIG welder', 'category_id', pg_temp.cat('Tools and equipment'),
    'purchase_date', '2027-07-15', 'cost', 6000, 'gst', 600, 'serial_number', 'W-1234', 'location', 'Workshop',
    'tax_method', 'diminishing_value', 'tax_effective_life_years', 10));
  v_v := public.asset_save(pg_temp.p('finance'), null, jsonb_build_object('name', 'Ute', 'category_id', pg_temp.cat('Vehicles'),
    'purchase_date', '2027-07-28', 'in_service_date', '2027-08-01', 'cost', 48000));
  perform pg_temp.eq((select string_agg(number || ':' || method || ':' || useful_life_months, ',' order by number) from public.assets),
    'FA-0001:straight_line:60,FA-0002:diminishing_value:96', 'numbers and category defaults');
  perform pg_temp.eq((select count(*)::int from public.journal_entries), v_journals, 'registering an asset posts nothing (tax treatment is recorded only)');

  -- July: FA-1 from 15 July, 17 of 31 days of 100.00 = 54.84.
  perform pg_temp.expect_error(format('select public.asset_depreciation_run(%L, %L)', pg_temp.p('finance'), '2027-07-30'), 'last day of a month');
  v_r := public.asset_depreciation_run(pg_temp.p('finance'), '2027-07-31');
  perform pg_temp.eq((select total from public.asset_depreciation_runs where id = v_r), 54.84, 'July: part month');
  perform pg_temp.expect_error(format('select public.asset_depreciation_run(%L, %L)', pg_temp.p('finance'), '2027-09-30'), 'month by month');
  perform pg_temp.expect_error(format('select public.asset_depreciation_run(%L, %L)', pg_temp.p('finance'), '2027-07-31'), 'already been run');
  -- August: FA-1 100.00; FA-2 48,000 x 2/96 = 1,000.00. One journal by category.
  v_r := public.asset_depreciation_run(pg_temp.p('finance'), '2027-08-31');
  v_j := (select journal_id from public.asset_depreciation_runs where id = v_r);
  perform pg_temp.eq((pg_temp.dr(v_j, '7800'), pg_temp.cr(v_j, '1510'), pg_temp.cr(v_j, '1610'))::text, '(1100.00,100.00,1000.00)', 'August journal');
  -- September: FA-2 47,000 x 2/96 = 979.17.
  v_r := public.asset_depreciation_run(pg_temp.p('finance'), '2027-09-30');
  perform pg_temp.eq((select amount from public.asset_depreciation where run_id = v_r and asset_id = v_v), 979.17, 'diminishing value on book value');

  -- Only the latest run can be undone, and only through the register.
  perform pg_temp.expect_error(format('select public.asset_depreciation_undo(%L, %L, %L)', pg_temp.p('finance'),
    (select id from public.asset_depreciation_runs where period_end = '2027-08-31'), 'Wrong'), 'Only the latest');
  perform pg_temp.expect_error(format('select public.ledger_reverse_entry(%L, %L, null, %L)', pg_temp.p('finance'),
    (select journal_id from public.asset_depreciation_runs where id = v_r), 'Wrong rate'), 'Undo depreciation from Fixed assets');
  perform public.asset_depreciation_undo(pg_temp.p('finance'), v_r, 'Ute life was wrong');
  perform pg_temp.eq(public.asset_accumulated(v_v, '2027-09-30'), 1000.00, 'September undone');
  perform pg_temp.expect_error(format('select public.asset_save(%L, %L, %L)', pg_temp.p('finance'), v_v,
    jsonb_build_object('name', 'Ute', 'category_id', pg_temp.cat('Vehicles'), 'purchase_date', '2027-07-28', 'in_service_date', '2027-08-01', 'cost', 50000)), 'has been depreciated');
  perform public.asset_save(pg_temp.p('finance'), v_v, jsonb_build_object('name', 'Ute (white)', 'category_id', pg_temp.cat('Vehicles'), 'purchase_date', '2027-07-28',
    'in_service_date', '2027-08-01', 'cost', 48000, 'useful_life_months', 96, 'location', 'Yard'));
  perform public.asset_depreciation_run(pg_temp.p('finance'), '2027-09-30');

  -- Sold on 10 October for 5,000 plus GST: 10 of 31 days of October (32.26) first.
  -- Accumulated 54.84 + 100 + 100 + 32.26 = 287.10; book value 5,712.90; loss 712.90.
  perform pg_temp.expect_error(format('select public.asset_dispose(%L, %L, %L, 5000, %L, %L, %L)', pg_temp.p('finance'), v_t, '2027-09-15',
    (select id from public.tax_codes where code = 'GST'), pg_temp.acc('1000'), 'Sold'), 'already been run past');
  v_j := public.asset_dispose(pg_temp.p('finance'), v_t, '2027-10-10', 5000, (select id from public.tax_codes where code = 'GST'), pg_temp.acc('1000'), 'Sold to Smith Fabrication');
  perform pg_temp.eq((pg_temp.dr(v_j, '1510') - pg_temp.cr(v_j, '1510'), pg_temp.cr(v_j, '1500'), pg_temp.dr(v_j, '7810'), pg_temp.dr(v_j, '1000'), pg_temp.cr(v_j, '4950'), pg_temp.cr(v_j, '2300'))::text,
    '(254.84,6000.00,5712.90,5500.00,5000.00,500.00)', 'disposal journal');
  perform pg_temp.eq((select (status, disposal_gst)::text from public.assets where id = v_t), '(disposed,500.00)', 'disposed');
  perform pg_temp.eq((select tax_code_id is not null from public.journal_lines where journal_id = v_j and account_id = pg_temp.acc('7810')), true, 'book value coded NG for the BAS');
  perform pg_temp.expect_error(format('select public.asset_dispose(%L, %L, %L, 0, null, null, %L)', pg_temp.p('finance'), v_t, '2027-10-11', 'Again'), 'already been disposed');
  perform pg_temp.expect_error(format('select public.ledger_reverse_entry(%L, %L, null, %L)', pg_temp.p('finance'), v_j, 'Oops wrong'), 'Disposal journals');

  -- Register against the ledger: vehicles accumulated 1,000.00 + 979.17.
  v_ret := (select x from jsonb_array_elements(public.asset_reconciliation('00000000-0000-4000-8000-000000000001', '2027-09-30')) x where x->>'category' = 'Vehicles');
  perform pg_temp.eq((v_ret->>'registerCost', v_ret->>'registerAccumulated', v_ret->>'ledgerAccumulated')::text, '(48000.00,1979.17,1979.17)', 'vehicles reconcile (accumulated)');
end $$;

select 'assets tests passed' as result;
rollback;
