#!/usr/bin/env bash
# env.sh N up    -> private copy of the training DB: PostgREST on 3990+N, finance-api on 8780+N
# env.sh N reset -> back to the training snapshot (keeps the ports)
# env.sh N down
N=$1; ACT=${2:-up}; DB=panalo_env_$N; RP=$((3990+N)); AP=$((8780+N))
pkill -f "pgrst-env$N.conf" 2>/dev/null; pkill -f "ui-api-$N.ts" 2>/dev/null; sleep 1
[ "$ACT" = down ] && { su postgres -c "dropdb --if-exists $DB"; echo down; exit 0; }
su postgres -c "dropdb --if-exists $DB >/dev/null 2>&1; createdb -T panalo_train_base $DB"
cat > /tmp/pgrst-env$N.conf <<CONF
db-uri = "postgres://postgres@/$DB?host=/var/run/postgresql"
db-schemas = "public"
db-anon-role = "service_role"
server-port = $RP
CONF
sed "s/port: 8787/port: $AP/" /tmp/ui-api.ts > /tmp/ui-api-$N.ts
su postgres -c "nohup postgrest /tmp/pgrst-env$N.conf > /tmp/pgrst-env$N.log 2>&1 &"
sleep 2
cd /tmp && (POSTGREST_URL=http://127.0.0.1:$RP NO_COLOR=1 nohup deno run --no-check --config /tmp/repo/supabase/tests/api/deno.json --allow-all /tmp/ui-api-$N.ts > /tmp/ui-api-$N.log 2>&1 < /dev/null &)
for i in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:$AP/ -X OPTIONS && break; sleep 1; done
curl -sf -o /dev/null http://localhost:8000/accounts/ || (cd /tmp/repo && (nohup python3 -m http.server 8000 > /tmp/static.log 2>&1 < /dev/null &))
echo "env $N ready: PANALO_REST=http://127.0.0.1:$RP PANALO_API=http://127.0.0.1:$AP"
