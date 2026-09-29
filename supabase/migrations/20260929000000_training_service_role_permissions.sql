begin;

-- Edge Functions use the server-only service role. Keep browser roles revoked,
-- but grant the minimum table operations required by training-api/admin-api.
grant select, insert, update on table
  public.training_profiles,
  public.training_modules,
  public.training_module_versions,
  public.training_assignments
to service_role;

grant select, insert on table
  public.training_slide_attempts,
  public.training_assessment_attempts,
  public.training_certificates
to service_role;

grant insert on table
  public.training_audit_events
to service_role;

grant usage, select on sequence
  public.training_slide_attempts_id_seq,
  public.training_audit_events_id_seq
to service_role;

commit;
