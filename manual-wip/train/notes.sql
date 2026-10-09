update public.notifications set read_at = now();
update public.notifications set read_at = null where id in (
  select distinct on (profile_id, title) id from public.notifications
  where title like 'Approval needed: Bank details for Casey%' or title like 'Approval needed: Bank details for supplier Demo NDT%'
     or title like 'Payment batch to approve%' or title like 'Pay run to approve: PR-00004%' or title like 'Timesheet to approve: Casey%'
     or title like 'Leave%' or title like 'Purchase order%' or title like 'Bill%'
  order by profile_id, title, created_at desc);
