import test from "node:test";
import assert from "node:assert/strict";
import { addMonths, competencyStatus, licenceStatus, sydneyDate } from "../../supabase/functions/_shared/competency.ts";

const today = "2026-10-01";
const req = { required: true, released: true, practicalRequired: true, refresherMonths: 24 };
const passed = (theory: string, practicals: Array<{ outcome: "competent" | "not_yet_competent"; assessedOn: string }> = []) => ({
  status: "theory_passed" as const, theoryPassedAt: theory, expiresAt: "2026-12-31T12:59:59Z", practicals
});

test("not required and unreleased modules are reported as such", () => {
  assert.equal(competencyStatus({ ...req, required: false }, [], today).status, "not_required");
  assert.equal(competencyStatus({ ...req, released: false }, [], today).status, "awaiting_release");
  assert.equal(competencyStatus(req, [], today).status, "gap");
});

test("theory alone is practical pending when a practical is required", () => {
  const result = competencyStatus(req, [passed("2026-09-30T05:00:00Z")], today);
  assert.equal(result.status, "practical_pending");
  assert.equal(competencyStatus({ ...req, practicalRequired: false }, [passed("2026-09-30T05:00:00Z")], today).status, "competent");
});

test("competence runs from the practical date plus the refresher interval", () => {
  const result = competencyStatus(req, [passed("2025-03-01T00:00:00Z", [{ outcome: "competent", assessedOn: "2025-03-10" }])], today);
  assert.equal(result.status, "competent");
  assert.equal(result.competentFrom, "2025-03-10");
  assert.equal(result.competentUntil, "2027-03-10");
});

test("a practical recorded before the theory pass does not count", () => {
  const result = competencyStatus(req, [passed("2026-05-01T00:00:00Z", [{ outcome: "competent", assessedOn: "2026-04-01" }])], today);
  assert.equal(result.status, "practical_pending");
});

test("not-yet-competent practicals do not count", () => {
  const result = competencyStatus(req, [passed("2026-05-01T00:00:00Z", [{ outcome: "not_yet_competent", assessedOn: "2026-05-02" }])], today);
  assert.equal(result.status, "practical_pending");
});

test("expiring within 30 days, then expired, then refresher assigned", () => {
  const nearlyDue = passed("2024-10-01T00:00:00Z", [{ outcome: "competent", assessedOn: "2024-10-20" }]);
  assert.equal(competencyStatus(req, [nearlyDue], today).status, "expiring");
  const lapsed = passed("2024-08-01T00:00:00Z", [{ outcome: "competent", assessedOn: "2024-09-18" }]);
  assert.equal(competencyStatus(req, [lapsed], today).status, "expired");
  const refresher = { status: "assigned" as const, theoryPassedAt: null, expiresAt: "2026-10-31T12:59:59Z", practicals: [] };
  const result = competencyStatus(req, [lapsed, refresher], today);
  assert.equal(result.status, "assigned");
  assert.equal(result.dueBy, "2026-10-31");
});

test("expired or revoked assignments do not count as open", () => {
  const stale = { status: "assigned" as const, theoryPassedAt: null, expiresAt: "2026-09-01T00:00:00Z", practicals: [] };
  const revoked = { status: "revoked" as const, theoryPassedAt: null, expiresAt: "2026-12-01T00:00:00Z", practicals: [] };
  assert.equal(competencyStatus(req, [stale, revoked], today).status, "gap");
});

test("no refresher interval means competence does not lapse", () => {
  const result = competencyStatus({ ...req, refresherMonths: null }, [passed("2019-01-01T00:00:00Z", [{ outcome: "competent", assessedOn: "2019-01-05" }])], today);
  assert.equal(result.status, "competent");
  assert.equal(result.competentUntil, null);
});

test("dates use the Sydney calendar and month arithmetic clamps", () => {
  assert.equal(sydneyDate("2026-09-30T15:00:00Z"), "2026-10-01");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2024-02-29", 12), "2025-02-28");
});

test("licence expiry bands", () => {
  assert.equal(licenceStatus(null, today), "no_expiry");
  assert.equal(licenceStatus("2026-09-30", today), "expired");
  assert.equal(licenceStatus("2026-10-22", today), "expiring");
  assert.equal(licenceStatus("2027-03-14", today), "current");
});
