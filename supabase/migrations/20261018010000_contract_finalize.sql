-- Finalizing a signed contract.
--
-- HR no longer just "accepts" a signed contract: they say where the signature
-- goes on the contract's pages and, if wanted, counter-sign for Panalo (the
-- HR representative or the Managing Director). The choices are kept on the item
-- so the signed copy can always be rebuilt exactly as HR finalized it, even if
-- filing is retried later.
--
-- onboarding_finalize_contract accepts the signature (through the existing
-- onboarding_review, so every rule there still applies), stores the choices and
-- audits who finalized and who counter-signed, in one transaction.
begin;

alter table public.onboarding_items add column if not exists finalize jsonb;
comment on column public.onboarding_items.finalize is
  'How HR finalized a signed contract: { placement, company }. company is the counter-signature for Panalo, if any. Service role only.';

create or replace function public.onboarding_finalize_contract(p_actor uuid, p_item uuid, p_placement jsonb, p_company jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_result jsonb;
  v_company jsonb := nullif(p_company, 'null'::jsonb);
begin
  perform public.app_require(p_actor, 'hr.manage');
  select i.*, r.profile_id, d.kind into v_item
  from public.onboarding_items i
  join public.onboarding_requests r on r.id = i.request_id
  join public.hr_document_types d on d.key = i.doc_type
  where i.id = p_item for update of i;
  if not found then
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;
  if v_item.kind <> 'sign' then
    raise exception 'This item is not signed online.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_placement) is distinct from 'object'
     or jsonb_typeof(p_placement -> 'signature') is distinct from 'object'
     or not (p_placement ->> 'page' ~ '^([1-9][0-9]{0,3}|last)$') then
    raise exception 'Choose where the signature goes on the contract.' using errcode = '22023';
  end if;
  if v_company is not null then
    if jsonb_typeof(v_company) <> 'object'
       or length(btrim(coalesce(v_company ->> 'name', ''))) not between 2 and 80
       or length(coalesce(v_company ->> 'position', '')) > 60
       or coalesce(v_company ->> 'method', '') not in ('typed', 'drawn')
       or jsonb_typeof(v_company -> 'signature') is distinct from 'object' then
      raise exception 'The counter-signature is incomplete.' using errcode = '22023';
    end if;
    if v_company ->> 'method' = 'drawn'
       and coalesce(v_company ->> 'imagePath', '') !~ ('^' || v_item.request_id::text || '/' || p_item::text || '/company-signature-[A-Za-z0-9._-]{1,120}$') then
      raise exception 'The handwritten counter-signature is missing.' using errcode = '22023';
    end if;
  end if;

  -- Accepting applies every existing rule (open request, signed, not your own document).
  v_result := public.onboarding_review(p_actor, p_item, true, null);
  update public.onboarding_items
  set finalize = jsonb_strip_nulls(jsonb_build_object('placement', p_placement, 'company', v_company, 'by', p_actor))
  where id = p_item;
  perform public.ims_audit(p_actor, 'onboarding_contract_finalized',
    jsonb_build_object('requestId', v_item.request_id, 'itemId', p_item, 'docType', v_item.doc_type,
      'page', p_placement -> 'page', 'counterSigned', v_company is not null,
      'companySignatory', v_company ->> 'name', 'companyPosition', v_company ->> 'position', 'companyMethod', v_company ->> 'method'),
    v_item.profile_id);
  return v_result;
end;
$$;

revoke execute on function public.onboarding_finalize_contract(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.onboarding_finalize_contract(uuid, uuid, jsonb, jsonb) to service_role;

commit;
