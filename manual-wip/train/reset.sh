#!/usr/bin/env bash
# reset.sh save  -> snapshot panalo_train to panalo_train_base
# reset.sh       -> restore panalo_train from the snapshot, restart services
pkill -x postgrest || true; pkill -x deno || true; sleep 1
if [ "${1:-}" = save ]; then
  su postgres -c "dropdb --if-exists panalo_train_base; createdb -T panalo_train panalo_train_base"
else
  su postgres -c "dropdb --if-exists panalo_train; createdb -T panalo_train_base panalo_train"
fi
su postgres -c 'nohup postgrest /tmp/pgrst-train.conf > /tmp/pgrst-train.log 2>&1 &'
sleep 2
cd /tmp && (POSTGREST_URL=http://127.0.0.1:3998 NO_COLOR=1 nohup deno run --no-check --config /tmp/repo/supabase/tests/api/deno.json --allow-all /tmp/ui-api.ts > /tmp/ui-api.log 2>&1 < /dev/null &)
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8787/ -X OPTIONS && break; sleep 1; done
curl -sf -o /dev/null http://localhost:8000/accounts/ || (cd /tmp/repo && (nohup python3 -m http.server 8000 > /tmp/static.log 2>&1 < /dev/null & echo $! > /tmp/static.pid))
echo reset-ok
