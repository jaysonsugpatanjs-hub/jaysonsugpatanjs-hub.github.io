-- Optional one-off: builds the Panalo Asset File folder structure.
-- Run in the Supabase SQL editor AFTER the 20261001 migration, replacing the
-- administrator email. Every folder is created through ims_create_folder, so
-- each one is audited and owned through the root's grants.
--
-- TODO before running: folders 01, 02 and 10 have names that were cut off in
-- the Drive screenshot. Replace the three placeholders below with the full
-- names, and confirm the subfolders of 08. LABOUR HIRE & HR.

do $$
declare
  v_admin uuid := (select id from public.training_profiles where email = lower('ADMIN_EMAIL_HERE') and role = 'admin');
  v_root uuid;
  v_quality uuid;
  v_hr uuid;
  v_iso uuid;
  v_name text;
  v_sub text;
begin
  if v_admin is null then
    raise exception 'Set ADMIN_EMAIL_HERE to an active administrator email.';
  end if;

  v_root := coalesce(
    (select id from public.ims_folders where parent_id is null),
    public.ims_create_folder(v_admin, null, 'Panalo Asset File', ''));
  perform public.ims_set_grant(v_admin, v_root, 'document_controllers', null, 'owner');
  perform public.ims_set_grant(v_admin, v_root, 'all_employees', null, 'viewer');

  foreach v_name in array array[
    '01. MANAGEMENT & [FULL NAME]', '02. BUSINESS DEVELOPMENT [FULL NAME]', '03. TENDERS & PROPOSALS',
    '04. CLIENTS & PROJECTS', '05. OPERATIONS', '06. QUALITY – ISO – CC3', '07. HSEQ', '08. LABOUR HIRE & HR',
    '09. FINANCE & COMMERCIAL', '10. SUPPLIERS & [FULL NAME]', '11. PHOTOS & MEDIA', '99. ARCHIVE']
  loop
    perform public.ims_create_folder(v_admin, v_root, v_name, v_name);
  end loop;

  v_quality := (select id from public.ims_folders where parent_id = v_root and name = '06. QUALITY – ISO – CC3');
  foreach v_name in array array['ISO 9001', 'ISO 45001', 'ISO 14001'] loop
    v_iso := public.ims_create_folder(v_admin, v_quality, v_name, v_name);
    foreach v_sub in array array['00_CONTROL', '01_CONTEXT', '02_PLANNING', '03_PEOPLE', '04_QMS_OPS', '05_WELD_CC3',
                                 '06_ENV', '07_WHS', '08_PROJECTS', '09_AUDIT', '10_IMPROVE', '11_EXTERNAL'] loop
      perform public.ims_create_folder(v_admin, v_iso, v_sub, v_sub);
    end loop;
  end loop;

  -- Labour hire & HR: its own access list, owned by HR. Training modules sit
  -- under it; personnel records are HR only.
  v_hr := (select id from public.ims_folders where parent_id = v_root and name = '08. LABOUR HIRE & HR');
  perform public.ims_create_folder(v_admin, v_hr, 'Training modules', '1');
  perform public.ims_create_folder(v_admin, v_hr, 'Personnel records', '2');
  perform public.ims_set_grant(v_admin, v_hr, 'hr_admins', null, 'owner');
  perform public.ims_set_inherit(v_admin, v_hr, false);

  -- Commercially sensitive folders keep their own access lists too. Remove the
  -- copied "All employees" entries from these in the app afterwards.
  foreach v_name in array array['01. MANAGEMENT & [FULL NAME]', '02. BUSINESS DEVELOPMENT [FULL NAME]', '03. TENDERS & PROPOSALS', '09. FINANCE & COMMERCIAL'] loop
    perform public.ims_set_inherit(v_admin, (select id from public.ims_folders where parent_id = v_root and name = v_name), false);
  end loop;
end $$;
