import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../supabase/migrations/20260929000000_training_service_role_permissions.sql", import.meta.url);
const migration = await readFile(migrationUrl, "utf8");

test("server role receives only the training-table operations used by Edge Functions", () => {
  for (const table of [
    "training_profiles",
    "training_modules",
    "training_module_versions",
    "training_assignments",
    "training_slide_attempts",
    "training_assessment_attempts",
    "training_certificates",
    "training_audit_events"
  ]) {
    assert.match(migration, new RegExp(`public\\.${table}\\b`));
  }

  assert.match(migration, /to service_role\s*;/i);
  assert.match(migration, /training_slide_attempts_id_seq/i);
  assert.match(migration, /training_audit_events_id_seq/i);
  assert.doesNotMatch(migration, /\bto\s+(anon|authenticated)\b/i);
  assert.doesNotMatch(migration, /\bgrant\s+all\b/i);
});
