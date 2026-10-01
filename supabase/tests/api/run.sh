#!/usr/bin/env bash
# Runs the Edge Function handlers against PostgREST over a fully migrated
# database. Needs: psql/createdb (PG* env or local socket), a postgrest binary
# (POSTGREST_BIN) and deno. Usage: supabase/tests/api/run.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
db="panalo_api_$$"
port="${POSTGREST_PORT:-3999}"
postgrest="${POSTGREST_BIN:-postgrest}"

createdb "$db"
pgrest_pid=""
cleanup() {
  [ -n "$pgrest_pid" ] && kill "$pgrest_pid" 2>/dev/null || true
  sleep 1
  dropdb --if-exists "$db" >/dev/null 2>&1 || true
}
trap cleanup EXIT

run() { psql -X -q -v ON_ERROR_STOP=1 -d "$db" "$@"; }
run -f "$root/supabase/tests/db/supabase-stubs.sql"
for migration in "$root"/supabase/migrations/*.sql; do run -f "$migration"; done
# The database tests double as fixtures: people, folders, documents, modules.
for fixture in "$root"/supabase/tests/db/*.test.sql; do run -f "$fixture" >/dev/null; done
run -c "grant usage on schema public to service_role;"

host="${PGHOST:-/var/run/postgresql}"
user="${PGUSER:-$(whoami)}"
if [[ "$host" == /* ]]; then
  uri="postgres://${user}@/${db}?host=${host}"
else
  uri="postgres://${user}:${PGPASSWORD:-}@${host}:${PGPORT:-5432}/${db}"
fi
cat > "/tmp/postgrest-$$.conf" <<CONF
db-uri = "$uri"
db-schemas = "public"
db-anon-role = "service_role"
server-port = $port
CONF
"$postgrest" "/tmp/postgrest-$$.conf" > "/tmp/postgrest-$$.log" 2>&1 &
pgrest_pid=$!
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$port/" >/dev/null 2>&1 && break
  sleep 0.5
done

POSTGREST_URL="http://127.0.0.1:$port" deno test --config "$here/deno.json" --allow-env --allow-net --allow-read --no-check "$here/api.test.ts"
