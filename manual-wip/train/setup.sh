#!/usr/bin/env bash
# Training DB panalo_train + PostgREST :3998 + finance-api :8787 + static :8000 (serves /tmp/repo).
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd)
cd /home/claude/jaysonsugpatanjs-hub.github.io && rm -rf /tmp/repo && cp -r . /tmp/repo && chmod -R a+rwX /tmp/repo
cp $T/foundation.sql /tmp/foundation.sql; chmod a+r /tmp/foundation.sql
pkill -x postgrest || true; pkill -x deno || true; [ -f /tmp/static.pid ] && kill $(cat /tmp/static.pid) 2>/dev/null || true; sleep 1
su postgres -c '
set -e
db=panalo_train
dropdb --if-exists $db >/dev/null 2>&1 || true
createdb $db
run() { psql -X -q -v ON_ERROR_STOP=1 -d $db "$@"; }
run -f /tmp/repo/supabase/tests/db/supabase-stubs.sql
for m in /tmp/repo/supabase/migrations/*.sql; do run -f "$m"; done
run -c "grant usage on schema public to service_role;"
run -f /tmp/foundation.sql
cat > /tmp/pgrst-train.conf <<CONF
db-uri = "postgres://postgres@/$db?host=/var/run/postgresql"
db-schemas = "public"
db-anon-role = "service_role"
server-port = 3998
CONF
' > /tmp/train-setup.log 2>&1 || { echo "setup failed"; tail -5 /tmp/train-setup.log; exit 1; }
su postgres -c 'nohup postgrest /tmp/pgrst-train.conf > /tmp/pgrst-train.log 2>&1 &'
sleep 2
cd /tmp && (POSTGREST_URL=http://127.0.0.1:3998 NO_COLOR=1 nohup deno run --no-check --config /tmp/repo/supabase/tests/api/deno.json --allow-all /tmp/ui-api.ts > /tmp/ui-api.log 2>&1 < /dev/null &)
cd /tmp/repo && (nohup python3 -m http.server 8000 > /tmp/static.log 2>&1 < /dev/null & echo $! > /tmp/static.pid)
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8787/ -X OPTIONS && break; sleep 1; done
echo ready
