# LeadPilot H9 — website → n8n → HubSpot acceptance runbook

**Prepared:** 27 October 2026  
**State:** Code proposed in a draft PR; **not deployed**. Live H9 UAT **not passed**.

## What changed

- H8 saves to the private portfolio CRM **first**.
- After that succeeds, H8 **awaits one attempt** to send the same lead to the n8n webhook.
- The sender checks the HTTP response, handles network/CORS errors, and times out after 10 seconds.
- A failure of the *secondary* destination does **not** erase or misrepresent the primary save. The visitor is explicitly told the handoff could not be confirmed and not to resubmit.
- Secondary payload now includes `leadpilot_submission_id`, `portfolio_inquiry_id`, `contact_consent`, `consent_version`, and `consent_timestamp`.
- There is **no browser retry**: retries require server-side idempotency and durable storage.
- **Important:** A 2xx from the n8n webhook means the HTTP request was accepted, **not** that HubSpot finished creating or updating records.

## Learning lab — build and test

1. Review `src/LeadPilotH8.jsx`: find the primary `fetch(PORTFOLIO_CRM_INQUIRY_URL)`, then the `submitLeadPilotMirror` call. Explain why primary and secondary writes are distinct.
2. Review `src/leadpilot-h8-delivery.js`: identify `response.ok`, `AbortController`, the `finally` cleanup, and why there is no retry.
3. Run `node --test tests/leadpilot-h8-delivery.test.mjs` (four mocked scenarios: 200, 503, network/CORS, timeout).
4. Run `npm ci` then `npm run build` on the feature branch; inspect the compiled bundle to ensure no private `x-leadpilot-key` or HubSpot token is embedded.
5. Test in a non-production environment or controlled test window. Inspect browser DevTools → Network: first the private CRM `/api/inquiry` response, then `/webhook/leadpilot-inbound`. A private CRM 2xx with an n8n failure should display a partial-success message, **not** encourage repeat submissions.

## H7 receiver checklist

- Confirm the production webhook is active, accepts `POST` and `application/x-www-form-urlencoded`, and parses the payload into consistent fields.
- Record `leadpilot_submission_id`, `portfolio_inquiry_id`, `contact_consent`, `consent_version`, `consent_timestamp`.
- Validate required fields, consent and rate limits; do not trust public browser data for authorization.
- Do **not** put `x-leadpilot-key` in browser code. Use it only in n8n/server-to-server calls to H9.
- Return a correlation/receipt ID; store delivery status and eventual HubSpot IDs in a durable server-side record.
- Acknowledge only what has actually happened. If H7 is asynchronous, `202 Accepted` is more descriptive than claiming full CRM completion.

## H9 receiver checklist

- Normalize company domains (remove protocol, `www.`, path, trailing slash) and email case before searches.
- Search for existing company/contact/deal/task before creating. Reuse the IDs on retries.
- Persist an idempotency key (prefer `leadpilot_submission_id` plus source); do not rely solely on domain or email to deduplicate *distinct* enquiries.
- Verify `HOT`, `WARM`, `DEVELOP`, `LOW` routing; no deal/task for the latter two unless business rules explicitly require it.
- Record n8n execution ID, received payload, final HubSpot IDs, and error outcome for each run.
- Confirm consent before any outreach; **no automated outreach** as part of this milestone.

## Live UAT evidence table (fill from actual execution logs)

| ID | Scenario | Expected | Actual | Evidence | Status |
|---|---|---|---|---|---|
| H9-001 | New synthetic HOT lead | One company/contact/deal/open task | — | n8n execution + HubSpot IDs | NOT RUN |
| H9-002 | Repeat identical payload | Same four IDs reused | — | IDs before/after | NOT RUN |
| H9-003 | Third identical payload | Zero duplicates | — | CRM search counts | NOT RUN |
| H9-004 | Submit via H8 website | Private CRM saved, H7 received, H9 processed | — | Primary ID, webhook execution, HubSpot IDs | NOT RUN |
| H9-005 | HOT/WARM/DEVELOP/LOW | Correct deal/task behavior | — | Four test executions | NOT RUN |
| H9-006 | Invalid/missing required field | Reject/hold without CRM write | — | Error execution | NOT RUN |
| H9-007 | Invalid server-to-server key | Reject without CRM write | — | H9 receiver execution | NOT RUN |
| H9-008 | Simulated secondary 503/timeout | Primary save preserved, uncertainty visible | — | Browser test | NOT RUN |

**Use fictional data and a unique test domain.** Avoid emailing real contacts or creating real sales tasks from test submissions. Mark PASS only after verifying the receiving workflow and actual CRM state, not merely a green HTTP node.

## Debugging decision tree

- **Private CRM fails:** inspect `/api/inquiry`, validation, backend availability and 20s timeout.
- **Primary succeeds, n8n request absent:** inspect the browser Network tab, `LEADPILOT_INBOUND_URL`, and JavaScript errors.
- **n8n request sent, browser reports CORS/network:** inspect CORS preflight/response and webhook logs. A browser error may occur even when a request reached n8n; check server-side evidence before retrying.
- **H7 executes, H9 does not:** inspect URL-encoded body parsing, field names, internal auth and H9 receiver availability.
- **H9 executes, CRM is empty:** inspect HubSpot credentials, API response codes, mappings and conditional routing.
- **Duplicates appear:** inspect canonical keys, search results, race conditions, task/deal reuse and idempotency-key persistence.
- **Output includes `=HOT` or `=91`:** remove an *extra literal* equals sign from n8n field values; `={{...}}` in workflow export syntax can be legitimate.

## Release gate

Do **not** merge/deploy until code review, `npm run build`, and controlled live UAT have passed. This frontend change improves visibility but is **not** a durable delivery queue. The subsequent phase is a server-side outbox with bounded retries and idempotency, followed by structured AI qualification with a manual-review gate.
