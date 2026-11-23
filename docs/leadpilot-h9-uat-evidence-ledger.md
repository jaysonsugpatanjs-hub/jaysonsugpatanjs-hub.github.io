# LeadPilot H9 — live UAT evidence ledger

**Created:** 2026-11-24  
**Status:** NOT RUN — no live n8n/HubSpot execution evidence supplied or independently confirmed.

This ledger complements [leadpilot-h9-acceptance.md](leadpilot-h9-acceptance.md). Never mark PASS based only on HTTP 2xx, a green n8n node, or a CI build.

## Before testing

- [ ] Run `npm ci`, `node --test tests/leadpilot-h8-delivery.test.mjs`, and `npm run build` against the current PR head; record SHA and run URL.
- [ ] Use a controlled staging site, fictional lead and test-only company domain. Prevent external outreach.
- [ ] Confirm H7 accepts URL-encoded POST and captures `leadpilot_submission_id`, `portfolio_inquiry_id`, consent flag/version/timestamp.
- [ ] Confirm H7 → H9 authentication is server-side only. Never expose `x-leadpilot-key` in frontend bundles, logs or screenshots.
- [ ] Confirm how H9 persists an idempotency key and avoids concurrent duplicate creation; email/domain searches alone are insufficient for race-free deduplication.

## Execution evidence (one row per attempt)

| Test ID | UTC timestamp | Submission ID | Primary CRM ID | H7 execution ID | H9 execution ID | HTTP status | HubSpot company ID | Contact ID | Deal ID | Task ID | Actual outcome | PASS/FAIL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| H9-001 new HOT | — | — | — | — | — | — | — | — | — | — | NOT RUN | — |
| H9-002 same payload retry | — | — | — | — | — | — | — | — | — | — | NOT RUN | — |
| H9-003 third retry | — | — | — | — | — | — | — | — | — | — | NOT RUN | — |
| H9-004 H8 website | — | — | — | — | — | — | — | — | — | — | NOT RUN | — |
| H9-005 four priorities | — | — | — | — | — | — | — | — | — | — | NOT RUN | — |
| H9-006 invalid payload | — | — | — | — | — | — | — | — | — | — | NOT RUN | — |
| H9-007 invalid internal key | — | — | — | — | — | — | — | — | — | — | NOT RUN | — |
| H9-008 secondary failure | — | — | — | — | — | — | — | — | — | — | NOT RUN | — |

## Additional concurrency test (H9-009)

Submit **two simultaneous requests with the same submission ID** to the H9 staging receiver. Expected: at most one logical delivery and one set of HubSpot records; duplicate request should return/retrieve the existing result or safely wait. If both create records, the workflow is not concurrency-safe. Do not enable automatic retries until fixed.

## Incident/debugging record

- Test ID:
- Failed stage (H8 / primary CRM / H7 / H9 / HubSpot):
- Expected versus actual:
- HTTP status and redacted response:
- n8n execution URL/ID:
- HubSpot object IDs:
- Root cause:
- Code/configuration change:
- Retest evidence:
- Reviewer/date:

## Release decision

H9 remains **BLOCKED** until all H9-001 through H9-008 scenarios pass with traceable evidence, H9-009 concurrency is assessed, security review is complete, and the current PR-head CI/build is successful. Do not merge this draft PR solely because the tests are green.
