#!/usr/bin/env bash
# Applies every migration to a throwaway Postgres database and runs the SQL
# test files. Needs psql and a reachable server (PGHOST/PGUSER etc. or local
# socket). Usage: supabase/tests/db/run.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
db="panalo_test_$$"

createdb "$db"
cleanup() { dropdb --if-exists "$db" >/dev/null 2>&1 || true; }
trap cleanup EXIT

run() { psql -X -q -v ON_ERROR_STOP=1 -d "$db" "$@"; }

run -f "$here/supabase-stubs.sql"
for migration in "$root"/supabase/migrations/*.sql; do
  echo "migrate  $(basename "$migration")"
  run -f "$migration"
done
for test_file in "$here"/*.test.sql; do
  echo "test     $(basename "$test_file")"
  run -f "$test_file"
done
echo "Database tests passed."
