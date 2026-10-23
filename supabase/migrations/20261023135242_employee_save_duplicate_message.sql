-- Explain which person already holds an employee number instead of the
-- generic "That record already exists." (admin-api maps 23505 to that text,
-- so this raises 22023, which it passes through as a 409 with this message).
create or replace function public.employee_save(p_actor uuid, p_employee jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_id uuid := nullif(p_employee ->> 'id', '')::uuid;
  v_before jsonb;
  v_holder text;
begin
  perform public.app_require(p_actor, 'people.manage');
  select e.full_name into v_holder from public.employees e
  where e.employee_number = p_employee ->> 'employeeNumber' and e.id is distinct from v_id
  limit 1;
  if v_holder is not null then
    raise exception 'Employee number % is already used by %.', p_employee ->> 'employeeNumber', v_holder using errcode = '22023';
  end if;
  if v_id is not null then
    select to_jsonb(e) into v_before from public.employees e where id = v_id for update;
    if v_before is null then
      raise exception 'Employee not found.' using errcode = 'P0002';
    end if;
    update public.employees set
      employee_number = p_employee ->> 'employeeNumber',
      full_name = btrim(p_employee ->> 'fullName'),
      email = nullif(lower(btrim(coalesce(p_employee ->> 'email', ''))), ''),
      employment_type = coalesce(p_employee ->> 'employmentType', 'employee'),
      status = coalesce(p_employee ->> 'status', 'active'),
      position_id = nullif(p_employee ->> 'positionId', '')::uuid,
      site_id = nullif(p_employee ->> 'siteId', '')::uuid,
      supervisor_id = nullif(p_employee ->> 'supervisorId', '')::uuid,
      start_date = nullif(p_employee ->> 'startDate', '')::date,
      end_date = nullif(p_employee ->> 'endDate', '')::date
    where id = v_id;
  else
    insert into public.employees (employee_number, full_name, email, employment_type, status, position_id, site_id, supervisor_id, start_date, end_date)
    values (
      p_employee ->> 'employeeNumber', btrim(p_employee ->> 'fullName'),
      nullif(lower(btrim(coalesce(p_employee ->> 'email', ''))), ''),
      coalesce(p_employee ->> 'employmentType', 'employee'), coalesce(p_employee ->> 'status', 'active'),
      nullif(p_employee ->> 'positionId', '')::uuid, nullif(p_employee ->> 'siteId', '')::uuid,
      nullif(p_employee ->> 'supervisorId', '')::uuid,
      nullif(p_employee ->> 'startDate', '')::date, nullif(p_employee ->> 'endDate', '')::date)
    returning id into v_id;
    update public.employees e set profile_id = p.id
    from public.training_profiles p
    where e.id = v_id and e.email is not null and p.email = e.email
      and not exists (select 1 from public.employees x where x.profile_id = p.id);
  end if;
  perform public.ims_audit(p_actor, case when v_before is null then 'employee_created' else 'employee_updated' end,
    jsonb_build_object('employeeId', v_id, 'employeeNumber', p_employee ->> 'employeeNumber',
      'changed', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_employee) k
                  where v_before is not null and k <> 'id')));
  return v_id;
end;
$function$;

revoke all on function public.employee_save(uuid, jsonb) from public, anon, authenticated;
