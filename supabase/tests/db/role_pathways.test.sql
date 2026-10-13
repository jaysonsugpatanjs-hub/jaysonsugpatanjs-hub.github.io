-- Role pathway reference data and the position-to-process map.
do $$
declare
  v_admin uuid := gen_random_uuid();
  v_pos uuid;
begin
  if (select count(*) from public.ims_processes) <> 93 then raise exception 'Expected 93 processes'; end if;
  if not exists (select 1 from public.ims_processes where code = 'P001' and array_length(read_docs, 1) > 0) then raise exception 'P001 should list documents'; end if;
  insert into auth.users (id, email) values (v_admin, 'pathway-admin@pathway.test');
  update public.training_profiles set role = 'admin', active = true where id = v_admin;
  insert into public.positions (code, title) values ('PATH-TEST', 'Pathway test position') returning id into v_pos;
  perform public.admin_set_position_processes(v_admin, v_pos, array['P001', 'P002', 'P001']);
  if (select count(*) from public.position_processes where position_id = v_pos) <> 2 then raise exception 'Expected 2 mapped processes'; end if;
  perform public.admin_set_position_processes(v_admin, v_pos, array['P002']);
  if (select count(*) from public.position_processes where position_id = v_pos) <> 1 then raise exception 'Removal failed'; end if;
  begin
    perform public.admin_set_position_processes(v_admin, v_pos, array['P999']);
    raise exception 'Unknown process was accepted';
  exception when sqlstate '22023' then null; end;
end $$;
